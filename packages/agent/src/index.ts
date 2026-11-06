// The host agent: owns the simulators on this Mac, keeps a warm pool, and serves only leased devices.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { hostname, totalmem, cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { promisify } from 'node:util';
import {
  PROTOCOL_VERSION,
  type Action,
  type ActionResult,
  type AgentDevice,
  type AgentMessage,
  type BrokerMessage,
  type ElementSelector,
  type Frame,
  type Op,
  type UiNode,
} from '@hangar/protocol';
import * as sim from '@hangar/driver-ios-simulator';

const run = promisify(execFile);

export type AgentOptions = {
  send: (m: AgentMessage) => void;
  log?: (line: string) => void;
  // Most devices this Mac runs at once. Defaults to what its memory allows.
  maxDevices?: number;
  // Booted devices kept ready and unleased.
  warm?: number;
  model?: string;
};

type Device = AgentDevice & { leaseId: string | null; screen: Frame | null };

export class OpError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// About 2.5 GB per booted simulator, keeping 8 GB for macOS and everything else.
export function defaultMaxDevices(memoryBytes = totalmem(), cores = cpus().length): number {
  const byMemory = Math.floor((memoryBytes / 2 ** 30 - 8) / 2.5);
  return Math.max(1, Math.min(byMemory, Math.floor(cores / 2)));
}

export class Agent {
  private devices = new Map<string, Device>();
  private golden: { udid: string; model: string; os: string } | null = null;
  private filling = false;
  private streams = new Map<string, { jpeg: { stop: boolean } | null; h264: sim.ScreenStream | null; wantH264: boolean }>();
  private stopped = false;
  readonly maxDevices: number;
  readonly warm: number;

  private opts: AgentOptions;

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.maxDevices = opts.maxDevices ?? defaultMaxDevices();
    this.warm = Math.min(opts.warm ?? 1, this.maxDevices);
  }

  private log(line: string): void {
    (this.opts.log ?? console.log)(line);
  }

  async start(): Promise<void> {
    // Build the screen helper now, so the first viewer does not wait for the compiler.
    sim.screenBinary().catch((err: Error) => this.log(`${err.message} Streams will use JPEG.`));
    // Devices left from an earlier run may hold someone's data. They are deleted, never reused.
    for (const d of await sim.listOwned()) {
      if (!d.name.startsWith(`${sim.NAME_PREFIX}golden-`)) {
        this.log(`Deleting leftover device ${d.name}`);
        await sim.shutdown(d.udid).catch(() => {});
        await sim.remove(d.udid).catch(() => {});
      }
    }
    this.golden = await this.ensureGolden();
    this.opts.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      hostName: hostname(),
      versions: await sim.versions(),
      memoryBytes: totalmem(),
      offers: [{ model: this.golden.model, os: this.golden.os }],
      devices: this.inventory(),
      leases: [],
    });
    void this.fill();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const leaseId of this.streams.keys()) {
      this.stopStream(leaseId, 'h264');
      this.stopStream(leaseId, 'jpeg');
    }
    for (const d of this.devices.values()) {
      await sim.shutdown(d.deviceId).catch(() => {});
      await sim.remove(d.deviceId).catch(() => {});
    }
    this.devices.clear();
  }

  private async ensureGolden(): Promise<{ udid: string; model: string; os: string }> {
    const runtime = (await sim.runtimes()).sort((a, b) => compareVersions(a.version, b.version)).at(-1);
    if (!runtime) {
      throw new OpError('NO_RUNTIME', 'No iOS simulator runtime is installed. Install one in Xcode > Settings > Components.');
    }
    const types = await sim.deviceTypes();
    const wanted = this.opts.model;
    const type =
      (wanted ? types.find((t) => t.name.toLowerCase() === wanted.toLowerCase()) : undefined) ??
      types.filter((t) => /^iPhone \d+$/.test(t.name)).sort((a, b) => compareVersions(a.name.slice(7), b.name.slice(7))).at(-1) ??
      types[0];
    if (!type) {
      throw new OpError('NO_DEVICE_TYPE', 'Xcode lists no iPhone device types.');
    }
    const name = `${sim.NAME_PREFIX}golden-${type.name.replace(/\s+/g, '-')}-${runtime.version}`;
    const existing = (await sim.listOwned()).find((d) => d.name === name);
    if (existing) {
      await sim.shutdown(existing.udid);
      return { udid: existing.udid, model: type.name, os: runtime.version };
    }
    this.log(`Preparing ${type.name} on iOS ${runtime.version}. The first boot takes about a minute.`);
    const udid = await sim.create(name, type.identifier, runtime.identifier);
    await sim.prepareGolden(udid);
    return { udid, model: type.name, os: runtime.version };
  }

  private inventory(): AgentDevice[] {
    return [...this.devices.values()].map(({ deviceId, model, os, state }) => ({ deviceId, model, os, state }));
  }

  private publish(): void {
    this.opts.send({ type: 'inventory', devices: this.inventory() });
  }

  // Keeps `warm` devices ready, without going over `maxDevices`.
  private async fill(): Promise<void> {
    if (this.filling || this.stopped || !this.golden) {
      return;
    }
    this.filling = true;
    try {
      for (;;) {
        const all = [...this.devices.values()];
        const ready = all.filter((d) => d.state === 'ready').length;
        if (ready >= this.warm || all.length >= this.maxDevices || this.stopped) {
          break;
        }
        const g = this.golden;
        const udid = await sim.clone(g.udid, `${sim.NAME_PREFIX}${Date.now().toString(36)}`);
        this.devices.set(udid, { deviceId: udid, model: g.model, os: g.os, state: 'wiping', leaseId: null, screen: null });
        try {
          await sim.boot(udid);
          if (this.stopped) {
            await sim.remove(udid).catch(() => {});
            break;
          }
          this.devices.set(udid, { deviceId: udid, model: g.model, os: g.os, state: 'ready', leaseId: null, screen: null });
          this.log(`Device ready: ${g.model}, iOS ${g.os}`);
        } catch (err) {
          this.log(`A new device failed to boot: ${err instanceof Error ? err.message : err}`);
          this.devices.delete(udid);
          await sim.remove(udid).catch(() => {});
          break;
        }
        this.publish();
      }
    } finally {
      this.filling = false;
    }
  }

  receive(m: BrokerMessage): void {
    if (m.type === 'lease.prepare') {
      const d = this.devices.get(m.deviceId);
      if (!d || d.state !== 'ready') {
        this.respondError(m.id, 'DEVICE_NOT_READY', 'That device is not ready.');
        return;
      }
      d.leaseId = m.leaseId;
      d.state = 'busy';
      this.publish();
      this.opts.send({ type: 'response', id: m.id, ok: true });
      void this.fill();
    } else if (m.type === 'stream.start') {
      void (m.codec === 'h264' ? this.streamH264(m.leaseId) : this.streamJpeg(m.leaseId));
    } else if (m.type === 'stream.stop') {
      this.stopStream(m.leaseId, m.codec);
    } else if (m.type === 'stream.keyframe') {
      this.streams.get(m.leaseId)?.h264?.keyframe();
    } else if (m.type === 'lease.end') {
      this.stopStream(m.leaseId, 'h264');
      this.stopStream(m.leaseId, 'jpeg');
      this.streams.delete(m.leaseId);
      const d = [...this.devices.values()].find((x) => x.leaseId === m.leaseId);
      if (d) {
        void this.wipe(d);
      }
    } else if (m.type === 'op') {
      void this.op(m.id, m.leaseId, m.body);
    } else if (m.type === 'incompatible') {
      this.log(m.message);
    }
  }

  private streamOf(leaseId: string): { jpeg: { stop: boolean } | null; h264: sim.ScreenStream | null; wantH264: boolean } {
    let st = this.streams.get(leaseId);
    if (!st) {
      st = { jpeg: null, h264: null, wantH264: false };
      this.streams.set(leaseId, st);
    }
    return st;
  }

  private stopStream(leaseId: string, codec: 'h264' | 'jpeg'): void {
    const st = this.streams.get(leaseId);
    if (!st) {
      return;
    }
    if (codec === 'h264') {
      st.wantH264 = false;
      st.h264?.stop();
      st.h264 = null;
    } else if (st.jpeg) {
      st.jpeg.stop = true;
      st.jpeg = null;
    }
  }

  // The native helper: H.264 frames only when the screen changes. If it cannot run (a new Xcode
  // changed the private API, no Swift toolchain), the broker moves viewers to JPEG.
  private async streamH264(leaseId: string): Promise<void> {
    const st = this.streamOf(leaseId);
    if (st.wantH264) {
      return;
    }
    st.wantH264 = true;
    const d = [...this.devices.values()].find((x) => x.leaseId === leaseId);
    if (!d) {
      return;
    }
    const fail = (message: string): void => {
      this.log(`H.264 stream failed, falling back to JPEG: ${message}`);
      st.wantH264 = false;
      this.opts.send({ type: 'stream.failed', leaseId, codec: 'h264', message });
    };
    try {
      const stream = await sim.screenStream(d.deviceId, (data) => this.opts.send({ type: 'stream.frame', leaseId, codec: 'h264', data }));
      if (!st.wantH264) {
        stream.stop();
        return;
      }
      st.h264 = stream;
      void stream.exited.then((err) => {
        if (st.h264 === stream) {
          st.h264 = null;
          if (err) {
            fail(err);
          }
        }
      });
    } catch (err) {
      fail((err as Error).message);
    }
  }

  // JPEG frames as fast as the simulator can take screenshots, for browsers without WebCodecs.
  private async streamJpeg(leaseId: string): Promise<void> {
    const st = this.streamOf(leaseId);
    if (st.jpeg) {
      return;
    }
    const state = { stop: false };
    st.jpeg = state;
    while (!state.stop) {
      const d = [...this.devices.values()].find((x) => x.leaseId === leaseId);
      if (!d) {
        break;
      }
      try {
        const jpeg = await sim.screenshot(d.deviceId, 'jpeg', 800, 60);
        if (!state.stop) {
          this.opts.send({ type: 'stream.frame', leaseId, codec: 'jpeg', data: jpeg });
        }
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  // A device that was leased is deleted, and a fresh clone of the golden device replaces it.
  private async wipe(d: Device): Promise<void> {
    d.leaseId = null;
    d.state = 'wiping';
    this.publish();
    this.devices.delete(d.deviceId);
    await sim.shutdown(d.deviceId).catch(() => {});
    await sim.remove(d.deviceId).catch((err) => this.log(`Could not delete ${d.deviceId}: ${err}`));
    this.publish();
    void this.fill();
  }

  private respondError(id: number, code: string, message: string): void {
    this.opts.send({ type: 'response', id, ok: false, error: { code, message } });
  }

  private async op(id: number, leaseId: string, body: Op): Promise<void> {
    const d = [...this.devices.values()].find((x) => x.leaseId === leaseId);
    if (!d) {
      this.respondError(id, 'LEASE_NOT_HELD', 'This Mac holds no device for that lease.');
      return;
    }
    try {
      const out = await this.dispatch(d, body);
      this.opts.send({ type: 'response', id, ok: true, ...out });
    } catch (err) {
      const code = err instanceof OpError || err instanceof sim.DriverError ? err.code : 'OP_FAILED';
      this.respondError(id, code, err instanceof Error ? err.message : String(err));
    }
  }

  private async dispatch(d: Device, body: Op): Promise<{ result?: unknown; binary?: string }> {
    const udid = d.deviceId;
    switch (body.op) {
      case 'screenshot':
        return { binary: (await sim.screenshot(udid, body.format ?? 'png', body.maxSize)).toString('base64') };
      case 'describe': {
        const ui = await sim.describe(udid);
        d.screen = ui.screen;
        return { result: ui };
      }
      case 'actions': {
        const results: ActionResult[] = [];
        for (const action of body.actions) {
          try {
            await this.act(d, action);
            results.push({ ok: true });
          } catch (err) {
            const code = err instanceof OpError || err instanceof sim.DriverError ? err.code : 'ACTION_FAILED';
            results.push({ ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } });
            break;
          }
        }
        return { result: results };
      }
      case 'install':
        return { result: await this.install(udid, body.artifactUrl, body.sha256) };
      case 'launch':
        await sim.launch(udid, body.bundleId, body.args);
        return {};
      case 'terminate':
        await sim.terminate(udid, body.bundleId);
        return {};
      case 'uninstall':
        await sim.uninstall(udid, body.bundleId);
        return {};
      case 'openUrl':
        await sim.openUrl(udid, body.url);
        return {};
    }
  }

  private async screen(d: Device): Promise<Frame> {
    if (!d.screen) {
      d.screen = (await sim.describe(d.deviceId)).screen;
    }
    return d.screen;
  }

  private async toPoints(d: Device, p: [number, number]): Promise<[number, number]> {
    const s = await this.screen(d);
    return [Math.round(p[0] * s.width), Math.round(p[1] * s.height)];
  }

  private async act(d: Device, a: Action): Promise<void> {
    const udid = d.deviceId;
    switch (a.type) {
      case 'tap': {
        if ('element' in a) {
          const node = findOne((await sim.describe(udid)).nodes, a.element);
          await sim.tap(udid, Math.round(node.frame.x + node.frame.width / 2), Math.round(node.frame.y + node.frame.height / 2));
        } else {
          const [x, y] = await this.toPoints(d, a.point);
          await sim.tap(udid, x, y);
        }
        return;
      }
      case 'longPress': {
        const [x, y] = await this.toPoints(d, a.point);
        await sim.tap(udid, x, y, (a.durationMs ?? 1000) / 1000);
        return;
      }
      case 'swipe':
        await sim.swipe(udid, await this.toPoints(d, a.from), await this.toPoints(d, a.to), (a.durationMs ?? 300) / 1000);
        return;
      case 'type':
        await sim.typeText(udid, a.text);
        return;
      case 'key':
        await sim.key(udid, a.key);
        return;
      case 'button':
        await sim.button(udid, a.button);
        return;
      case 'waitFor': {
        const until = Date.now() + (a.timeoutMs ?? 5000);
        for (;;) {
          const found = findAll((await sim.describe(udid)).nodes, a.element).length > 0;
          if (found !== Boolean(a.gone)) {
            return;
          }
          if (Date.now() > until) {
            throw new OpError('WAIT_TIMEOUT', `${describeSelector(a.element)} ${a.gone ? 'is still on screen' : 'did not appear'} after ${a.timeoutMs ?? 5000} ms.`);
          }
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }
  }

  private async install(udid: string, url: string, sha256: string): Promise<{ bundleId: string; name: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'hangar-install-'));
    try {
      const archive = join(dir, 'archive');
      const res = await fetch(url);
      if (!res.ok || !res.body) {
        throw new OpError('DOWNLOAD_FAILED', `Could not download the build (HTTP ${res.status}).`);
      }
      const hash = createHash('sha256');
      await pipeline(
        Readable.fromWeb(res.body as WebReadableStream),
        async function* (source) {
          for await (const chunk of source) {
            hash.update(chunk as Buffer);
            yield chunk;
          }
        },
        createWriteStream(archive),
      );
      if (hash.digest('hex') !== sha256) {
        throw new OpError('CHECKSUM_MISMATCH', 'The downloaded build does not match its checksum.');
      }
      const out = join(dir, 'out');
      await run('mkdir', ['-p', out]);
      const { stdout: kind } = await run('file', ['-b', archive]);
      if (kind.startsWith('Zip')) {
        await run('ditto', ['-x', '-k', archive, out]);
      } else {
        await run('tar', ['-xf', archive, '-C', out]);
      }
      const app = await findApp(out);
      if (!app) {
        throw new OpError('NO_APP', 'The upload contains no .app bundle. Build for the simulator and zip the .app folder.');
      }
      const plist = join(app, 'Info.plist');
      const bundleId = (await run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', plist])).stdout.trim();
      const name = (await run('plutil', ['-extract', 'CFBundleName', 'raw', plist]).catch(() => ({ stdout: bundleId }))).stdout.trim();
      await sim.install(udid, app);
      return { bundleId, name };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

async function findApp(dir: string, depth = 0): Promise<string | null> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '__MACOSX') {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.name.endsWith('.app')) {
      return full;
    }
    if (depth < 3) {
      const found = await findApp(full, depth + 1);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

export function findAll(nodes: UiNode[], s: ElementSelector): UiNode[] {
  return nodes.filter((n) => {
    if (n.role === 'application') {
      return false;
    }
    if (s.identifier !== undefined && n.identifier !== s.identifier) {
      return false;
    }
    if (s.role !== undefined && !n.role.includes(s.role.toLowerCase())) {
      return false;
    }
    if (s.label !== undefined) {
      const label = (n.label ?? '').toLowerCase();
      const want = s.label.toLowerCase();
      if (s.exact ? label !== want : !label.includes(want)) {
        return false;
      }
    }
    return true;
  });
}

export function findOne(nodes: UiNode[], s: ElementSelector): UiNode {
  const all = findAll(nodes, s);
  const exact = s.label ? all.filter((n) => (n.label ?? '').toLowerCase() === s.label?.toLowerCase()) : [];
  const pick = all.length === 1 ? all : exact.length === 1 ? exact : all;
  if (pick.length === 0) {
    throw new OpError('ELEMENT_NOT_FOUND', `No element on screen matches ${describeSelector(s)}.`);
  }
  if (pick.length > 1) {
    const names = pick.slice(0, 5).map((n) => `"${n.label ?? n.identifier ?? n.role}"`).join(', ');
    throw new OpError('ELEMENT_AMBIGUOUS', `${pick.length} elements match ${describeSelector(s)}: ${names}. Add a role or "exact": true.`);
  }
  const [node] = pick;
  if (!node) {
    throw new OpError('ELEMENT_NOT_FOUND', `No element on screen matches ${describeSelector(s)}.`);
  }
  return node;
}

function describeSelector(s: ElementSelector): string {
  return Object.entries(s)
    .filter(([k]) => k !== 'exact')
    .map(([k, v]) => `${k} "${v}"`)
    .join(', ');
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }
  return 0;
}
