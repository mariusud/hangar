import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as android from './drivers/android/index.ts';
import * as phone from './drivers/android/phone.ts';
import { PROTOCOL_VERSION, type Action, type ActionResult, type AgentDevice, type AgentMessage, type BrokerMessage, type Op, type TestResult } from '@devicepool/protocol';
import { download, findAll, findOne, maestro, onScreen, OpError } from './index.ts';
import { cursor, LeaseTools, pageLimit } from './drivers/devtools.ts';
import type { JsTools } from './drivers/cdp.ts';
import { ToolError } from './drivers/tool-error.ts';
import { Tunnels } from './tunnels.ts';

const run = promisify(execFile);

export type AndroidAgentOptions = {
  send: (m: AgentMessage) => void;
  brokerUrl: string;
  /** The Android virtual device to run emulators from. Left out, the host runs no emulators. */
  avd?: string;
  /** Offer the Android phones attached to this Mac. */
  phones?: boolean;
  /** Where the baseline of a leased phone is kept until its wipe is verified. */
  stateDir?: string;
  /** How the agent reaches adb for phones. Tests pass a fake phone here. */
  adb?: PhoneAdb;
  /** The driver calls that change which apps a phone holds. Tests pass their own. */
  driver?: PhoneDriver;
  maxDevices?: number;
  warm?: number;
  log?: (line: string) => void;
};

export type PhoneAdb = {
  /** The output of `adb devices -l`. */
  list: () => Promise<string>;
  open: (serial: string) => android.Adb;
};
export type PhoneDriver = Pick<typeof android, 'install' | 'launch'>;

type Shared = AgentDevice & { serial: string; leaseId: string | null; screen: { width: number; height: number } };
type EmulatorDevice = Shared & { kind: 'emulator'; emulator: android.Emulator; port: number };
// `touched` are the packages the lease installed or launched; `baseline` is the phone as the lease found it.
// `running` are the operations of the lease that have not answered yet; the wipe waits for them.
type PhoneDevice = Shared & { kind: 'phone'; adb: android.Adb; touched: Set<string>; baseline: phone.PhoneState | null; running: Set<Promise<void>> };
type Device = EmulatorDevice | PhoneDevice;

const PHONE_SCAN_MS = 3000;
// How long a wipe waits for operations of the ended lease that are still running on the phone.
const RUNNING_OPS_MS = 60_000;
const REPLUG = 'unplug it, wait ten seconds and plug it in again';

// Console ports start at 5600, away from the 5554 that Android Studio uses.
const FIRST_PORT = 5600;

export class AndroidAgent {
  private devices = new Map<string, Device>();
  private booting = 0;
  private stopped = false;
  private model = { model: 'Android', os: '' };
  private streams = new Map<string, Promise<android.ScreenStream>>();
  private tunnels: Tunnels;
  private tools = new LeaseTools();
  private next = 0;
  // Phones adb lists but cannot use, by serial, with what the operator should do.
  private unusable = new Map<string, string>();
  private skipped = new Map<string, string>();
  private enrolling = new Set<string>();
  // Phones in state `device` that did not answer when they were enrolled, by serial.
  private failed = new Map<string, string>();
  // Scans in a row that each known phone has been missing.
  private misses = new Map<string, number>();
  // The lease a phone held when it left. If the phone comes back before the broker ends that lease, the lease goes on.
  private lost = new Map<string, string>();
  // One queue of work per phone: recording, wiping and enrolling never overlap on the same phone.
  private chains = new Map<string, Promise<void>>();
  private adb: PhoneAdb;
  private driver: PhoneDriver;
  private scanning = false;
  private scanError = '';
  private scanTimer: NodeJS.Timeout | null = null;
  private stateDir: string;
  readonly maxDevices: number;
  readonly warm: number;
  private opts: AndroidAgentOptions;

  constructor(opts: AndroidAgentOptions) {
    this.opts = opts;
    this.maxDevices = opts.maxDevices ?? 2;
    this.warm = Math.min(opts.warm ?? 1, this.maxDevices);
    this.tunnels = new Tunnels(opts.send);
    this.adb = opts.adb ?? { list: android.deviceList, open: android.adbFor };
    this.driver = opts.driver ?? android;
    this.stateDir = opts.stateDir ?? join(process.env.DEVICEPOOL_HOME ?? join(homedir(), '.devicepool'), 'phones');
  }

  private log(line: string): void {
    (this.opts.log ?? console.log)(`android: ${line}`);
  }

  async start(): Promise<void> {
    const avd = this.opts.avd;
    if (avd) {
      if (!(await android.avds()).includes(avd)) {
        throw new OpError('NO_AVD', `There is no Android virtual device called ${avd}. Known: ${(await android.avds()).join(', ') || 'none'}. Make one in Android Studio's Device Manager.`);
      }
      await this.boot(avd);
    }
    await this.hello();
    if (this.opts.phones) {
      await this.scanPhones();
      this.scanTimer = setInterval(() => void this.scanPhones(), PHONE_SCAN_MS);
    }
    void this.fill();
  }

  async hello(): Promise<void> {
    this.opts.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      hostName: `${hostname()} (Android)`,
      versions: await android.versions().catch(() => ({})),
      memoryBytes: totalmem(),
      offers: this.offers(),
      devices: this.inventory(),
      leases: [...this.devices.values()].flatMap((d) => (d.leaseId ? [d.leaseId] : [])),
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
    }
    this.tunnels.stopAll();
    this.tools.closeAll();
    for (const s of this.streams.values()) {
      await (await s).stop();
    }
    // A leased phone keeps its baseline on disk and is wiped when this host next sees it.
    await Promise.all(this.emulators().map((d) => android.kill(d.emulator)));
  }

  private emulators(): EmulatorDevice[] {
    return [...this.devices.values()].filter((d) => d.kind === 'emulator');
  }

  private phones(): PhoneDevice[] {
    return [...this.devices.values()].filter((d) => d.kind === 'phone');
  }

  private offers(): { model: string; os: string; platform: 'android-emulator' | 'android-device' }[] {
    const offers: { model: string; os: string; platform: 'android-emulator' | 'android-device' }[] = [];
    if (this.opts.avd) {
      offers.push({ platform: 'android-emulator', ...this.model });
    }
    for (const d of this.phones()) {
      if (!offers.some((o) => o.platform === 'android-device' && o.model === d.model && o.os === d.os)) {
        offers.push({ platform: 'android-device', model: d.model, os: d.os });
      }
    }
    return offers;
  }

  private inventory(): AgentDevice[] {
    const devices: AgentDevice[] = [];
    for (const d of this.devices.values()) {
      const device: AgentDevice = { deviceId: d.deviceId, model: d.model, os: d.os, state: d.state, platform: d.kind === 'phone' ? 'android-device' : 'android-emulator' };
      if (d.note) {
        device.note = d.note;
      }
      devices.push(device);
    }
    // A known phone that is offline for a scan or two is already listed above.
    for (const [serial, note] of [...this.unusable, ...this.failed]) {
      const deviceId = phone.deviceIdFor(serial);
      if (!devices.some((d) => d.deviceId === deviceId)) {
        devices.push({ deviceId, model: 'Android phone', os: '', state: 'quarantined', platform: 'android-device', note });
      }
    }
    return devices;
  }

  private publish(): void {
    this.opts.send({ type: 'inventory', devices: this.inventory() });
  }

  private freePort(): number {
    const used = new Set(this.emulators().map((d) => d.port));
    let port = FIRST_PORT;
    while (used.has(port)) {
      port += 2;
    }
    return port;
  }

  private async boot(avd: string): Promise<void> {
    const port = this.freePort();
    this.booting += 1;
    try {
      const emulator = await android.boot(avd, port);
      const info = await android.info(emulator.serial);
      this.model = info;
      const deviceId = `android-${process.pid}-${++this.next}`;
      this.devices.set(deviceId, { kind: 'emulator', deviceId, ...info, state: 'ready', serial: emulator.serial, emulator, port, leaseId: null, screen: await android.screenSize(emulator.serial) });
      this.log(`${info.model} (Android ${info.os}) ready on port ${port}`);
      this.publish();
    } finally {
      this.booting -= 1;
    }
  }

  private async fill(): Promise<void> {
    const avd = this.opts.avd;
    while (avd && !this.stopped) {
      const ready = this.emulators().filter((d) => d.state === 'ready').length + this.booting;
      if (ready >= this.warm || this.emulators().length + this.booting >= this.maxDevices) {
        return;
      }
      await this.boot(avd).catch((err: Error) => {
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
      if (d.kind === 'phone') {
        void this.enqueue(d.deviceId, () => this.preparePhone(d, m.id, m.leaseId));
        return;
      }
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
      const adb = join(android.sdkRoot() ?? '', 'platform-tools', 'adb');
      this.tunnels.start(m.id, m.leaseId, m.ports, async (port, extra) => {
        await run(adb, ['-s', d.serial, 'reverse', 'tcp:8081', `tcp:${port}`]);
        for (const [wanted, local] of Object.entries(extra)) {
          await run(adb, ['-s', d.serial, 'reverse', `tcp:${wanted}`, `tcp:${local}`]);
        }
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
    this.streams.set(leaseId, android.screenStream(d.serial, (data) => this.opts.send({ type: 'stream.frame', leaseId, codec: 'h264', data }), { maxSize: 1600 }));
  }

  private async stopStream(leaseId: string): Promise<void> {
    const s = this.streams.get(leaseId);
    this.streams.delete(leaseId);
    await (await s)?.stop();
  }

  private async endLease(leaseId: string): Promise<void> {
    this.tunnels.stop(leaseId);
    this.tools.close(leaseId);
    for (const [deviceId, lostLease] of this.lost) {
      if (lostLease === leaseId) {
        this.lost.delete(deviceId);
      }
    }
    const d = this.held(leaseId);
    if (d?.kind === 'phone') {
      // From here no operation of the lease starts, and the wipe has its place in the phone's queue.
      d.leaseId = null;
      const stopped = this.stopStream(leaseId).catch(() => {});
      await this.enqueue(d.deviceId, async () => {
        await stopped;
        await this.finishPhoneLease(d);
      });
      return;
    }
    await this.stopStream(leaseId);
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

  // Runs work for one phone after the work already queued for it. Other phones are not held up.
  private enqueue(deviceId: string, job: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(deviceId) ?? Promise.resolve()).then(job).catch((err: unknown) => {
      this.log(`Work on a phone failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.chains.set(deviceId, next);
    void next.then(() => {
      if (this.chains.get(deviceId) === next) {
        this.chains.delete(deviceId);
      }
    });
    return next;
  }

  /** Resolves when no phone has work queued. */
  async idle(): Promise<void> {
    while (this.chains.size) {
      await Promise.all(this.chains.values());
    }
  }

  /** Looks at `adb devices` for phones that were plugged in, unplugged, or need the operator. It does not wait for a phone's wipe. */
  async scanPhones(): Promise<void> {
    if (this.scanning) {
      return;
    }
    this.scanning = true;
    try {
      const known = [...this.phones().map((d) => d.serial), ...this.enrolling];
      const changes = phone.phoneChanges(known, phone.parseDevices(await this.adb.list()), this.misses);
      this.misses = changes.misses;
      this.scanError = '';
      let offersChanged = false;
      for (const serial of changes.left) {
        const d = this.phones().find((p) => p.serial === serial);
        if (d) {
          this.dropPhone(d);
          offersChanged = true;
        }
      }
      const notes = (m: Map<string, string>): string => JSON.stringify([...m].sort());
      const before = notes(new Map([...this.unusable, ...this.failed]));
      for (const serial of this.failed.keys()) {
        if (!changes.arrived.includes(serial)) {
          this.failed.delete(serial);
        }
      }
      for (const serial of changes.arrived) {
        this.enrol(serial);
      }
      for (const [serial, note] of changes.unusable) {
        if (this.unusable.get(serial) !== note) {
          this.log(`A phone is attached but cannot be used. ${note}`);
        }
      }
      for (const [serial, reason] of changes.skipped) {
        if (!this.skipped.has(serial)) {
          this.log(`Skipped ${serial}: ${reason}`);
        }
      }
      this.unusable = changes.unusable;
      this.skipped = changes.skipped;
      if (offersChanged) {
        await this.hello();
      } else if (notes(new Map([...this.unusable, ...this.failed])) !== before) {
        this.publish();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message !== this.scanError) {
        this.log(`Could not look for phones: ${message}`);
      }
      this.scanError = message;
    } finally {
      this.scanning = false;
    }
  }

  // Adds a phone adb can talk to. A phone with a record on disk left a lease unwiped, so it is not `ready` until that is dealt with.
  private enrol(serial: string): void {
    const deviceId = phone.deviceIdFor(serial);
    this.enrolling.add(serial);
    void this.enqueue(deviceId, async () => {
      const adb = this.adb.open(serial);
      let d: PhoneDevice;
      let stored: phone.Stored;
      try {
        const { screen, ...info } = await phone.identify(adb);
        stored = await phone.loadBaseline(this.stateDir, deviceId);
        d = { kind: 'phone', deviceId, ...info, state: 'wiping', serial, adb, leaseId: null, screen, touched: new Set(), baseline: null, running: new Set() };
        this.devices.set(deviceId, d);
        this.failed.delete(serial);
      } catch (err) {
        this.failed.set(serial, `The phone did not answer adb (${err instanceof Error ? err.message : String(err)}). Unplug it and plug it in again.`);
        this.publish();
        return;
      } finally {
        this.enrolling.delete(serial);
      }
      const leaseId = this.lost.get(deviceId);
      this.lost.delete(deviceId);
      if (stored.status === 'none') {
        d.state = 'ready';
        this.log(`${d.model} (Android ${d.os}) attached and ready`);
      } else if (stored.status === 'invalid') {
        this.quarantine(d, `The record of this phone from before its last lease cannot be used: ${stored.reason}. The phone may still hold what that lease left. Check the phone by hand, delete the record, then ${REPLUG}.`);
      } else {
        d.baseline = stored.baseline;
        d.touched = new Set(stored.touched);
        if (leaseId) {
          // The broker decides whether the lease is over: hello names it, and the broker answers lease.end if it is.
          d.leaseId = leaseId;
          d.state = 'busy';
          this.log(`${d.model} is back and its lease may still be open; it is wiped when the lease ends`);
        }
      }
      await this.hello();
      if (stored.status === 'ok' && !leaseId) {
        this.log(`${d.model} is back with a lease that was not wiped; wiping it now`);
        await this.wipePhone(d);
      }
    });
  }

  private dropPhone(d: PhoneDevice): void {
    this.devices.delete(d.deviceId);
    if (d.leaseId) {
      this.lost.set(d.deviceId, d.leaseId);
      this.tunnels.stop(d.leaseId);
      this.tools.close(d.leaseId);
      void this.stopStream(d.leaseId);
    }
    this.log(`${d.model} was unplugged${d.baseline ? '; its lease is wiped when it is plugged in again' : ''}`);
  }

  // Records the phone as the lease finds it, on disk too, before the lease may change anything.
  private async preparePhone(d: PhoneDevice, id: number, leaseId: string): Promise<void> {
    const refuse = (message: string): void => {
      this.opts.send({ type: 'response', id, ok: false, error: { code: 'DEVICE_NOT_READY', message } });
    };
    if (this.devices.get(d.deviceId) !== d || d.leaseId !== leaseId) {
      refuse('The lease ended, or the phone was unplugged, before the phone was recorded.');
      return;
    }
    d.touched = new Set();
    try {
      const baseline = await phone.snapshot(d.adb);
      await phone.saveBaseline(this.stateDir, d.deviceId, baseline);
      d.baseline = baseline;
    } catch (err) {
      // Nothing was changed on the phone, so it needs no wipe and keeps no record.
      const message = err instanceof Error ? err.message : String(err);
      await phone.dropBaseline(this.stateDir, d.deviceId).catch(() => {});
      this.log(`${d.model} could not be recorded before a lease, so the lease did not start. ${message}`);
      refuse(`Could not record the phone before the lease. ${message}`);
      if (d.leaseId === leaseId) {
        d.leaseId = null;
        d.state = 'ready';
        this.publish();
      }
      return;
    }
    try {
      await phone.wake(d.adb);
    } catch (err) {
      // Waking changes the stay-awake setting, so the phone goes through its wipe.
      refuse(`Could not wake the phone for the lease: ${err instanceof Error ? err.message : String(err)}`);
      if (d.leaseId === leaseId) {
        d.leaseId = null;
      }
      await this.wipePhone(d);
      return;
    }
    this.opts.send({ type: 'response', id, ok: true });
  }

  // Marks a package as used by the lease, on disk, before the caller goes on.
  private async touch(d: Device, pkg: string): Promise<void> {
    if (d.kind !== 'phone' || d.touched.has(pkg)) {
      return;
    }
    await phone.saveTouched(this.stateDir, d.deviceId, [...d.touched, pkg]);
    d.touched.add(pkg);
  }

  // Runs after everything queued for the phone when its lease ended, so a lease that ends while it is being prepared waits.
  private async finishPhoneLease(d: PhoneDevice): Promise<void> {
    if (d.running.size) {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, RUNNING_OPS_MS);
        timer.unref();
      });
      await Promise.race([Promise.all(d.running), late]);
      clearTimeout(timer);
    }
    if (this.devices.get(d.deviceId) !== d) {
      return;
    }
    if (!d.baseline) {
      // The phone was never recorded for this lease, so the lease did nothing to it.
      if (d.state === 'busy' && d.leaseId === null) {
        d.state = 'ready';
        this.publish();
      }
      return;
    }
    await this.wipePhone(d);
  }

  private quarantine(d: PhoneDevice, note: string): void {
    d.state = 'quarantined';
    d.note = note;
    this.log(`${d.model} is quarantined. ${note}`);
  }

  // A phone is `ready` again only when what is read back from it matches its baseline. Call it from the phone's queue.
  private async wipePhone(d: PhoneDevice): Promise<void> {
    d.state = 'wiping';
    delete d.note;
    this.publish();
    const baseline = d.baseline;
    const result: phone.WipeResult = baseline
      ? await phone.wipe(d.adb, baseline, d.touched).catch((err: unknown) => ({ ok: false, problems: [err instanceof Error ? err.message : String(err)] }))
      : { ok: false, problems: ['the record of the phone before the lease is missing, so nothing can be compared'] };
    if (this.devices.get(d.deviceId) !== d) {
      return;
    }
    const kept = result.ok ? await phone.dropBaseline(this.stateDir, d.deviceId).then(() => '', (err: unknown) => (err instanceof Error ? err.message : String(err))) : '';
    if (kept) {
      this.quarantine(d, `The phone was wiped and checked, but its record could not be deleted (${kept}). Delete the files for ${d.deviceId} in ${this.stateDir}, then ${REPLUG}.`);
    } else if (result.ok) {
      d.baseline = null;
      d.touched = new Set();
      d.state = 'ready';
      this.log(`${d.model} wiped and checked against its baseline`);
    } else {
      this.quarantine(d, `The wipe could not be verified: ${result.problems.join('; ')}. Fix this on the phone, then ${REPLUG} to run the check once more.`);
    }
    this.publish();
  }

  private async op(id: number, leaseId: string, body: Op): Promise<void> {
    const d = this.held(leaseId);
    if (!d) {
      this.opts.send({ type: 'response', id, ok: false, error: { code: 'LEASE_NOT_HELD', message: 'This host holds no device for that lease.' } });
      return;
    }
    try {
      const work = this.dispatch(d, body);
      if (d.kind === 'phone') {
        const settled = work.then(() => {}, () => {});
        d.running.add(settled);
        void settled.then(() => d.running.delete(settled));
      }
      this.opts.send({ type: 'response', id, ok: true, ...(await work) });
    } catch (err) {
      const code = err instanceof OpError || err instanceof android.DriverError || err instanceof ToolError ? err.code : 'OP_FAILED';
      this.opts.send({ type: 'response', id, ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } });
    }
  }

  private async dispatch(d: Device, body: Op): Promise<{ result?: unknown; binary?: string }> {
    const serial = d.serial;
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
        const dir = await mkdtemp(join(tmpdir(), 'devicepool-apk-'));
        try {
          const apk = join(dir, 'app.apk');
          await download(new URL(body.artifactUrl, this.opts.brokerUrl).toString(), body.sha256, apk);
          // The package name is only known once the APK is installed, so it is recorded right after.
          const pkg = await this.driver.install(serial, apk);
          await this.touch(d, pkg);
          if (d.leaseId) {
            this.tools.noteApp(d.leaseId, pkg);
          }
          return { result: { bundleId: pkg, name: pkg } };
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      case 'launch':
        await this.touch(d, android.checkPackage(body.bundleId));
        await this.driver.launch(serial, body.bundleId);
        if (d.leaseId) {
          this.tools.noteApp(d.leaseId, body.bundleId);
        }
        return {};
      case 'terminate':
        await android.terminate(serial, body.bundleId);
        return {};
      case 'uninstall':
        if (d.kind === 'phone' && d.baseline && body.bundleId in d.baseline.packages) {
          throw new OpError('IN_BASELINE', `${body.bundleId} was on the phone before this lease, so the lease may not remove it. Uninstall only apps the lease installed.`);
        }
        await android.uninstall(serial, body.bundleId);
        return {};
      case 'openUrl':
        await android.openUrl(serial, body.url);
        return {};
      case 'appearance':
        await android.appearance(serial, body.mode);
        return {};
      case 'location':
        if (d.kind === 'phone') {
          throw new OpError('NOT_ON_PHONE', 'Location is set through the emulator console, which a phone does not have. Lease an emulator for location tests.');
        }
        await android.location(serial, body.lat, body.lon);
        return {};
      case 'useMetro': {
        if (!d.leaseId || !this.tunnels.port(d.leaseId)) {
          throw new OpError('NO_METRO_TUNNEL', 'No Metro tunnel is open for this lease. Run `devicepool run android`, which opens one.');
        }
        return { result: { url: 'http://localhost:8081' } };
      }
      case 'maestro':
        return { result: await maestro(serial, body.archive, body.flows, body.env ?? {}) };
      case 'espresso':
        return { result: await this.espresso(d, body.app, body.testApp, body.tests) };
      case 'appLog':
        return { result: await this.tools.appLog(d.leaseId ?? '', body, (pkg) => android.appLogSource(serial, pkg)) };
      case 'jsEvaluate':
        return { result: await this.js(d).evaluate(body.expression, body.bundleId) };
      case 'jsConsole':
        return { result: await this.js(d).consolePage(body.bundleId, cursor(body.since), pageLimit(body.limit)) };
      case 'network':
        return { result: await this.js(d).networkPage(body.bundleId, cursor(body.since), pageLimit(body.limit)) };
      case 'orientation': {
        await android.orientation(serial, body.orientation);
        const size = await android.screenSize(serial);
        const sideways = body.orientation === 'landscapeLeft' || body.orientation === 'landscapeRight';
        d.screen = sideways ? { width: size.height, height: size.width } : size;
        return {};
      }
      case 'gesture':
        return android.multiTouch();
      default:
        throw new OpError('NOT_ON_ANDROID', `${body.op} is not supported on Android yet.`);
    }
  }

  private js(d: Device): JsTools {
    const leaseId = d.leaseId ?? '';
    const model = d.model;
    return this.tools.js(leaseId, {
      port: () => this.tunnels.port(leaseId),
      matchDevice: async () => (listed) => model !== '' && listed.startsWith(model),
    });
  }

  private async espresso(d: Device, app: { url: string; sha256: string }, testApp: { url: string; sha256: string }, tests: string[]): Promise<TestResult> {
    android.checkTestNames(tests);
    const serial = d.serial;
    const dir = await mkdtemp(join(tmpdir(), 'devicepool-espresso-'));
    try {
      await download(new URL(app.url, this.opts.brokerUrl).toString(), app.sha256, join(dir, 'app.apk'));
      await download(new URL(testApp.url, this.opts.brokerUrl).toString(), testApp.sha256, join(dir, 'test.apk'));
      const target = await this.driver.install(serial, join(dir, 'app.apk'));
      await this.touch(d, target);
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
    const dir = await mkdtemp(join(tmpdir(), 'devicepool-shot-'));
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
    const serial = d.serial;
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
