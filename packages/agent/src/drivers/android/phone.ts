import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkPackage, deviceList, shellQuote, type Adb } from './index.ts';

// A phone cannot be deleted and cloned like an emulator, so its wipe undoes what a lease did
// and then reads the phone back. Decision 0015 says what this covers and what it does not.

export type Sighting = { serial: string; state: string; model: string | null };

const STATES = ['device', 'unauthorized', 'offline', 'no permissions', 'authorizing', 'connecting', 'recovery', 'sideload', 'bootloader', 'rescue', 'host'];

/** The phones in `adb devices -l`: every serial that is not an emulator's. */
export function parseDevices(out: string): Sighting[] {
  const seen: Sighting[] = [];
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(.+)$/.exec(line.trim());
    if (!m || line.startsWith('*') || line.startsWith('List of devices') || /^emulator-\d+$/.test(m[1] ?? '')) {
      continue;
    }
    const rest = m[2] ?? '';
    const state = STATES.find((s) => rest === s || rest.startsWith(`${s} `)) ?? rest.split(/\s+/)[0] ?? '';
    seen.push({ serial: m[1] ?? '', state, model: /\bmodel:(\S+)/.exec(rest)?.[1]?.replace(/_/g, ' ') ?? null });
  }
  return seen;
}

export async function listPhones(): Promise<Sighting[]> {
  return parseDevices(await deviceList());
}

/** What to do about a phone adb lists but cannot use, or null while adb is still connecting to it. */
export function unusableReason(state: string): string | null {
  if (state === 'authorizing' || state === 'connecting') {
    return null;
  }
  if (state === 'unauthorized') {
    return 'This Mac is not allowed to debug the phone. Unlock the phone, accept the USB debugging prompt and tick "Always allow from this computer".';
  }
  if (state === 'offline') {
    return 'adb sees the phone but cannot talk to it. Unplug it and plug it in again. If that does not help, run `adb kill-server` and try another cable.';
  }
  if (state === 'no permissions') {
    return 'This user may not open the USB device. Close other programs that use adb, then unplug the phone and plug it in again.';
  }
  return `The phone is in ${state} mode. Restart it normally with USB debugging on.`;
}

export type PhoneChanges = { arrived: string[]; left: string[]; unusable: Map<string, string> };

/** Compares the phones the agent knows with what adb lists now. A known phone that is no longer in state `device` has left. */
export function phoneChanges(known: Iterable<string>, seen: Sighting[]): PhoneChanges {
  const usable = new Set(seen.filter((s) => s.state === 'device').map((s) => s.serial));
  const knownSet = new Set(known);
  const unusable = new Map<string, string>();
  for (const s of seen) {
    const reason = s.state === 'device' ? null : unusableReason(s.state);
    if (reason) {
      unusable.set(s.serial, reason);
    }
  }
  return { arrived: [...usable].filter((s) => !knownSet.has(s)), left: [...knownSet].filter((s) => !usable.has(s)), unusable };
}

/** A device id that stays the same when the agent restarts and does not show the serial. */
export function deviceIdFor(serial: string): string {
  return `phone-${createHash('sha256').update(serial).digest('hex').slice(0, 12)}`;
}

export type PhoneState = {
  /** Third-party package name to the path of its APK, which changes whenever the package is installed again. */
  packages: Record<string, string>;
  /** Everything under shared storage and /data/local/tmp, apart from /sdcard/Android. */
  files: string[];
  settings: Record<string, string>;
  /** `adb reverse` mappings, as "device-spec host-spec". */
  reverses: string[];
  /** `adb forward` mappings of this phone, as "host-spec device-spec". */
  forwards: string[];
};

// Settings a lease can change through Devicepool: orientation, appearance, stay-awake at lease start,
// and the animation scales that test runners turn off.
const SETTINGS: [namespace: string, key: string][] = [
  ['global', 'window_animation_scale'],
  ['global', 'transition_animation_scale'],
  ['global', 'animator_duration_scale'],
  ['global', 'stay_on_while_plugged_in'],
  ['system', 'accelerometer_rotation'],
  ['system', 'user_rotation'],
];
const NIGHT = 'uimode/night';

const FILE_ROOTS = ['/sdcard/', '/data/local/tmp/'];
// App-private folders under /sdcard/Android go away with their package and cannot all be read by adb.
const SKIPPED = '/sdcard/Android';
const FIND = `find ${FILE_ROOTS.join(' ')} -path ${SKIPPED} -prune -o -print 2>/dev/null || true`;

export function parsePackages(out: string): Record<string, string> {
  const packages: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const entry = line.trim().replace(/^package:/, '');
    const at = entry.lastIndexOf('=');
    if (at > 0) {
      packages[entry.slice(at + 1)] = entry.slice(0, at);
    }
  }
  return packages;
}

export function parseFiles(out: string): string[] {
  const files = new Set<string>();
  for (const line of out.split('\n')) {
    const path = line.trim().replace(/\/{2,}/g, '/').replace(/\/$/, '');
    if (path && path !== SKIPPED && !path.startsWith(`${SKIPPED}/`) && FILE_ROOTS.some((root) => `${path}/`.startsWith(root))) {
      files.add(path);
    }
  }
  return [...files].sort();
}

function lines(out: string): string[][] {
  return out.split('\n').map((l) => l.trim().split(/\s+/)).filter((t) => t.length >= 3);
}

export async function snapshot(adb: Adb): Promise<PhoneState> {
  const settings: Record<string, string> = {};
  for (const [namespace, key] of SETTINGS) {
    settings[`${namespace}/${key}`] = (await adb.run('shell', 'settings', 'get', namespace, key)).trim();
  }
  settings[NIGHT] = /Night mode: (\w+)/.exec(await adb.run('shell', 'cmd', 'uimode', 'night'))?.[1] ?? '';
  return {
    packages: parsePackages(await adb.run('shell', 'pm', 'list', 'packages', '-3', '-f')),
    files: parseFiles(await adb.run('shell', FIND)),
    settings,
    reverses: lines(await adb.run('reverse', '--list')).map((t) => `${t[1]} ${t[2]}`),
    forwards: lines(await adb.run('forward', '--list')).filter((t) => t[0] === adb.serial).map((t) => `${t[1]} ${t[2]}`),
  };
}

/** Wakes the phone for a lease and keeps its screen on while it is plugged in. The wipe puts the setting back. */
export async function wake(adb: Adb): Promise<void> {
  await adb.run('shell', 'input', 'keyevent', '224');
  await adb.run('shell', 'svc', 'power', 'stayon', 'usb');
  await adb.run('shell', 'wm', 'dismiss-keyguard').catch(() => {});
}

export type WipeStep =
  | { do: 'unforward'; spec: string }
  | { do: 'unreverse'; spec: string }
  | { do: 'stop'; pkg: string }
  | { do: 'uninstall'; pkg: string }
  | { do: 'clear'; pkg: string }
  | { do: 'remove'; paths: string[] }
  | { do: 'setting'; key: string; value: string }
  | { do: 'home' };

function removable(path: string): boolean {
  return FILE_ROOTS.some((root) => path.startsWith(root) && path.length > root.length) && !path.split('/').includes('..') && !/[\n\r\0]/.test(path);
}

/** The steps that take a phone from `current` back to `baseline`. `touched` are packages the lease installed or launched through Devicepool. */
export function planWipe(baseline: PhoneState, current: PhoneState, touched: Iterable<string>): WipeStep[] {
  const steps: WipeStep[] = [];
  for (const spec of current.forwards.filter((f) => !baseline.forwards.includes(f))) {
    steps.push({ do: 'unforward', spec: spec.split(' ')[0] ?? '' });
  }
  for (const spec of current.reverses.filter((r) => !baseline.reverses.includes(r))) {
    steps.push({ do: 'unreverse', spec: spec.split(' ')[0] ?? '' });
  }
  const added = Object.keys(current.packages).filter((pkg) => !(pkg in baseline.packages));
  for (const pkg of added) {
    steps.push({ do: 'stop', pkg }, { do: 'uninstall', pkg });
  }
  // A package the lease used that stays on the phone, such as a browser, keeps no data from the lease.
  for (const pkg of new Set(touched)) {
    if (!added.includes(pkg)) {
      steps.push({ do: 'stop', pkg }, { do: 'clear', pkg });
    }
  }
  const before = new Set(baseline.files);
  const roots: string[] = [];
  for (const path of current.files.filter((f) => !before.has(f) && removable(f)).sort()) {
    if (!roots.some((root) => path.startsWith(`${root}/`))) {
      roots.push(path);
    }
  }
  for (let i = 0; i < roots.length; i += 50) {
    steps.push({ do: 'remove', paths: roots.slice(i, i + 50) });
  }
  for (const [key, value] of Object.entries(baseline.settings)) {
    if (current.settings[key] !== value) {
      steps.push({ do: 'setting', key, value });
    }
  }
  steps.push({ do: 'home' });
  return steps;
}

async function apply(adb: Adb, step: WipeStep): Promise<void> {
  switch (step.do) {
    case 'unforward':
      await adb.run('forward', '--remove', step.spec);
      return;
    case 'unreverse':
      await adb.run('reverse', '--remove', step.spec);
      return;
    case 'stop':
      await adb.run('shell', 'am', 'force-stop', checkPackage(step.pkg));
      return;
    case 'uninstall':
      await adb.run('uninstall', checkPackage(step.pkg));
      return;
    case 'clear': {
      const out = await adb.run('shell', 'pm', 'clear', checkPackage(step.pkg));
      if (!/^Success/m.test(out)) {
        throw new Error(`pm clear ${step.pkg} answered "${out.trim()}"`);
      }
      return;
    }
    case 'remove':
      await adb.run('shell', `rm -rf -- ${step.paths.filter(removable).map(shellQuote).join(' ')}`);
      return;
    case 'setting': {
      if (step.key === NIGHT) {
        if (/^[a-z_]+$/.test(step.value)) {
          await adb.run('shell', 'cmd', 'uimode', 'night', step.value);
        }
        return;
      }
      const [namespace = '', key = ''] = step.key.split('/');
      if (step.value === 'null' || step.value === '') {
        await adb.run('shell', 'settings', 'delete', namespace, key);
      } else if (/^[\w.-]+$/.test(step.value)) {
        await adb.run('shell', 'settings', 'put', namespace, key, step.value);
      }
      return;
    }
    case 'home':
      await adb.run('shell', 'input', 'keyevent', '3');
      return;
  }
}

/** What still differs from the baseline, as sentences for the operator. Empty means the phone matches. */
export function differences(baseline: PhoneState, after: PhoneState): string[] {
  const found: string[] = [];
  for (const [pkg, path] of Object.entries(baseline.packages)) {
    if (!(pkg in after.packages)) {
      found.push(`${pkg} was on the phone before the lease and is gone; install it again`);
    } else if (after.packages[pkg] !== path) {
      found.push(`${pkg} was installed again during the lease, so it is not the app the phone started with; install the earlier version again`);
    }
  }
  for (const pkg of Object.keys(after.packages)) {
    if (!(pkg in baseline.packages)) {
      found.push(`${pkg} could not be uninstalled; remove it on the phone`);
    }
  }
  const before = new Set(baseline.files);
  const left = after.files.filter((f) => !before.has(f));
  if (left.length) {
    found.push(`${left.length} file${left.length === 1 ? '' : 's'} from the lease could not be removed, such as ${left.slice(0, 3).join(', ')}`);
  }
  for (const [key, value] of Object.entries(baseline.settings)) {
    if (after.settings[key] !== value) {
      found.push(`the setting ${key} is ${after.settings[key] || 'unset'} and was ${value || 'unset'}`);
    }
  }
  for (const spec of after.reverses.filter((r) => !baseline.reverses.includes(r))) {
    found.push(`the reverse port mapping ${spec} is still open`);
  }
  for (const spec of after.forwards.filter((f) => !baseline.forwards.includes(f))) {
    found.push(`the forward port mapping ${spec} is still open`);
  }
  return found;
}

export type WipeResult = { ok: boolean; problems: string[] };

/**
 * Undoes a lease on a phone, then reads the phone back and compares it with the baseline.
 * A step that fails does not stop the wipe; the read-back decides. A failed `pm clear` counts on its own,
 * because app data cannot be read back without root.
 */
export async function wipe(adb: Adb, baseline: PhoneState, touched: Iterable<string>): Promise<WipeResult> {
  const problems: string[] = [];
  for (const step of planWipe(baseline, await snapshot(adb), touched)) {
    try {
      await apply(adb, step);
    } catch (err) {
      if (step.do === 'clear') {
        problems.push(`the data of ${step.pkg} could not be cleared (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }
  problems.push(...differences(baseline, await snapshot(adb)));
  return { ok: problems.length === 0, problems };
}

function isRecord(v: unknown): v is Record<string, string> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
}

function isStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isPhoneState(v: unknown): v is PhoneState {
  return (
    typeof v === 'object' && v !== null &&
    'packages' in v && isRecord(v.packages) &&
    'files' in v && isStrings(v.files) &&
    'settings' in v && isRecord(v.settings) &&
    'reverses' in v && isStrings(v.reverses) &&
    'forwards' in v && isStrings(v.forwards)
  );
}

// The baseline of an open lease is kept on disk, so a phone whose lease outlived the agent is
// still wiped against it when the agent sees the phone again.
export type Stored = { baseline: PhoneState; touched: string[] };

export function baselinePath(dir: string, deviceId: string): string {
  return join(dir, `${deviceId}.baseline.json`);
}

function touchedPath(dir: string, deviceId: string): string {
  return join(dir, `${deviceId}.touched.json`);
}

export async function saveBaseline(dir: string, deviceId: string, baseline: PhoneState): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(touchedPath(dir, deviceId), '[]');
  await writeFile(baselinePath(dir, deviceId), JSON.stringify(baseline));
}

export async function saveTouched(dir: string, deviceId: string, touched: string[]): Promise<void> {
  await writeFile(touchedPath(dir, deviceId), JSON.stringify(touched));
}

export async function loadBaseline(dir: string, deviceId: string): Promise<Stored | null> {
  const read = async (path: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return null;
    }
  };
  const baseline = await read(baselinePath(dir, deviceId));
  if (!isPhoneState(baseline)) {
    return null;
  }
  const touched = await read(touchedPath(dir, deviceId));
  return { baseline, touched: isStrings(touched) ? touched : [] };
}

export async function dropBaseline(dir: string, deviceId: string): Promise<void> {
  await rm(baselinePath(dir, deviceId), { force: true });
  await rm(touchedPath(dir, deviceId), { force: true });
}
