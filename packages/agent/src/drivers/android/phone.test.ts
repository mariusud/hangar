import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakePhone } from './fake-phone.ts';
import {
  baselinePath, deviceIdFor, differences, dropBaseline, FIND, loadBaseline, parseDevices, parseFiles, parseListing, parsePackages, phoneChanges, planWipe,
  saveBaseline, saveTouched, snapshot, storageProblem, unusableReason, wipe, type PhoneState,
} from './phone.ts';

const SERIAL = '39051FDJH000AB';

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
    { serial: '39051FDJH000AB', state: 'device', model: 'Pixel 8a', transport: 'usb', usb: '338690048X' },
    { serial: 'R58M12ABCDE', state: 'unauthorized', model: null, transport: 'usb', usb: '338755584X' },
    { serial: 'ZY22F7', state: 'offline', model: null, transport: 'usb', usb: '1-1' },
    { serial: '0a388e93', state: 'no permissions', model: null, transport: 'usb', usb: '1-2' },
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

  const unplugged = phoneChanges(['A', 'B'], parseDevices('List of devices attached\nB offline\n'), new Map([['A', 2], ['B', 2]]));
  assert.deepEqual([unplugged.arrived, unplugged.left], [[], ['A', 'B']]);
  assert.equal(unplugged.unusable.has('B'), true);
});

test('a phone has left only after three scans in a row without it', () => {
  const gone = parseDevices('List of devices attached\n');
  const offline = parseDevices('List of devices attached\nA offline\n');
  const back = parseDevices('List of devices attached\nA device\n');

  const first = phoneChanges(['A'], gone);
  assert.deepEqual([first.left, [...first.misses]], [[], [['A', 1]]]);
  const second = phoneChanges(['A'], offline, first.misses);
  assert.deepEqual([second.left, [...second.misses]], [[], [['A', 2]]]);
  // One scan with the phone back starts the count again.
  const returned = phoneChanges(['A'], back, second.misses);
  assert.deepEqual([returned.left, returned.arrived, returned.misses.size], [[], [], 0]);
  const third = phoneChanges(['A'], gone, second.misses);
  assert.deepEqual([third.left, third.misses.size], [['A'], 0]);
});

test('one phone is one device: only USB serials are offered, and the others are named as skipped', () => {
  const seen = parseDevices(`List of devices attached
39051FDJH000AB         device usb:338690048X product:akita model:Pixel_8a device:akita transport_id:4
192.168.1.20:5555      device product:akita model:Pixel_8a device:akita transport_id:5
[fe80::1%en0]:5555     device product:akita model:Pixel_8a device:akita transport_id:6
adb-39051FDJH000AB-x7Kq2B._adb-tls-connect._tcp device product:akita model:Pixel_8a device:akita transport_id:7
`);
  assert.deepEqual(seen.map((s) => s.transport), ['usb', 'tcp', 'tcp', 'mdns']);
  const changes = phoneChanges([], seen);
  assert.deepEqual(changes.arrived, ['39051FDJH000AB']);
  assert.deepEqual([...changes.skipped.keys()], ['192.168.1.20:5555', '[fe80::1%en0]:5555', 'adb-39051FDJH000AB-x7Kq2B._adb-tls-connect._tcp']);
  assert.match(changes.skipped.get('192.168.1.20:5555') ?? '', /over USB only.*adb disconnect 192\.168\.1\.20:5555/);
});

test('phones adb may not open are reported one by one, though they share a serial of question marks', () => {
  const seen = parseDevices(`List of devices attached
????????????           no permissions (user in plugdev group; are your udev rules wrong?); see [http://developer.android.com/tools/device.html] usb:1-2
????????????           no permissions (user in plugdev group; are your udev rules wrong?); see [http://developer.android.com/tools/device.html] usb:1-3
????????????           no permissions
`);
  const changes = phoneChanges([], seen);
  assert.deepEqual(changes.arrived, []);
  assert.equal(changes.unusable.size, 3);
  assert.equal(new Set([...changes.unusable.keys()].map(deviceIdFor)).size, 3);
  assert.match([...changes.unusable.values()][0] ?? '', /may not open the USB device/);
});

test('two phones with the same serial are not offered, because adb cannot tell them apart', () => {
  const changes = phoneChanges([], parseDevices('List of devices attached\n0123456789ABCDEF device usb:1-1\n0123456789ABCDEF device usb:1-2\n'));
  assert.deepEqual(changes.arrived, []);
  assert.match(changes.unusable.get('0123456789ABCDEF') ?? '', /same serial/);
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
  assert.deepEqual(parseFiles(['/sdcard/', '/sdcard//Download', '/sdcard/Android', '/sdcard/Android/data/x', '/data/local/tmp/', '/etc/hosts', '']), ['/data/local/tmp', '/sdcard', '/sdcard/Download']);
});

test('a file listing is split on NUL, keeps every name as it is, and carries the exit status of find', () => {
  const listing = parseListing('/sdcard/\0/sdcard/Android\0/sdcard/DCIM\0/sdcard/DCIM \0/sdcard/a\n/sdcard/DCIM\0/sdcard/ lead\0devicepool-find-exit=0');
  assert.deepEqual(listing, { files: ['/sdcard', '/sdcard/ lead', '/sdcard/DCIM', '/sdcard/DCIM ', '/sdcard/a\n/sdcard/DCIM'].sort(), exit: 0, shared: 4 });
  assert.equal(parseListing('/sdcard/\0devicepool-find-exit=1').exit, 1);
  // A listing that stops before the status was printed has no status.
  assert.equal(parseListing('/sdcard/\0/sdcard/DCIM\0/sdcard/DC').exit, null);
  assert.equal(parseListing('').exit, null);
  assert.match(FIND, /-print0/);
  assert.doesNotMatch(FIND, /\|\| true/);
});

test('a listing is refused as a record when storage is locked, the listing failed, or /sdcard is empty', () => {
  const good = parseListing('/sdcard/\0/sdcard/DCIM\0/data/local/tmp/\0devicepool-find-exit=0');
  assert.equal(storageProblem('true\n', good), null);
  // A phone that does not set the property is accepted on the strength of the listing alone.
  assert.equal(storageProblem('\n', good), null);
  assert.match(storageProblem('false\n', good) ?? '', /locked.*Unlock the phone once after a reboot/);
  assert.match(storageProblem('true', { ...good, exit: 1 }) ?? '', /find exited with 1.*Unlock the phone once after a reboot/);
  assert.match(storageProblem('true', { ...good, exit: null }) ?? '', /ended early/);
  const empty = parseListing('/sdcard/\0/data/local/tmp/\0/data/local/tmp/x\0devicepool-find-exit=0');
  assert.match(storageProblem('', empty) ?? '', /looks empty.*Unlock the phone once after a reboot/);
  assert.match(storageProblem('true', empty) ?? '', /looks empty/);
});

test('a phone whose files cannot be listed in full gives no record, and nothing on it is changed', async () => {
  for (const breakIt of [(f: FakePhone): void => { f.findExit = 1; }, (f: FakePhone): void => { f.ceAvailable = 'false'; }, (f: FakePhone): void => { f.mounted = false; f.ceAvailable = ''; }]) {
    const fake = new FakePhone();
    breakIt(fake);
    await assert.rejects(snapshot(fake.adb()), /Unlock the phone once after a reboot/);
    assert.deepEqual(fake.changes(), []);
  }
});

test('a wipe whose read of the phone fails does not delete what a full record lists, and is not verified', async () => {
  const fake = new FakePhone();
  const baseline = await snapshot(fake.adb());
  fake.useForALease();
  // The phone restarted during the lease and is locked: find lists almost nothing.
  fake.findExit = 1;
  await assert.rejects(wipe(fake.adb(), baseline, []), /find exited with 1/);
  assert.equal(fake.files.has('/sdcard/DCIM/holiday.jpg'), true);
  assert.equal(fake.calls.some((c) => c.join(' ').startsWith('shell rm ')), false);

  // The other way round: a record made from a partial listing would have marked the owner's photos as the lease's.
  const partial: PhoneState = { ...baseline, files: ['/data/local/tmp', '/sdcard'] };
  fake.findExit = 0;
  const steps = planWipe(partial, await snapshot(fake.adb()), []);
  assert.equal(steps.some((s) => s.do === 'remove' && s.paths.includes('/sdcard/DCIM')), true, 'which is why such a record must never be made');
});

test('a name with a newline or a trailing space is removed as itself or not at all, never as another path', async () => {
  const fake = new FakePhone();
  fake.files.add('/sdcard/Pictures');
  fake.files.add('/sdcard/Pictures/own.jpg');
  const baseline = await snapshot(fake.adb());
  // The lease makes a folder whose name ends in a space, and a file whose name holds a newline followed by a path of the owner.
  fake.files.add('/sdcard/Pictures ');
  fake.files.add('/sdcard/Pictures /lease.jpg');
  fake.files.add('/sdcard/x\n');
  fake.files.add('/sdcard/x\n/sdcard');
  fake.files.add('/sdcard/x\n/sdcard/Pictures');
  fake.files.add('/sdcard/bad\ufffdname');

  const removed = planWipe(baseline, await snapshot(fake.adb()), []).flatMap((s) => (s.do === 'remove' ? s.paths : []));
  assert.deepEqual(removed, ['/sdcard/Pictures ']);

  const result = await wipe(fake.adb(), baseline, []);
  assert.equal(fake.files.has('/sdcard/Pictures/own.jpg'), true);
  assert.equal(fake.files.has('/sdcard/Pictures /lease.jpg'), false);
  assert.equal(fake.calls.some((c) => c.join(' ').includes(String.raw`'/sdcard/Pictures '`)), true);
  assert.equal(fake.calls.filter((c) => c.join(' ').startsWith('shell rm ')).some((c) => /'\/sdcard\/Pictures'/.test(c.join(' '))), false);
  // The names that are not handed to rm stay, and the phone is not ready.
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0] ?? '', /4 files have names with control characters or bytes that are not UTF-8.*delete them on the phone/);
});

test('a wipe takes a phone back to its baseline and the read-back agrees', async () => {
  const fake = new FakePhone();
  const baseline = await snapshot(fake.adb());
  fake.useForALease();

  const result = await wipe(fake.adb(), baseline, ['com.example.app', 'com.android.chrome', 'com.example.kept']);

  assert.deepEqual(result, { ok: true, problems: [] });
  assert.deepEqual(await snapshot(fake.adb()), baseline);
  assert.deepEqual([...fake.packages.keys()], ['com.example.kept']);
  assert.equal(fake.files.has('/sdcard/DCIM/holiday.jpg'), true);
  // Chrome and the kept app were on the phone before the lease, so their data is the owner's and stays.
  assert.deepEqual(fake.cleared, []);
  assert.equal(fake.calls.some((c) => c.join(' ').startsWith('shell pm clear')), false);
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

test('the data of an app from before the lease is never cleared, and an app the lease removed itself needs no clearing', async () => {
  const fake = new FakePhone();
  const baseline = await snapshot(fake.adb());
  // The lease installed and launched its app, then uninstalled it again, and launched the system browser.
  const current = await snapshot(fake.adb());
  const touched = ['com.example.app', 'com.android.chrome', 'com.example.kept'];
  assert.deepEqual(planWipe(baseline, current, touched).filter((s) => s.do === 'clear' || s.do === 'stop'), []);
  assert.deepEqual(await wipe(fake.adb(), baseline, touched), { ok: true, problems: [] });

  // A package that is new, is not third-party and so cannot be uninstalled, and is still there, is cleared.
  fake.system.push('com.vendor.preload');
  const steps = planWipe(baseline, await snapshot(fake.adb()), ['com.vendor.preload', 'com.android.chrome']);
  assert.deepEqual(steps.filter((s) => s.do === 'clear'), [{ do: 'clear', pkg: 'com.vendor.preload' }]);
});

test('a setting in the record that Devicepool does not manage fails the wipe and never reaches adb', async () => {
  const fake = new FakePhone();
  const baseline = await snapshot(fake.adb());
  fake.useForALease();
  const calls = fake.calls.length;
  const tampered: PhoneState = { ...baseline, settings: { ...baseline.settings, 'global/x;reboot': '1', 'secure/install_non_market_apps': '1' } };

  const result = await wipe(fake.adb(), tampered, []);

  assert.equal(result.ok, false);
  assert.match(result.problems.join('\n'), /settings Devicepool does not manage \("global\/x;reboot", "secure\/install_non_market_apps"\)/);
  assert.equal(fake.calls.length, calls);
  assert.equal(planWipe(tampered, await snapshot(fake.adb()), []).some((s) => s.do === 'setting' && !(s.key in baseline.settings)), false);
});

test('a phone without the night mode command is recorded and wiped without that setting', async () => {
  const fake = new FakePhone();
  fake.hasNightCommand = false;
  const baseline = await snapshot(fake.adb());
  assert.equal('uimode/night' in baseline.settings, false);
  assert.equal(Object.keys(baseline.settings).length, 6);
  fake.useForALease();
  assert.deepEqual(await wipe(fake.adb(), baseline, []), { ok: true, problems: [] });
  assert.equal(fake.calls.some((c) => c.join(' ').startsWith('shell cmd uimode night ')), false);
});

test('a phone that does not match its baseline after the wipe says why', async () => {
  const fake = new FakePhone();
  const baseline = await snapshot(fake.adb());
  fake.useForALease();
  fake.locked.add('dev.mobile.maestro');
  // A package that appeared during the lease, cannot be uninstalled, and refuses to be cleared.
  fake.system.push('com.vendor.preload');
  fake.locked.add('com.vendor.preload');
  // The lease installed over an app from the baseline, and removed another.
  fake.packages.set('com.example.kept', '/data/app/~~new==/com.example.kept-z==/base.apk');

  const result = await wipe(fake.adb(), baseline, ['com.vendor.preload']);

  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 3);
  assert.match(result.problems.join('\n'), /data of com\.vendor\.preload could not be cleared/);
  assert.match(result.problems.join('\n'), /com\.example\.kept was installed again during the lease/);
  assert.match(result.problems.join('\n'), /dev\.mobile\.maestro could not be uninstalled/);
});

test('differences name packages, files, settings and port mappings', () => {
  const baseline: PhoneState = { packages: { 'com.a': '/p1' }, installed: ['com.a'], files: ['/sdcard/a'], settings: { 'uimode/night': 'no' }, reverses: [], forwards: [] };
  assert.deepEqual(differences(baseline, baseline), []);
  const after: PhoneState = { packages: {}, installed: [], files: ['/sdcard/a', '/sdcard/b'], settings: { 'uimode/night': 'yes' }, reverses: ['tcp:8081 tcp:8081'], forwards: ['tcp:1 tcp:2'] };
  assert.equal(differences(baseline, after).length, 5);
});

test('the baseline of an open lease survives on disk until the wipe is verified', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devicepool-phones-'));
  try {
    const fake = new FakePhone();
    const baseline = await snapshot(fake.adb());
    assert.deepEqual(await loadBaseline(dir, 'phone-1'), { status: 'none' });
    await saveBaseline(join(dir, 'nested'), 'phone-1', baseline);
    await saveTouched(join(dir, 'nested'), 'phone-1', ['com.example.app']);
    assert.deepEqual(await loadBaseline(join(dir, 'nested'), 'phone-1'), { status: 'ok', baseline, touched: ['com.example.app'] });
    await dropBaseline(join(dir, 'nested'), 'phone-1');
    assert.deepEqual(await loadBaseline(join(dir, 'nested'), 'phone-1'), { status: 'none' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a record that is there but cannot be used is reported as invalid, not as no record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devicepool-phones-'));
  try {
    const baseline = await snapshot(new FakePhone().adb());
    for (const damaged of ['', '{"packages":{', '[]', JSON.stringify({ ...baseline, files: 'none' }), JSON.stringify({ ...baseline, installed: undefined })]) {
      await saveBaseline(dir, 'phone-1', baseline);
      await writeFile(baselinePath(dir, 'phone-1'), damaged);
      const stored = await loadBaseline(dir, 'phone-1');
      assert.equal(stored.status, 'invalid', `for ${JSON.stringify(damaged)}`);
    }
    // The list of touched apps is part of the record.
    await saveBaseline(dir, 'phone-1', baseline);
    await writeFile(join(dir, 'phone-1.touched.json'), '["com.exa');
    assert.equal((await loadBaseline(dir, 'phone-1')).status, 'invalid');
    await rm(join(dir, 'phone-1.touched.json'));
    assert.equal((await loadBaseline(dir, 'phone-1')).status, 'invalid');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the record is replaced by a rename, so a crash never leaves half a file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devicepool-phones-'));
  try {
    const baseline = await snapshot(new FakePhone().adb());
    await saveBaseline(dir, 'phone-1', baseline);
    const before = await stat(join(dir, 'phone-1.touched.json'));
    await saveTouched(dir, 'phone-1', ['com.example.app']);
    const after = await stat(join(dir, 'phone-1.touched.json'));
    // Writing in place keeps the inode; a new file renamed over the old one does not.
    assert.notEqual(after.ino, before.ino);
    assert.deepEqual((await readdir(dir)).sort(), ['phone-1.baseline.json', 'phone-1.touched.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
