// The Android side of a host: a pool of read-only emulators from one AVD. It speaks the same
// messages as the iOS agent and joins the broker as its own host, so leases pick a platform by
// device class.
//
// Each device is a fresh instance booted from the AVD's snapshot. Nothing it does is saved, so
// ending a lease kills the instance and the pool boots another: the wipe cannot leave data behind.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as android from './drivers/android/index.ts';
import { PROTOCOL_VERSION, type Action, type ActionResult, type AgentDevice, type AgentMessage, type BrokerMessage, type Op, type TestResult } from '@hangar/protocol';
import { download, findAll, findOne, maestro, onScreen, OpError } from './index.ts';
import { Tunnels } from './tunnels.ts';

const run = promisify(execFile);

export type AndroidAgentOptions = {
  send: (m: AgentMessage) => void;
  brokerUrl: string;
  avd: string;
  maxDevices?: number;
  warm?: number;
  log?: (line: string) => void;
};

type Device = AgentDevice & { emulator: android.Emulator; port: number; leaseId: string | null; screen: { width: number; height: number } };

// Console ports from 5600 up, away from the 5554 that Android Studio's own emulator takes.
const FIRST_PORT = 5600;

export class AndroidAgent {
  private devices = new Map<string, Device>();
  private booting = 0;
  private stopped = false;
  private model = { model: 'Android', os: '' };
  private streams = new Map<string, Promise<android.ScreenStream>>();
  private tunnels: Tunnels;
  private next = 0;
  readonly maxDevices: number;
  readonly warm: number;
  private opts: AndroidAgentOptions;

  constructor(opts: AndroidAgentOptions) {
    this.opts = opts;
    this.maxDevices = opts.maxDevices ?? 2;
    this.warm = Math.min(opts.warm ?? 1, this.maxDevices);
    this.tunnels = new Tunnels(opts.send);
  }

  private log(line: string): void {
    (this.opts.log ?? console.log)(`android: ${line}`);
  }

  async start(): Promise<void> {
    if (!(await android.avds()).includes(this.opts.avd)) {
      throw new OpError('NO_AVD', `There is no Android virtual device called ${this.opts.avd}. Known: ${(await android.avds()).join(', ') || 'none'}. Make one in Android Studio's Device Manager.`);
    }
    // The first device tells which model and Android version this AVD is.
    await this.boot();
    await this.hello();
    void this.fill();
  }

  async hello(): Promise<void> {
    this.opts.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      hostName: `${hostname()} (Android)`,
      versions: await android.versions(),
      memoryBytes: totalmem(),
      offers: [{ platform: 'android-emulator', ...this.model }],
      devices: this.inventory(),
      leases: [...this.devices.values()].flatMap((d) => (d.leaseId ? [d.leaseId] : [])),
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.tunnels.stopAll();
    for (const s of this.streams.values()) {
      await (await s).stop();
    }
    await Promise.all([...this.devices.values()].map((d) => android.kill(d.emulator)));
  }

  private inventory(): AgentDevice[] {
    return [...this.devices.values()].map(({ deviceId, model, os, state }) => ({ deviceId, model, os, state, platform: 'android-emulator' }));
  }

  private publish(): void {
    this.opts.send({ type: 'inventory', devices: this.inventory() });
  }

  private freePort(): number {
    const used = new Set([...this.devices.values()].map((d) => d.port));
    let port = FIRST_PORT;
    while (used.has(port)) {
      port += 2;
    }
    return port;
  }

  private async boot(): Promise<void> {
    const port = this.freePort();
    this.booting += 1;
    try {
      const emulator = await android.boot(this.opts.avd, port);
      const info = await android.info(emulator.serial);
      this.model = info;
      // A new id every boot: the broker never hands out a device id twice.
      const deviceId = `android-${process.pid}-${++this.next}`;
      this.devices.set(deviceId, { deviceId, ...info, state: 'ready', emulator, port, leaseId: null, screen: await android.screenSize(emulator.serial) });
      this.log(`${info.model} (Android ${info.os}) ready on port ${port}`);
      this.publish();
    } finally {
      this.booting -= 1;
    }
  }

  private async fill(): Promise<void> {
    while (!this.stopped) {
      const ready = [...this.devices.values()].filter((d) => d.state === 'ready').length + this.booting;
      if (ready >= this.warm || this.devices.size + this.booting >= this.maxDevices) {
        return;
      }
      await this.boot().catch((err: Error) => {
        this.log(`Could not boot an emulator: ${err.message}`);
        this.stopped = true;
      });
    }
  }

  receive(m: BrokerMessage): void {
    if (m.type === 'lease.prepare') {
      const d = this.devices.get(m.deviceId);
      if (!d || d.state !== 'ready') {
        this.opts.send({ type: 'response', id: m.id, ok: false, error: { code: 'DEVICE_NOT_READY', message: 'That device is not ready.' } });
        return;
      }
      d.leaseId = m.leaseId;
      d.state = 'busy';
      this.publish();
      this.opts.send({ type: 'response', id: m.id, ok: true });
      void this.fill();
    } else if (m.type === 'lease.end') {
      void this.endLease(m.leaseId);
    } else if (m.type === 'op') {
      void this.op(m.id, m.leaseId, m.body);
    } else if (m.type === 'stream.start') {
      if (m.codec === 'h264') {
        void this.startStream(m.leaseId);
      } else {
        this.opts.send({ type: 'stream.failed', leaseId: m.leaseId, codec: m.codec, message: 'Android streams are H.264 only; open the console over HTTPS or on localhost.' });
      }
    } else if (m.type === 'stream.stop') {
      void this.stopStream(m.leaseId);
    } else if (m.type === 'stream.keyframe') {
      void this.streams.get(m.leaseId)?.then((s) => s.keyframe());
    } else if (m.type === 'tunnel.start') {
      const d = this.held(m.leaseId);
      if (!d) {
        this.opts.send({ type: 'response', id: m.id, ok: false, error: { code: 'LEASE_NOT_HELD', message: 'This host holds no device for that lease.' } });
        return;
      }
      // React Native debug builds load from localhost:8081 on the device; adb reverse carries
      // that to the tunnel's port on this Mac.
      this.tunnels.start(m.id, m.leaseId, async (port) => {
        await run(join(android.sdkRoot() ?? '', 'platform-tools', 'adb'), ['-s', d.emulator.serial, 'reverse', 'tcp:8081', `tcp:${port}`]);
      });
    } else if (m.type === 'tunnel.stop') {
      this.tunnels.stop(m.leaseId);
    } else if (m.type === 'tunnel.data') {
      this.tunnels.data(m.leaseId, m.conn, m.data);
    } else if (m.type === 'tunnel.close') {
      this.tunnels.close(m.leaseId, m.conn);
    }
  }

  private held(leaseId: string): Device | undefined {
    return [...this.devices.values()].find((d) => d.leaseId === leaseId);
  }

  private async startStream(leaseId: string): Promise<void> {
    const d = this.held(leaseId);
    if (!d || this.streams.has(leaseId)) {
      return;
    }
    this.streams.set(leaseId, android.screenStream(d.emulator.serial, (data) => this.opts.send({ type: 'stream.frame', leaseId, codec: 'h264', data }), { maxSize: 1600 }));
  }

  private async stopStream(leaseId: string): Promise<void> {
    const s = this.streams.get(leaseId);
    this.streams.delete(leaseId);
    await (await s)?.stop();
  }

  private async endLease(leaseId: string): Promise<void> {
    this.tunnels.stop(leaseId);
    await this.stopStream(leaseId);
    const d = this.held(leaseId);
    if (!d) {
      return;
    }
    d.leaseId = null;
    d.state = 'wiping';
    this.publish();
    await android.kill(d.emulator);
    this.devices.delete(d.deviceId);
    this.publish();
    void this.fill();
  }

  private async op(id: number, leaseId: string, body: Op): Promise<void> {
    const d = this.held(leaseId);
    if (!d) {
      this.opts.send({ type: 'response', id, ok: false, error: { code: 'LEASE_NOT_HELD', message: 'This host holds no device for that lease.' } });
      return;
    }
    try {
      this.opts.send({ type: 'response', id, ok: true, ...(await this.dispatch(d, body)) });
    } catch (err) {
      const code = err instanceof OpError || err instanceof android.DriverError ? err.code : 'OP_FAILED';
      this.opts.send({ type: 'response', id, ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } });
    }
  }

  private async dispatch(d: Device, body: Op): Promise<{ result?: unknown; binary?: string }> {
    const serial = d.emulator.serial;
    switch (body.op) {
      case 'screenshot':
        return { binary: (await this.screenshot(serial, body.format ?? 'png', body.maxSize)).toString('base64') };
      case 'describe':
        return { result: await android.describe(serial) };
      case 'actions': {
        const results: ActionResult[] = [];
        for (const action of body.actions) {
          try {
            await this.act(d, action);
            results.push({ ok: true });
          } catch (err) {
            const code = err instanceof OpError || err instanceof android.DriverError ? err.code : 'ACTION_FAILED';
            results.push({ ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } });
            break;
          }
        }
        return { result: results };
      }
      case 'install': {
        const dir = await mkdtemp(join(tmpdir(), 'hangar-apk-'));
        try {
          const apk = join(dir, 'app.apk');
          await download(new URL(body.artifactUrl, this.opts.brokerUrl).toString(), body.sha256, apk);
          const pkg = await android.install(serial, apk);
          return { result: { bundleId: pkg, name: pkg } };
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      case 'launch':
        await android.launch(serial, body.bundleId);
        return {};
      case 'terminate':
        await android.terminate(serial, body.bundleId);
        return {};
      case 'uninstall':
        await android.uninstall(serial, body.bundleId);
        return {};
      case 'openUrl':
        await android.openUrl(serial, body.url);
        return {};
      case 'appearance':
        await android.appearance(serial, body.mode);
        return {};
      case 'location':
        await android.location(serial, body.lat, body.lon);
        return {};
      case 'useMetro': {
        if (!d.leaseId || !this.tunnels.port(d.leaseId)) {
          throw new OpError('NO_METRO_TUNNEL', 'No Metro tunnel is open for this lease. Run `hangar run android`, which opens one.');
        }
        return { result: { url: 'http://localhost:8081' } };
      }
      case 'maestro':
        return { result: await maestro(serial, body.archive, body.flows, body.env ?? {}) };
      case 'espresso':
        return { result: await this.espresso(serial, body.app, body.testApp, body.tests) };
      default:
        throw new OpError('NOT_ON_ANDROID', `${body.op} is not supported on Android emulators yet.`);
    }
  }

  // Installs the app and its test APK on the fresh device, then runs the instrumentation.
  private async espresso(serial: string, app: { url: string; sha256: string }, testApp: { url: string; sha256: string }, tests: string[]): Promise<TestResult> {
    android.checkTestNames(tests);
    const dir = await mkdtemp(join(tmpdir(), 'hangar-espresso-'));
    try {
      await download(new URL(app.url, this.opts.brokerUrl).toString(), app.sha256, join(dir, 'app.apk'));
      await download(new URL(testApp.url, this.opts.brokerUrl).toString(), testApp.sha256, join(dir, 'test.apk'));
      const target = await android.install(serial, join(dir, 'app.apk'));
      await android.installTestApk(serial, join(dir, 'test.apk'));
      const instrumentation = await android.instrumentationFor(serial, target);
      const started = Date.now();
      const out = await android.instrument(serial, instrumentation, tests);
      const { cases, ok } = android.parseInstrumentation(out, instrumentation.split('/')[0] ?? '');
      return { passed: ok && cases.every((c) => c.status === 'passed'), cases, log: out.slice(-20_000), durationMs: Date.now() - started };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async screenshot(serial: string, format: 'png' | 'jpeg', maxSize?: number): Promise<Buffer> {
    const png = await android.screenshot(serial);
    if (format === 'png' && !maxSize) {
      return png;
    }
    // sips ships with macOS, where the emulators run.
    const dir = await mkdtemp(join(tmpdir(), 'hangar-shot-'));
    try {
      await writeFile(join(dir, 'in.png'), png);
      const args = ['-s', 'format', format, ...(maxSize ? ['-Z', String(maxSize)] : []), join(dir, 'in.png'), '--out', join(dir, `out.${format}`)];
      await run('sips', args);
      return await readFile(join(dir, `out.${format}`));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private px(d: Device, p: [number, number]): [number, number] {
    onScreen(p);
    return [p[0] * d.screen.width, p[1] * d.screen.height];
  }

  private async act(d: Device, a: Action): Promise<void> {
    const serial = d.emulator.serial;
    switch (a.type) {
      case 'tap': {
        if ('element' in a) {
          const n = findOne((await android.describe(serial)).nodes, a.element);
          await android.tap(serial, n.frame.x + n.frame.width / 2, n.frame.y + n.frame.height / 2);
        } else {
          await android.tap(serial, ...this.px(d, a.point));
        }
        return;
      }
      case 'longPress':
        await android.tap(serial, ...this.px(d, a.point), a.durationMs ?? 1000);
        return;
      case 'swipe':
        await android.swipe(serial, this.px(d, a.from), this.px(d, a.to), a.durationMs ?? 300);
        return;
      case 'type':
        await android.typeText(serial, a.text);
        return;
      case 'key':
        await android.key(serial, a.key);
        return;
      case 'button':
        await android.button(serial, a.button);
        return;
      case 'waitFor': {
        const until = Date.now() + (a.timeoutMs ?? 5000);
        for (;;) {
          const found = findAll((await android.describe(serial)).nodes, a.element).length > 0;
          if (found !== Boolean(a.gone)) {
            return;
          }
          if (Date.now() > until) {
            throw new OpError('WAIT_TIMEOUT', `The element ${a.gone ? 'is still on screen' : 'did not appear'} after ${a.timeoutMs ?? 5000} ms.`);
          }
          await new Promise((r) => setTimeout(r, 300));
        }
      }
    }
  }
}
