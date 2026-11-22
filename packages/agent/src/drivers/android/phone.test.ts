import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adb } from './index.ts';
import { deviceIdFor, differences, dropBaseline, loadBaseline, parseDevices, parseFiles, parsePackages, phoneChanges, planWipe, saveBaseline, saveTouched, snapshot, unusableReason, wipe, type PhoneState } from './phone.ts';

const SERIAL = '39051FDJH000AB';

// A phone that answers the adb calls the wipe makes, and keeps its state in memory.
class FakePhone {
  packages = new Map<string, string>([['com.example.kept', '/data/app/~~a==/com.example.kept-b==/base.apk']]);
  files = new Set(['/sdcard', '/sdcard/DCIM', '/sdcard/DCIM/holiday.jpg', '/data/local/tmp']);
  settings = new Map<string, string>([
    ['global/window_animation_scale', '1.0'],
    ['global/transition_animation_scale', '1.0'],
    ['global/animator_duration_scale', '1.0'],
    ['global/stay_on_while_plugged_in', '0'],
    ['system/accelerometer_rotation', '1'],
    ['system/user_rotation', '0'],
  ]);
  night = 'no';
  reverses: string[] = [];
  forwards: string[] = [];
  cleared: string[] = [];
  locked = new Set<string>();
  calls: string[][] = [];

  adb(): Adb {
    return { serial: SERIAL, run: async (...args) => this.run(args) };
  }

  private run(args: string[]): string {
    this.calls.push(args);
    const line = args.join(' ');
    if (line === 'shell pm list packages -3 -f') {
      return [...this.packages].map(([pkg, path]) => `package:${path}=${pkg}`).join('\n');
    }
    if (line.startsWith('shell find ')) {
      return ['/sdcard/Android/data/com.example.kept/cache', ...this.files].join('\n');
    }
    if (line.startsWith('shell settings get ')) {
      return `${this.settings.get(`${args[3]}/${args[4]}`) ?? 'null'}\n`;
    }
    if (line.startsWith('shell settings put ')) {
      this.settings.set(`${args[3]}/${args[4]}`, args[5] ?? '');
      return '';
    }
    if (line.startsWith('shell settings delete ')) {
      this.settings.delete(`${args[3]}/${args[4]}`);
      return '';
    }
    if (line === 'shell cmd uimode night') {
      return `Night mode: ${this.night}\n`;
    }
    if (line.startsWith('shell cmd uimode night ')) {
      this.night = args[4] ?? '';
      return '';
    }
    if (line === 'reverse --list') {
      return this.reverses.map((r) => `UsbFfs ${r}`).join('\n');
    }
    if (line === 'forward --list') {
      return [...this.forwards.map((f) => `${SERIAL} ${f}`), 'emulator-5600 tcp:7001 tcp:7001'].join('\n');
    }
    if (line.startsWith('reverse --remove ')) {
      this.reverses = this.reverses.filter((r) => !r.startsWith(`${args[2]} `));
      return '';
    }
    if (line.startsWith('forward --remove ')) {
      this.forwards = this.forwards.filter((f) => !f.startsWith(`${args[2]} `));
      return '';
    }
    if (line.startsWith('uninstall ')) {
      if (this.locked.has(args[1] ?? '')) {
        throw new Error('Failure [DELETE_FAILED_DEVICE_POLICY_MANAGER]');
      }
      this.packages.delete(args[1] ?? '');
      return 'Success';
    }
    if (line.startsWith('shell pm clear ')) {
      if (this.locked.has(args[3] ?? '')) {
        return 'Failed';
      }
      this.cleared.push(args[3] ?? '');
      return 'Success';
    }
    if (line.startsWith('shell rm -rf -- ')) {
      for (const m of line.matchAll(/'((?:[^']|'\\'')*)'/g)) {
        const path = (m[1] ?? '').replaceAll(String.raw`'\''`, "'");
        for (const f of [...this.files]) {
          if (f === path || f.startsWith(`${path}/`)) {
            this.files.delete(f);
          }
        }
      }
      return '';
    }
    if (line.startsWith('shell am force-stop ') || line.startsWith('shell input keyevent ')) {
      return '';
    }
    throw new Error(`The fake phone does not know: adb ${line}`);
  }

  // What a lease typically leaves behind.
  useForALease(): void {
    this.packages.set('com.example.app', '/data/app/~~c==/com.example.app-d==/base.apk');
    this.packages.set('dev.mobile.maestro', '/data/app/~~e==/dev.mobile.maestro-f==/base.apk');
    this.files.add('/sdcard/Download');
    this.files.add('/sdcard/Download/report.pdf');
    this.files.add('/sdcard/Movies');
    this.files.add('/sdcard/Movies/run');
    this.files.add('/sdcard/Movies/run/clip.mp4');
    this.files.add("/data/local/tmp/it's.xml");
    this.settings.set('system/accelerometer_rotation', '0');
    this.settings.set('system/user_rotation', '1');
    this.settings.set('global/stay_on_while_plugged_in', '2');
    this.settings.set('global/animator_duration_scale', '0');
    this.night = 'yes';
    this.reverses.push('tcp:8081 tcp:51234');
    this.forwards.push('tcp:7001 tcp:7001');
  }
}

test('adb devices lists phones with their state, and leaves emulators out', () => {
  const out = `* daemon started successfully
List of devices attached
emulator-5600          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
39051FDJH000AB         device usb:338690048X product:akita model:Pixel_8a device:akita transport_id:4
R58M12ABCDE            unauthorized usb:338755584X transport_id:5
ZY22F7                 offline usb:1-1 transport_id:6
0a388e93               no permissions (user in plugdev group; are your udev rules wrong?); see [http://developer.android.com/tools/device.html] usb:1-2

`;
  assert.deepEqual(parseDevices(out), [
    { serial: '39051FDJH000AB', state: 'device', model: 'Pixel 8a' },
    { serial: 'R58M12ABCDE', state: 'unauthorized', model: null },
    { serial: 'ZY22F7', state: 'offline', model: null },
    { serial: '0a388e93', state: 'no permissions', model: null },
  ]);
});

test('a phone that cannot be used comes with what to do about it', () => {
  assert.match(unusableReason('unauthorized') ?? '', /accept the USB debugging prompt/);
  assert.match(unusableReason('offline') ?? '', /Unplug it and plug it in again/);
  assert.match(unusableReason('recovery') ?? '', /recovery mode/);
  assert.equal(unusableReason('authorizing'), null);
});

test('phones arrive, leave and wait for the operator as adb lists them', () => {
  const seen = parseDevices('List of devices attached\nA device\nB unauthorized\nC authorizing\n');
  const first = phoneChanges([], seen);
  assert.deepEqual(first.arrived, ['A']);
  assert.deepEqual(first.left, []);
  assert.deepEqual([...first.unusable.keys()], ['B']);

  const accepted = phoneChanges(['A'], parseDevices('List of devices attached\nA device\nB device\n'));
  assert.deepEqual([accepted.arrived, accepted.left, accepted.unusable.size], [['B'], [], 0]);

  const unplugged = phoneChanges(['A', 'B'], parseDevices('List of devices attached\nB offline\n'));
  assert.deepEqual([unplugged.arrived, unplugged.left], [[], ['A', 'B']]);
  assert.equal(unplugged.unusable.has('B'), true);
});

test('a device id is stable and does not show the serial', () => {
  assert.equal(deviceIdFor(SERIAL), deviceIdFor(SERIAL));
  assert.notEqual(deviceIdFor(SERIAL), deviceIdFor('other'));
  assert.equal(deviceIdFor(SERIAL).includes(SERIAL), false);
});

test('package and file listings are parsed', () => {
  assert.deepEqual(parsePackages('package:/data/app/~~x==/com.a-y==/base.apk=com.a\npackage:/data/app/com.b-1/base.apk=com.b\n\n'), {
    'com.a': '/data/app/~~x==/com.a-y==/base.apk',
    'com.b': '/data/app/com.b-1/base.apk',
  });
  assert.deepEqual(parseFiles('/sdcard/\n/sdcard//Download\n/sdcard/Android\n/sdcard/Android/data/x\n/data/local/tmp/\n/etc/hosts\n'), ['/data/local/tmp', '/sdcard', '/sdcard/Download']);
});

test('a wipe takes a phone back to its baseline and the read-back agrees', async () => {
  const fake = new FakePhone();
  const baseline = await snapshot(fake.adb());
  fake.useForALease();

  const result = await wipe(fake.adb(), baseline, ['com.example.app', 'com.android.chrome']);

  assert.deepEqual(result, { ok: true, problems: [] });
  assert.deepEqual(await snapshot(fake.adb()), baseline);
  assert.deepEqual([...fake.packages.keys()], ['com.example.kept']);
  assert.equal(fake.files.has('/sdcard/DCIM/holiday.jpg'), true);
  // Chrome stays on the phone, so its data is cleared; the lease's own app went with its uninstall.
  assert.deepEqual(fake.cleared, ['com.android.chrome']);
  assert.deepEqual(fake.forwards, []);
  assert.deepEqual(fake.reverses, []);
});

test('the wipe removes a folder once, quotes names, and never touches the baseline', async () => {
  const fake = new FakePhone();
  const baseline = await snapshot(fake.adb());
  fake.useForALease();
  const steps = planWipe(baseline, await snapshot(fake.adb()), []);
  const removed = steps.flatMap((s) => (s.do === 'remove' ? s.paths : []));
  assert.deepEqual(removed, ["/data/local/tmp/it's.xml", '/sdcard/Download', '/sdcard/Movies']);
  assert.equal(steps.some((s) => (s.do === 'uninstall' || s.do === 'clear') && s.pkg === 'com.example.kept'), false);
  await wipe(fake.adb(), baseline, []);
  assert.equal(fake.calls.some((c) => c.join(' ').includes(String.raw`'/data/local/tmp/it'\''s.xml'`)), true);
});

test('a phone that does not match its baseline after the wipe says why', async () => {
  const fake = new FakePhone();
  const baseline = await snapshot(fake.adb());
  fake.useForALease();
  fake.locked.add('dev.mobile.maestro');
  fake.locked.add('com.android.chrome');
  // The lease installed over an app from the baseline, and removed another.
  fake.packages.set('com.example.kept', '/data/app/~~new==/com.example.kept-z==/base.apk');

  const result = await wipe(fake.adb(), baseline, ['com.android.chrome']);

  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 3);
  assert.match(result.problems.join('\n'), /data of com\.android\.chrome could not be cleared/);
  assert.match(result.problems.join('\n'), /com\.example\.kept was installed again during the lease/);
  assert.match(result.problems.join('\n'), /dev\.mobile\.maestro could not be uninstalled/);
});

test('differences name packages, files, settings and port mappings', () => {
  const baseline: PhoneState = { packages: { 'com.a': '/p1' }, files: ['/sdcard/a'], settings: { 'uimode/night': 'no' }, reverses: [], forwards: [] };
  assert.deepEqual(differences(baseline, baseline), []);
  const after: PhoneState = { packages: {}, files: ['/sdcard/a', '/sdcard/b'], settings: { 'uimode/night': 'yes' }, reverses: ['tcp:8081 tcp:8081'], forwards: ['tcp:1 tcp:2'] };
  assert.equal(differences(baseline, after).length, 5);
});

test('the baseline of an open lease survives on disk until the wipe is verified', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devicepool-phones-'));
  try {
    const fake = new FakePhone();
    const baseline = await snapshot(fake.adb());
    assert.equal(await loadBaseline(dir, 'phone-1'), null);
    await saveBaseline(join(dir, 'nested'), 'phone-1', baseline);
    await saveTouched(join(dir, 'nested'), 'phone-1', ['com.example.app']);
    assert.deepEqual(await loadBaseline(join(dir, 'nested'), 'phone-1'), { baseline, touched: ['com.example.app'] });
    await dropBaseline(join(dir, 'nested'), 'phone-1');
    assert.equal(await loadBaseline(join(dir, 'nested'), 'phone-1'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
