import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDevice, AgentMessage } from '@devicepool/protocol';
import { AndroidAgent } from './android.ts';
import { FakePhone } from './drivers/android/fake-phone.ts';
import { baselinePath, deviceIdFor, saveBaseline, snapshot } from './drivers/android/phone.ts';

const A = '39051FDJH000AB';
const B = 'R58M12ABCDE';

// An agent whose adb is a set of fake phones. Nothing here starts adb.
class Bench {
  phones = new Map<string, FakePhone>();
  /** The device lines of `adb devices -l`. */
  attached: string[] = [];
  sent: AgentMessage[] = [];
  logs: string[] = [];
  launched: string[] = [];
  onLaunch: (pkg: string) => Promise<void> = async () => {};
  agent: AndroidAgent;
  dir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.agent = new AndroidAgent({
      send: (m) => this.sent.push(m),
      brokerUrl: 'http://127.0.0.1:1',
      phones: true,
      stateDir: dir,
      log: (line) => this.logs.push(line),
      adb: {
        list: async () => `List of devices attached\n${this.attached.join('\n')}\n`,
        open: (serial) => (this.phones.get(serial) ?? Object.assign(new FakePhone(serial), { dead: true })).adb(),
      },
      driver: {
        install: async () => 'com.example.app',
        launch: async (_serial, pkg) => {
          await this.onLaunch(pkg);
          this.launched.push(pkg);
        },
      },
    });
  }

  plug(serial: string): FakePhone {
    const fake = new FakePhone(serial);
    this.phones.set(serial, fake);
    this.attached.push(`${serial} device usb:1-${this.attached.length + 1} model:Pixel_8a`);
    return fake;
  }

  unplug(serial: string): void {
    this.attached = this.attached.filter((line) => !line.startsWith(`${serial} `));
  }

  async scan(times = 1): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await this.agent.scanPhones();
    }
  }

  /** The devices in the last hello or inventory the agent sent. */
  devices(): AgentDevice[] {
    for (const m of this.sent.toReversed()) {
      if (m.type === 'hello' || m.type === 'inventory') {
        return m.devices;
      }
    }
    return [];
  }

  device(serial: string): AgentDevice | undefined {
    return this.devices().find((d) => d.deviceId === deviceIdFor(serial));
  }

  heldLeases(): string[] {
    for (const m of this.sent.toReversed()) {
      if (m.type === 'hello') {
        return m.leases;
      }
    }
    return [];
  }

  response(id: number): (AgentMessage & { type: 'response' }) | undefined {
    for (const m of this.sent) {
      if (m.type === 'response' && m.id === id) {
        return m;
      }
    }
    return undefined;
  }

  async until(what: string, done: () => boolean): Promise<void> {
    const until = Date.now() + 5000;
    while (!done() && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1));
    }
    assert.equal(done(), true, `waited for ${what}`);
  }

  /** Leases the phone and waits until the agent answered. */
  async lease(serial: string, leaseId: string, id: number): Promise<void> {
    this.agent.receive({ type: 'lease.prepare', id, leaseId, deviceId: deviceIdFor(serial), deadline: Date.now() + 60_000 });
    await this.until(`the answer to lease ${leaseId}`, () => this.response(id) !== undefined);
  }

  async end(leaseId: string): Promise<void> {
    this.agent.receive({ type: 'lease.end', leaseId });
    await this.agent.idle();
  }
}

async function bench(run: (b: Bench) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'devicepool-agent-'));
  try {
    await run(new Bench(join(dir, 'phones')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function recordFiles(b: Bench): Promise<string[]> {
  return readdir(b.dir).catch(() => []);
}

test('a phone on USB is enrolled, leased, wiped and ready again', () =>
  bench(async (b) => {
    const fake = b.plug(A);
    await b.scan();
    await b.agent.idle();
    assert.deepEqual(b.devices().map((d) => [d.state, d.platform, d.model]), [['ready', 'android-device', 'Pixel 8a']]);

    await b.lease(A, 'lease-1', 1);
    assert.equal(b.response(1)?.ok, true);
    assert.equal(b.device(A)?.state, 'busy');
    assert.deepEqual(await recordFiles(b), [`${deviceIdFor(A)}.baseline.json`, `${deviceIdFor(A)}.touched.json`]);
    fake.useForALease();

    await b.end('lease-1');
    assert.equal(b.device(A)?.state, 'ready');
    assert.deepEqual([...fake.packages.keys()], ['com.example.kept']);
    assert.equal(fake.settings.get('global/stay_on_while_plugged_in'), '0');
    assert.deepEqual(await recordFiles(b), []);
  }));

test('one phone seen over USB and over the network is one device, and each phone adb may not open is listed', () =>
  bench(async (b) => {
    b.plug(A);
    b.attached.push('192.168.1.20:5555 device product:akita model:Pixel_8a', `adb-${A}-x7Kq2B._adb-tls-connect._tcp device model:Pixel_8a`);
    b.attached.push('???????????? no permissions usb:1-7', '???????????? no permissions usb:1-8');
    await b.scan();
    await b.agent.idle();

    assert.deepEqual(b.devices().map((d) => d.state).sort(), ['quarantined', 'quarantined', 'ready']);
    assert.equal(new Set(b.devices().map((d) => d.deviceId)).size, 3);
    assert.equal(b.logs.filter((l) => /Skipped 192\.168\.1\.20:5555: .*over USB only/.test(l)).length, 1);
    assert.equal(b.logs.filter((l) => l.includes(`Skipped adb-${A}-x7Kq2B._adb-tls-connect._tcp`)).length, 1);
    // The reason is logged once, not on every scan.
    await b.scan(2);
    assert.equal(b.logs.filter((l) => l.includes('Skipped')).length, 2);
  }));

test('a phone that is locked when a lease starts is left untouched, and the lease is told what to do', () =>
  bench(async (b) => {
    const fake = b.plug(A);
    await b.scan();
    await b.agent.idle();
    fake.calls = [];
    fake.ceAvailable = 'false';

    await b.lease(A, 'lease-1', 1);
    await b.agent.idle();

    const answer = b.response(1);
    assert.equal(answer?.ok, false);
    assert.match(answer?.ok === false ? answer.error.message : '', /storage is locked.*Unlock the phone once after a reboot/);
    assert.deepEqual(fake.changes(), []);
    assert.equal(b.device(A)?.state, 'ready');
    assert.deepEqual(await recordFiles(b), []);

    // A listing that find could not finish is refused the same way.
    fake.ceAvailable = '';
    fake.findExit = 1;
    await b.lease(A, 'lease-2', 2);
    await b.agent.idle();
    assert.equal(b.response(2)?.ok, false);
    assert.deepEqual(fake.changes(), []);
    assert.deepEqual(await recordFiles(b), []);

    // Once it is unlocked the same phone can be leased.
    fake.findExit = 0;
    await b.lease(A, 'lease-3', 3);
    assert.equal(b.response(3)?.ok, true);
  }));

test('a phone whose record on disk is damaged is quarantined with a note, never ready', () =>
  bench(async (b) => {
    const fake = b.plug(A);
    await mkdir(b.dir, { recursive: true });
    await writeFile(baselinePath(b.dir, deviceIdFor(A)), '{"packages":{"com.exa');
    await b.scan();
    await b.agent.idle();

    assert.equal(b.device(A)?.state, 'quarantined');
    assert.match(b.device(A)?.note ?? '', /record of this phone from before its last lease cannot be used.*delete the record.*plug it in again/);
    assert.deepEqual(fake.changes(), []);
    b.agent.receive({ type: 'lease.prepare', id: 1, leaseId: 'lease-1', deviceId: deviceIdFor(A), deadline: 0 });
    assert.equal(b.response(1)?.ok, false);
    // The damaged record stays for the operator to look at.
    assert.equal((await recordFiles(b)).length, 1);
  }));

test('a leased phone that drops off adb for two scans keeps its lease, and after three it has left', () =>
  bench(async (b) => {
    const fake = b.plug(A);
    await b.scan();
    await b.agent.idle();
    await b.lease(A, 'lease-1', 1);
    fake.useForALease();
    const line = b.attached[0] ?? '';
    fake.calls = [];

    b.unplug(A);
    await b.scan();
    b.attached = [`${A} offline usb:1-1`];
    await b.scan();
    assert.equal(b.device(A)?.state, 'busy');
    b.attached = [line];
    await b.scan();
    await b.agent.idle();
    assert.equal(b.device(A)?.state, 'busy');
    assert.deepEqual(fake.calls, [], 'the phone was not enrolled again or wiped');
    assert.equal(fake.packages.has('com.example.app'), true);

    b.unplug(A);
    await b.scan(2);
    assert.equal(b.device(A)?.state, 'busy');
    await b.scan();
    assert.equal(b.device(A), undefined);
    assert.deepEqual(b.heldLeases(), []);
  }));

test('a phone that comes back while its lease is open is not wiped until the lease ends', () =>
  bench(async (b) => {
    const fake = b.plug(A);
    await b.scan();
    await b.agent.idle();
    await b.lease(A, 'lease-1', 1);
    fake.useForALease();
    const line = b.attached[0] ?? '';
    b.unplug(A);
    await b.scan(3);
    assert.equal(b.device(A), undefined);
    fake.calls = [];

    b.attached = [line];
    await b.scan();
    await b.agent.idle();

    // The broker has not ended the lease, so the phone is still the lease's and is named in hello.
    assert.equal(b.device(A)?.state, 'busy');
    assert.deepEqual(b.heldLeases(), ['lease-1']);
    assert.deepEqual(fake.changes(), []);
    assert.equal(fake.packages.has('com.example.app'), true);

    await b.end('lease-1');
    assert.equal(b.device(A)?.state, 'ready');
    assert.equal(fake.packages.has('com.example.app'), false);
    assert.deepEqual(await recordFiles(b), []);
  }));

test('a phone that comes back after the broker ended its lease is wiped before it is ready', () =>
  bench(async (b) => {
    const fake = b.plug(A);
    await b.scan();
    await b.agent.idle();
    await b.lease(A, 'lease-1', 1);
    fake.useForALease();
    const line = b.attached[0] ?? '';
    b.unplug(A);
    await b.scan(3);
    b.agent.receive({ type: 'lease.end', leaseId: 'lease-1' });

    b.attached = [line];
    await b.scan();
    await b.agent.idle();
    assert.equal(b.device(A)?.state, 'ready');
    assert.equal(fake.packages.has('com.example.app'), false);
  }));

test('a lease that ends while the phone is being recorded waits, then wipes against the finished record', () =>
  bench(async (b) => {
    const fake = b.plug(A);
    await b.scan();
    await b.agent.idle();
    const release = fake.hold('shell find');

    b.agent.receive({ type: 'lease.prepare', id: 1, leaseId: 'lease-1', deviceId: deviceIdFor(A), deadline: Date.now() + 60_000 });
    await b.until('the listing to start', () => fake.calls.some((c) => c[1]?.startsWith('find ')));
    b.agent.receive({ type: 'lease.end', leaseId: 'lease-1' });
    await new Promise((r) => setImmediate(r));
    assert.equal(fake.calls.filter((c) => c[1]?.startsWith('find ')).length, 1, 'the wipe has not started');
    release();
    await b.agent.idle();

    assert.equal(b.sent.some((m) => (m.type === 'inventory' || m.type === 'hello') && m.devices.some((d) => d.state === 'quarantined')), false);
    assert.equal(b.device(A)?.state, 'ready');
    // Waking the phone set stay-awake, and the wipe that followed put it back.
    assert.equal(fake.calls.some((c) => c.join(' ') === 'shell svc power stayon usb'), true);
    assert.equal(fake.settings.get('global/stay_on_while_plugged_in'), '0');
    assert.deepEqual(await recordFiles(b), []);
  }));

test('a lease that ends before a failed recording leaves the phone ready and untouched', () =>
  bench(async (b) => {
    const fake = b.plug(A);
    await b.scan();
    await b.agent.idle();
    fake.calls = [];
    fake.findExit = 1;
    const release = fake.hold('shell find');
    b.agent.receive({ type: 'lease.prepare', id: 1, leaseId: 'lease-1', deviceId: deviceIdFor(A), deadline: Date.now() + 60_000 });
    b.agent.receive({ type: 'lease.end', leaseId: 'lease-1' });
    release();
    await b.agent.idle();
    assert.equal(b.response(1)?.ok, false);
    assert.equal(b.device(A)?.state, 'ready');
    assert.deepEqual(fake.changes(), []);
  }));

test('a long wipe on one phone does not hold up the scan or the other phones', () =>
  bench(async (b) => {
    const slow = b.plug(A);
    await saveBaseline(b.dir, deviceIdFor(A), await snapshot(slow.adb()));
    slow.useForALease();
    const release = slow.hold('shell find');

    await b.scan();
    await b.until('the slow phone to start its wipe', () => b.device(A)?.state === 'wiping');
    b.plug(B);
    await b.scan();
    await b.until('the second phone to be ready', () => b.device(B)?.state === 'ready');
    assert.equal(b.device(A)?.state, 'wiping');
    await b.lease(B, 'lease-b', 1);
    assert.equal(b.response(1)?.ok, true);

    release();
    await b.agent.idle();
    assert.equal(b.device(A)?.state, 'ready');
    assert.equal(slow.packages.has('com.example.app'), false);
  }));

test('an app is recorded as used by the lease, on disk, before it is launched', () =>
  bench(async (b) => {
    b.plug(A);
    await b.scan();
    await b.agent.idle();
    await b.lease(A, 'lease-1', 1);
    const touchedFile = join(b.dir, `${deviceIdFor(A)}.touched.json`);
    let onDisk = '';
    b.onLaunch = async () => {
      onDisk = await readFile(touchedFile, 'utf8');
    };

    b.agent.receive({ type: 'op', id: 2, leaseId: 'lease-1', body: { op: 'launch', bundleId: 'com.android.chrome' } });
    await b.until('the launch to answer', () => b.response(2) !== undefined);
    assert.equal(b.response(2)?.ok, true);
    assert.deepEqual(JSON.parse(onDisk), ['com.android.chrome']);

    // When the record cannot be written, the app is not launched.
    await rm(b.dir, { recursive: true });
    await writeFile(b.dir, 'not a folder');
    b.agent.receive({ type: 'op', id: 3, leaseId: 'lease-1', body: { op: 'launch', bundleId: 'com.example.kept' } });
    await b.until('the second launch to answer', () => b.response(3) !== undefined);
    assert.equal(b.response(3)?.ok, false);
    assert.deepEqual(b.launched, ['com.android.chrome']);
  }));

test('the wipe waits for an operation of the lease that is still running', () =>
  bench(async (b) => {
    const fake = b.plug(A);
    await b.scan();
    await b.agent.idle();
    await b.lease(A, 'lease-1', 1);
    let finish: (() => void) | null = null;
    b.onLaunch = () =>
      new Promise<void>((resolve) => {
        finish = (): void => {
          // The app lands on the phone only now, as an install that was still running would.
          fake.packages.set('com.example.late', '/data/app/~~l==/com.example.late-m==/base.apk');
          resolve();
        };
      });
    b.agent.receive({ type: 'op', id: 2, leaseId: 'lease-1', body: { op: 'launch', bundleId: 'com.example.late' } });
    await b.until('the launch to start', () => finish !== null);
    const reads = fake.calls.filter((c) => c[1]?.startsWith('find ')).length;

    b.agent.receive({ type: 'lease.end', leaseId: 'lease-1' });
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(fake.calls.filter((c) => c[1]?.startsWith('find ')).length, reads, 'the wipe has not read the phone yet');
    b.onLaunch = async () => {};
    b.agent.receive({ type: 'op', id: 3, leaseId: 'lease-1', body: { op: 'launch', bundleId: 'com.example.kept' } });
    await b.until('the late launch to be refused', () => b.response(3) !== undefined);
    assert.equal(b.response(3)?.ok, false, 'no operation starts once the lease has ended');
    (finish ?? assert.fail)();
    await b.agent.idle();
    assert.equal(b.device(A)?.state, 'ready');
    assert.equal(fake.packages.has('com.example.late'), false);
  }));
