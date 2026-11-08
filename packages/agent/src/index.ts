// The host agent: owns the simulators on this Mac, keeps a warm pool, and serves only leased devices.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, totalmem, cpus, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
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
  type DeviceImage,
  type ElementSelector,
  type Frame,
  type MaestroResult,
  type Op,
  type UiNode,
} from '@hangar/protocol';
import * as sim from './drivers/ios/index.ts';
import { Tunnels } from './tunnels.ts';
import { xcuitest } from './xcuitest.ts';

const run = promisify(execFile);

export type AgentOptions = {
  send: (m: AgentMessage) => void;
  log?: (line: string) => void;
  // Most devices this Mac runs at once. Defaults to what its memory allows.
  maxDevices?: number;
  // Booted devices kept ready and unleased.
  warm?: number;
  model?: string;
  // Where the broker is, for the paths it sends to download builds and upload recordings.
  brokerUrl: string;
};

type Device = AgentDevice & { leaseId: string | null; screen: Frame | null };

type Golden = { udid: string; model: string; os: string };

// A declared image and the golden device built from it on this Mac. `failed` keeps a broken
// declaration from being rebuilt on every message; declaring it again with a change retries.
type ImageEntry = { image: DeviceImage; golden: Golden | null; failed: boolean };

type Stream = { jpeg: { stop: boolean } | null; h264: Promise<sim.ScreenStream> | null; wantH264: boolean };

type Recording = { dir: string; uploads: { video: string; log: string; screenshot: string }; log: sim.AppLog; finished: Promise<void> | null };

// Action points are fractions of the screen, so [0.5, 0.5] is the middle.
export function onScreen(p: [number, number]): void {
  if (!p.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
    throw new OpError('POINT_OFF_SCREEN', `The point [${p.join(', ')}] is off the screen. Points are fractions of the screen from 0 to 1, such as [0.5, 0.8].`);
  }
}

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
  private golden: Golden | null = null;
  private images = new Map<string, ImageEntry>();
  private imageWork: Promise<void> = Promise.resolve();
  private filling = false;
  private streams = new Map<string, Stream>();
  private stopped = false;
  private tunnels: Tunnels;
  private recordings = new Map<string, Recording>();
  readonly maxDevices: number;
  readonly warm: number;

  private opts: AgentOptions;

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.maxDevices = opts.maxDevices ?? defaultMaxDevices();
    this.warm = Math.min(opts.warm ?? 1, this.maxDevices);
    this.tunnels = new Tunnels(opts.send);
  }

  private log(line: string): void {
    (this.opts.log ?? console.log)(line);
  }

  async start(): Promise<void> {
    // Build the screen helper now, so the first viewer does not wait for the compiler.
    sim.screenBinary().catch((err: Error) => this.log(`${err.message} Streams will use JPEG.`));
    // Devices left from an earlier run may hold someone's data. They are deleted, never reused.
    await sim.stopLeftoverCompanions();
    for (const d of await sim.listOwned()) {
      if (!d.name.startsWith(`${sim.NAME_PREFIX}golden-`)) {
        this.log(`Deleting leftover device ${d.name}`);
        await sim.shutdown(d.udid).catch(() => {});
        await sim.remove(d.udid).catch(() => {});
      }
    }
    this.golden = await this.ensureGolden();
    await this.hello();
    void this.fill();
  }

  // The first message on every connection, again after a reconnect, so the broker can match
  // its leases to the devices that still hold them.
  async hello(): Promise<void> {
    if (!this.golden) {
      return;
    }
    this.opts.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      hostName: hostname(),
      versions: await sim.versions(),
      memoryBytes: totalmem(),
      offers: [{ model: this.golden.model, os: this.golden.os }, ...this.imageOffers()],
      devices: this.inventory(),
      leases: [...this.devices.values()].flatMap((d) => (d.leaseId ? [d.leaseId] : [])),
    });
  }

  private resolve(path: string): string {
    return new URL(path, this.opts.brokerUrl).toString();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.tunnels.stopAll();
    for (const leaseId of this.streams.keys()) {
      await this.endStreams(leaseId);
    }
    for (const d of this.devices.values()) {
      await sim.shutdown(d.deviceId).catch(() => {});
      await sim.remove(d.deviceId).catch(() => {});
    }
    this.devices.clear();
  }

  private imageOffers(): { model: string; os: string; image: string }[] {
    const g = this.golden;
    return g ? [...this.images.values()].filter((e) => !e.failed).map((e) => ({ model: g.model, os: g.os, image: e.image.name })) : [];
  }

  // Images are offered as soon as they are declared, so leases for them queue while they build.
  private async setImages(images: DeviceImage[]): Promise<void> {
    const offered = JSON.stringify(this.imageOffers());
    const wanted = new Map(images.map((i) => [i.name, i]));
    for (const [name, entry] of this.images) {
      if (wanted.get(name)?.id === entry.image.id) {
        continue;
      }
      this.images.delete(name);
      for (const d of this.devices.values()) {
        if (d.image === name && d.state === 'ready') {
          this.devices.delete(d.deviceId);
          await sim.remove(d.deviceId).catch(() => {});
        }
      }
    }
    for (const image of images) {
      if (!this.images.has(image.name)) {
        this.images.set(image.name, { image, golden: null, failed: false });
      }
    }
    if (JSON.stringify(this.imageOffers()) !== offered) {
      await this.hello();
    }
    await this.buildImages();
  }

  private async buildImages(): Promise<void> {
    const base = this.golden;
    if (!base) {
      return;
    }
    const owned = await sim.listOwned();
    // The base golden's model and runtime are part of the name: after an Xcode or runtime update
    // the image is built again, not reused from the old runtime.
    const goldenName = (e: ImageEntry): string => `${sim.NAME_PREFIX}golden-image-${e.image.id}-${base.model.replace(/\s+/g, '-')}-${base.os}`;
    const names = new Set([...this.images.values()].map(goldenName));
    for (const d of owned) {
      if (d.name.startsWith(`${sim.NAME_PREFIX}golden-image-`) && !names.has(d.name)) {
        await sim.remove(d.udid).catch(() => {});
      }
    }
    for (const entry of this.images.values()) {
      if (entry.golden || entry.failed || this.stopped) {
        continue;
      }
      const name = goldenName(entry);
      const existing = owned.find((d) => d.name === name);
      if (existing) {
        entry.golden = { ...base, udid: existing.udid };
        continue;
      }
      this.log(`Building image ${entry.image.name}.`);
      const udid = await sim.clone(base.udid, name);
      try {
        await sim.boot(udid);
        for (const app of entry.image.apps) {
          await this.install(udid, app.url, app.sha256);
        }
        if (entry.image.locale) {
          await sim.setLocale(udid, entry.image.locale);
        }
        if (entry.image.appearance) {
          await sim.appearance(udid, entry.image.appearance);
        }
        await sim.shutdown(udid);
        entry.golden = { ...base, udid };
        this.log(`Image ${entry.image.name} is ready.`);
      } catch (err) {
        entry.failed = true;
        this.log(`Image ${entry.image.name} failed to build: ${err instanceof Error ? err.message : err}`);
        await sim.remove(udid).catch(() => {});
        await this.hello();
      }
    }
    void this.fill();
  }

  private async ensureGolden(): Promise<Golden> {
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
    return [...this.devices.values()].map(({ deviceId, model, os, state, image }) => ({ deviceId, model, os, state, image }));
  }

  private publish(): void {
    this.opts.send({ type: 'inventory', devices: this.inventory() });
  }

  // Keeps `warm` plain devices ready, and `warm` of each built image, without going over
  // `maxDevices`. Plain devices come first.
  private async fill(): Promise<void> {
    if (this.filling || this.stopped || !this.golden) {
      return;
    }
    this.filling = true;
    try {
      for (;;) {
        const all = [...this.devices.values()];
        if (all.length >= this.maxDevices || this.stopped) {
          break;
        }
        const targets: { image: string | undefined; golden: Golden }[] = [{ image: undefined, golden: this.golden }];
        for (const e of this.images.values()) {
          if (e.golden) {
            targets.push({ image: e.image.name, golden: e.golden });
          }
        }
        const target = targets.find((t) => all.filter((d) => d.state === 'ready' && d.image === t.image).length < this.warm);
        if (!target) {
          break;
        }
        const { golden: g, image } = target;
        const udid = await sim.clone(g.udid, `${sim.NAME_PREFIX}${Date.now().toString(36)}`);
        this.devices.set(udid, { deviceId: udid, model: g.model, os: g.os, image, state: 'wiping', leaseId: null, screen: null });
        try {
          await sim.boot(udid);
          // The first tree read and screenshot on a new device take seconds; pay that here, so
          // a lease's first call is as fast as its later ones.
          await sim.describe(udid).catch(() => {});
          await sim.screenshot(udid, 'jpeg', 800).catch(() => {});
          if (this.stopped) {
            await sim.remove(udid).catch(() => {});
            break;
          }
          this.devices.set(udid, { deviceId: udid, model: g.model, os: g.os, image, state: 'ready', leaseId: null, screen: null });
          this.log(`Device ready: ${g.model}, iOS ${g.os}${image ? `, image ${image}` : ''}`);
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
    } else if (m.type === 'images') {
      const images = m.images;
      this.imageWork = this.imageWork.then(() => this.setImages(images)).catch((err) => this.log(`Images: ${err instanceof Error ? err.message : err}`));
    } else if (m.type === 'stream.start') {
      void (m.codec === 'h264' ? this.streamH264(m.leaseId) : this.streamJpeg(m.leaseId));
    } else if (m.type === 'stream.stop') {
      this.stopStream(m.leaseId, m.codec);
    } else if (m.type === 'tunnel.start') {
      if ([...this.devices.values()].some((x) => x.leaseId === m.leaseId)) {
        this.tunnels.start(m.id, m.leaseId);
      } else {
        this.respondError(m.id, 'LEASE_NOT_HELD', 'This Mac holds no device for that lease.');
      }
    } else if (m.type === 'tunnel.stop') {
      this.tunnels.stop(m.leaseId);
    } else if (m.type === 'tunnel.data') {
      this.tunnels.data(m.leaseId, m.conn, m.data);
    } else if (m.type === 'tunnel.close') {
      this.tunnels.close(m.leaseId, m.conn);
    } else if (m.type === 'stream.keyframe') {
      void this.streams.get(m.leaseId)?.h264?.then((h) => h.keyframe());
    } else if (m.type === 'lease.end') {
      void this.endLease(m.leaseId);
    } else if (m.type === 'op') {
      void this.op(m.id, m.leaseId, m.body);
    } else if (m.type === 'incompatible') {
      this.log(m.message);
    }
  }

  private streamOf(leaseId: string): Stream {
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
      // A recording keeps the helper running with nobody watching.
      if (!this.recordings.has(leaseId)) {
        void st.h264?.then((h) => h.stop()).catch(() => {});
        st.h264 = null;
      }
    } else if (st.jpeg) {
      st.jpeg.stop = true;
      st.jpeg = null;
    }
  }

  // Finishes any recording, then stops the screen helper and the JPEG loop.
  private async endStreams(leaseId: string): Promise<void> {
    await this.finishRecording(leaseId).catch((err: Error) => this.log(`Could not save the recording of lease ${leaseId}: ${err.message}`));
    const st = this.streams.get(leaseId);
    this.streams.delete(leaseId);
    if (st) {
      st.wantH264 = false;
      if (st.jpeg) {
        st.jpeg.stop = true;
      }
      await st.h264?.then((h) => h.stop()).catch(() => {});
    }
  }

  // The native helper: H.264 frames only when the screen changes, sent on only while a viewer
  // wants them. One helper per lease serves both viewers and the recording.
  private helper(leaseId: string): Promise<sim.ScreenStream> {
    const st = this.streamOf(leaseId);
    if (st.h264) {
      return st.h264;
    }
    const d = [...this.devices.values()].find((x) => x.leaseId === leaseId);
    if (!d) {
      return Promise.reject(new OpError('LEASE_NOT_HELD', 'This Mac holds no device for that lease.'));
    }
    const started = sim.screenStream(d.deviceId, (data) => {
      if (st.wantH264) {
        this.opts.send({ type: 'stream.frame', leaseId, codec: 'h264', data });
      }
    });
    st.h264 = started;
    started.then(
      (stream) =>
        void stream.exited.then((err) => {
          if (st.h264 === started) {
            st.h264 = null;
            if (err && st.wantH264) {
              this.h264Failed(leaseId, err);
            }
          }
        }),
      () => {
        if (st.h264 === started) {
          st.h264 = null;
        }
      },
    );
    return started;
  }

  // If the helper cannot run (a new Xcode changed the private API, no Swift toolchain), the
  // broker moves viewers to JPEG.
  private h264Failed(leaseId: string, message: string): void {
    this.log(`H.264 stream failed, falling back to JPEG: ${message}`);
    this.streamOf(leaseId).wantH264 = false;
    this.opts.send({ type: 'stream.failed', leaseId, codec: 'h264', message });
  }

  private async streamH264(leaseId: string): Promise<void> {
    const st = this.streamOf(leaseId);
    if (st.wantH264) {
      return;
    }
    st.wantH264 = true;
    try {
      (await this.helper(leaseId)).keyframe();
    } catch (err) {
      this.h264Failed(leaseId, (err as Error).message);
    }
  }

  // Recording: the helper writes its frames to an MP4 while the app log streams to a file.
  private async startRecording(d: Device, leaseId: string, uploads: Recording['uploads']): Promise<void> {
    if (this.recordings.has(leaseId)) {
      throw new OpError('ALREADY_RECORDING', 'This lease is already being recorded.');
    }
    for (const url of Object.values(uploads)) {
      if (!/^https?:\/\//.test(url)) {
        throw new OpError('BAD_UPLOAD_URL', 'Upload URLs must be http or https.');
      }
    }
    const screen = await this.helper(leaseId);
    const dir = await mkdtemp(join(tmpdir(), 'hangar-recording-'));
    screen.record(join(dir, 'video.mp4'));
    this.recordings.set(leaseId, { dir, uploads, log: sim.appLog(d.deviceId, join(dir, 'log.ndjson')), finished: null });
  }

  // Finishes the files and uploads them, the video last. The device is still there, so the last
  // screenshot is current.
  // A stop and the end of the lease can race; both wait for the same save.
  private finishRecording(leaseId: string): Promise<void> {
    const rec = this.recordings.get(leaseId);
    if (!rec) {
      return Promise.resolve();
    }
    rec.finished ??= this.saveRecording(leaseId, rec).finally(() => this.recordings.delete(leaseId));
    return rec.finished;
  }

  private async saveRecording(leaseId: string, rec: Recording): Promise<void> {
    try {
      const d = [...this.devices.values()].find((x) => x.leaseId === leaseId);
      if (d) {
        await writeFile(join(rec.dir, 'screenshot.png'), await sim.screenshot(d.deviceId, 'png')).catch(() => {});
      }
      await rec.log.stop();
      const st = this.streams.get(leaseId);
      await (await st?.h264)?.stopRecording();
      if (st && !st.wantH264) {
        await st.h264?.then((h) => h.stop()).catch(() => {});
        st.h264 = null;
      }
      for (const [part, file] of [['screenshot', 'screenshot.png'], ['log', 'log.ndjson'], ['video', 'video.mp4']] as const) {
        await upload(part, this.resolve(rec.uploads[part]), join(rec.dir, file));
      }
    } finally {
      await rm(rec.dir, { recursive: true, force: true });
    }
  }

  private async endLease(leaseId: string): Promise<void> {
    this.tunnels.stop(leaseId);
    await this.endStreams(leaseId);
    const d = [...this.devices.values()].find((x) => x.leaseId === leaseId);
    if (d) {
      await this.wipe(d);
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
    const leaseId = d.leaseId ?? '';
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
      case 'useMetro': {
        const tunnel = d.leaseId ? this.tunnels.port(d.leaseId) : undefined;
        if (!tunnel) {
          throw new OpError('NO_METRO_TUNNEL', 'No Metro tunnel is open for this lease. Run `hangar run ios`, which opens one.');
        }
        await sim.setDefault(udid, body.bundleId, 'RCT_jsLocation', `localhost:${tunnel}`);
        return { result: { url: `http://localhost:${tunnel}` } };
      }
      case 'push':
        await sim.push(udid, body.bundleId, body.payload);
        return {};
      case 'permission':
        await sim.privacy(udid, body.action, body.service, body.bundleId);
        return {};
      case 'location':
        await sim.location(udid, body.lat, body.lon);
        return {};
      case 'clearLocation':
        await sim.location(udid, null);
        return {};
      case 'appearance':
        await sim.appearance(udid, body.mode);
        return {};
      case 'locale':
        await sim.appLocale(udid, body.bundleId, body.language);
        return {};
      case 'maestro':
        return { result: await maestro(udid, body.archive, body.flows, body.env ?? {}) };
      case 'xcuitest':
        return { result: await xcuitest(udid, this.resolve(body.artifactUrl), body.sha256, body.tests) };
      case 'espresso':
        throw new OpError('NOT_ON_IOS', 'Espresso tests run on Android emulators. Lease one with platform android-emulator.');
      case 'recordStart':
        await this.startRecording(d, leaseId, body.uploads);
        return { result: { device: `${d.model}, iOS ${d.os}` } };
      case 'recordStop':
        if (!this.recordings.has(leaseId)) {
          throw new OpError('NOT_RECORDING', 'This Mac has no recording for that lease. It may have restarted.');
        }
        await this.finishRecording(leaseId);
        return {};
    }
  }

  // Maestro runs here, next to the simulator, on this lease's device only.
  private async screen(d: Device): Promise<Frame> {
    if (!d.screen) {
      d.screen = (await sim.describe(d.deviceId)).screen;
    }
    return d.screen;
  }

  private async toPoints(d: Device, p: [number, number]): Promise<[number, number]> {
    onScreen(p);
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
        await sim.key(udid, a.key, a.modifiers);
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
      await download(this.resolve(url), sha256, archive);
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

// PUTs a file to a one-use URL from the broker. A missing log or screenshot is left out; a
// missing video means the recording failed.
// Runs Maestro flows from a base64 tar against one device, named the way Maestro's --device
// takes it: a simulator UDID or an adb serial.
export async function maestro(device: string, archive: string, flows: string[], env: Record<string, string>): Promise<MaestroResult> {
  if (!flows.length || flows.some((f) => isAbsolute(f) || f.split(/[\\/]/).includes('..'))) {
    throw new OpError('BAD_FLOWS', 'Name one or more flows by their path inside the flows folder.');
  }
  const vars = Object.entries(env);
  if (vars.some(([k]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))) {
    throw new OpError('BAD_ENV', 'Environment variable names are letters, digits and underscores.');
  }
  const dir = await mkdtemp(join(tmpdir(), 'hangar-maestro-'));
  try {
    const root = join(dir, 'flows');
    await mkdir(root);
    await writeFile(join(dir, 'flows.tar'), Buffer.from(archive, 'base64'));
    // bsdtar refuses absolute paths and .. by default.
    await run('tar', ['-xf', join(dir, 'flows.tar'), '-C', root]);
    const report = join(dir, 'report.xml');
    const args = ['--no-ansi', '--device', device, 'test', ...flows.map((f) => join(root, f)), '--format', 'junit', '--output', report, '--test-output-dir', join(dir, 'debug'), '--flatten-debug-output'];
    for (const [k, v] of vars) {
      args.push('-e', `${k}=${v}`);
    }
    const started = Date.now();
    const out = await run('maestro', args, { maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000 }).then(
      (r) => ({ ok: true, text: r.stdout + r.stderr }),
      (err: { stdout?: string; stderr?: string; code?: unknown }) => {
        if (err.code === 'ENOENT') {
          throw new OpError('MAESTRO_MISSING', 'Maestro is not installed on this Mac. Install it with: curl -fsSL "https://get.maestro.mobile.dev" | bash');
        }
        return { ok: false, text: (err.stdout ?? '') + (err.stderr ?? '') };
      },
    );
    const junit = await readFile(report, 'utf8').catch(() => '');
    return { passed: out.ok, junit, log: out.text.slice(-20_000), durationMs: Date.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Downloads a build to `path` and checks it against the hash the broker gave.
export async function download(url: string, sha256: string, path: string): Promise<void> {
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
    createWriteStream(path),
  );
  if (hash.digest('hex') !== sha256) {
    throw new OpError('CHECKSUM_MISMATCH', 'The downloaded build does not match its checksum.');
  }
}

export async function upload(part: 'video' | 'log' | 'screenshot', url: string, path: string): Promise<void> {
  const size = await stat(path).then((s) => s.size, () => null);
  if (size === null) {
    if (part === 'video') {
      throw new OpError('RECORDING_FAILED', 'The screen helper wrote no video.');
    }
    return;
  }
  // A broker that stops answering must not hold up the wipe that follows.
  const init: RequestInit & { duplex: 'half' } = {
    method: 'PUT',
    headers: { 'content-length': String(size) },
    body: Readable.toWeb(createReadStream(path)) as ReadableStream,
    duplex: 'half',
    signal: AbortSignal.timeout(120_000),
  };
  const res = await fetch(url, init);
  if (!res.ok) {
    throw new OpError('UPLOAD_FAILED', `The broker refused the recording upload (${res.status}).`);
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
export { join, type HostAgent, type JoinOptions } from './connect.ts';
export { AndroidAgent, type AndroidAgentOptions } from './android.ts';
