import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { checkPackage, DriverError, parseScreenSize, shellQuote, type Adb } from './index.ts';

// A phone cannot be deleted and cloned like an emulator, so its wipe undoes what a lease did
// and then reads the phone back. Decision 0015 says what this covers and what it does not.

export type Transport = 'usb' | 'tcp' | 'mdns';
export type Sighting = { serial: string; state: string; model: string | null; transport: Transport; usb: string | null };

const STATES = ['device', 'unauthorized', 'offline', 'no permissions', 'authorizing', 'connecting', 'recovery', 'sideload', 'bootloader', 'rescue', 'host'];

/** How adb reaches a serial. A phone on Wi-Fi is listed as `host:port` or under its mDNS name, next to its USB serial. */
export function transportOf(serial: string): Transport {
  if (serial.startsWith('adb-') || serial.includes('._adb')) {
    return 'mdns';
  }
  if (/:\d+$/.test(serial)) {
    return 'tcp';
  }
  return 'usb';
}

/** The phones in `adb devices -l`: every serial that is not an emulator's. */
export function parseDevices(out: string): Sighting[] {
  const seen: Sighting[] = [];
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(.+)$/.exec(line.trim());
    if (!m || line.startsWith('*') || line.startsWith('List of devices') || /^emulator-\d+$/.test(m[1] ?? '')) {
      continue;
    }
    const serial = m[1] ?? '';
    const rest = m[2] ?? '';
    const state = STATES.find((s) => rest === s || rest.startsWith(`${s} `)) ?? rest.split(/\s+/)[0] ?? '';
    seen.push({
      serial,
      state,
      model: /\bmodel:(\S+)/.exec(rest)?.[1]?.replace(/_/g, ' ') ?? null,
      transport: transportOf(serial),
      usb: /\busb:(\S+)/.exec(rest)?.[1] ?? null,
    });
  }
  return seen;
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

function skippedReason(s: Sighting): string {
  const how = s.transport === 'tcp' ? 'over the network' : 'over Wi-Fi debugging';
  return `adb reaches it ${how}. Devicepool leases phones over USB only, so that one phone is one device. Plug the phone in, or run \`adb disconnect ${s.serial}\` to stop seeing this.`;
}

export type PhoneChanges = {
  arrived: string[];
  left: string[];
  /** Phones on USB that cannot be used, with what to do. The key is the serial, or a name of its own for a phone whose serial adb cannot read. */
  unusable: Map<string, string>;
  /** Serials that are not USB, with why they are not offered. */
  skipped: Map<string, string>;
  /** How many scans in a row each known phone has been missing. Pass it to the next call. */
  misses: Map<string, number>;
};

// A cable that is nudged, or adb restarting, takes a phone out of `adb devices` for a scan or two.
export const MISSES_BEFORE_LEFT = 3;

/**
 * Compares the phones the agent knows with what adb lists now. Only USB serials count.
 * A known phone has left when it was missing, or not in state `device`, for three scans in a row.
 */
export function phoneChanges(known: Iterable<string>, seen: Sighting[], misses: ReadonlyMap<string, number> = new Map()): PhoneChanges {
  const knownSet = new Set(known);
  const usable = new Set<string>();
  const unusable = new Map<string, string>();
  const skipped = new Map<string, string>();
  const times = new Map<string, number>();
  for (const s of seen) {
    times.set(s.serial, (times.get(s.serial) ?? 0) + 1);
  }
  let unnamed = 0;
  for (const s of seen) {
    if (s.transport !== 'usb') {
      skipped.set(s.serial, skippedReason(s));
    } else if (/^\?+$/.test(s.serial)) {
      // adb prints question marks for every phone it may not open, so the serial does not tell them apart.
      unnamed += 1;
      unusable.set(`no-serial ${s.usb ?? unnamed}`, unusableReason(s.state) ?? unusableReason('no permissions') ?? '');
    } else if ((times.get(s.serial) ?? 0) > 1) {
      unusable.set(s.serial, 'Two attached phones report the same serial, so adb cannot tell them apart. Unplug one of them.');
    } else if (s.state === 'device') {
      usable.add(s.serial);
    } else {
      const reason = unusableReason(s.state);
      if (reason) {
        unusable.set(s.serial, reason);
      }
    }
  }
  const left: string[] = [];
  const next = new Map<string, number>();
  for (const serial of knownSet) {
    if (usable.has(serial)) {
      continue;
    }
    const missed = (misses.get(serial) ?? 0) + 1;
    if (missed >= MISSES_BEFORE_LEFT) {
      left.push(serial);
    } else {
      next.set(serial, missed);
    }
  }
  return { arrived: [...usable].filter((s) => !knownSet.has(s)), left, unusable, skipped, misses: next };
}

/** A device id that stays the same when the agent restarts and does not show the serial. */
export function deviceIdFor(serial: string): string {
  return `phone-${createHash('sha256').update(serial).digest('hex').slice(0, 12)}`;
}

export async function identify(adb: Adb): Promise<{ model: string; os: string; screen: { width: number; height: number } }> {
  const prop = async (k: string): Promise<string> => (await adb.run('shell', 'getprop', k)).trim();
  return { model: await prop('ro.product.model'), os: await prop('ro.build.version.release'), screen: parseScreenSize(await adb.run('shell', 'wm', 'size')) };
}

export type PhoneState = {
  /** Third-party package name to the path of its APK, which changes whenever the package is installed again. */
  packages: Record<string, string>;
  /** Every package name on the phone, system apps included. The wipe never clears the data of one of these. */
  installed: string[];
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

/** Keys in a record of a phone that this code does not manage. Their names never reach adb. */
export function unknownSettings(state: PhoneState): string[] {
  return Object.keys(state.settings).filter((key) => key !== NIGHT && !SETTINGS.some(([namespace, name]) => `${namespace}/${name}` === key));
}

const SHARED = '/sdcard/';
const FILE_ROOTS = [SHARED, '/data/local/tmp/'];
// App-private folders under /sdcard/Android go away with their package and cannot all be read by adb.
const SKIPPED = '/sdcard/Android';
const EXIT_MARK = 'devicepool-find-exit=';
// Names end in NUL, because a file name may hold a newline or end in a space. find's own exit status is
// printed last: without it, a listing cut short by a locked or unmounted storage looks like a phone with few files.
// Some phones join a root that ends in a slash to a name with two slashes, so the skipped folder is matched both ways.
export const FIND = `find ${FILE_ROOTS.join(' ')} \\( -path ${SKIPPED} -o -path /sdcard//Android \\) -prune -print0 -o -print0 2>/dev/null; printf '${EXIT_MARK}%s' "$?"`;

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

export function parsePackageNames(out: string): string[] {
  return out.split('\n').map((line) => line.trim().replace(/^package:/, '')).filter((name) => name !== '').sort();
}

// A name is never trimmed or cut. Only the slashes find adds between a root and a name are folded.
function asPath(record: string): string {
  const path = record.replace(/\/{2,}/g, '/');
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** The paths the wipe looks after, from the records of a NUL-separated listing. */
export function parseFiles(records: string[]): string[] {
  const files = new Set<string>();
  for (const record of records) {
    const path = asPath(record);
    if (path && path !== SKIPPED && !path.startsWith(`${SKIPPED}/`) && FILE_ROOTS.some((root) => `${path}/`.startsWith(root))) {
      files.add(path);
    }
  }
  return [...files].sort();
}

/** `exit` is find's exit status, or null when the listing ended before it was printed. `shared` counts the entries directly in /sdcard. */
export type Listing = { files: string[]; exit: number | null; shared: number };

export function parseListing(out: string): Listing {
  const records = out.split('\0');
  const last = records.pop() ?? '';
  const exit = last.startsWith(EXIT_MARK) && /^\d+$/.test(last.slice(EXIT_MARK.length).trim()) ? Number(last.slice(EXIT_MARK.length).trim()) : null;
  const shared = new Set(records.map(asPath).filter((path) => path.startsWith(SHARED) && !path.slice(SHARED.length).includes('/')));
  return { files: parseFiles(records), exit, shared: shared.size };
}

const UNLOCK = 'Unlock the phone once after a reboot, then lease it again.';

/**
 * Why a listing may not be used as the record of a phone, or null when it may.
 * `ceAvailable` is the property `sys.user.0.ce_available`. Some phones do not set it, so an empty value is
 * accepted when the listing itself shows that shared storage is there.
 */
export function storageProblem(ceAvailable: string, listing: Listing): string | null {
  if (ceAvailable.trim() === 'false') {
    return `The phone's storage is locked, so its files cannot be listed. ${UNLOCK}`;
  }
  if (listing.exit === null) {
    return `The list of the phone's files ended early. Check the cable. ${UNLOCK}`;
  }
  if (listing.exit !== 0) {
    return `The phone's files could not all be listed (find exited with ${listing.exit}), which happens while storage is locked or not mounted. ${UNLOCK}`;
  }
  if (listing.shared === 0) {
    return `The phone's shared storage looks empty, which means it is locked or not mounted. ${UNLOCK}`;
  }
  return null;
}

function lines(out: string): string[][] {
  return out.split('\n').map((l) => l.trim().split(/\s+/)).filter((t) => t.length >= 3);
}

/** Reads the phone. Throws, and changes nothing, when the phone's files cannot be listed in full. */
export async function snapshot(adb: Adb): Promise<PhoneState> {
  const ceAvailable = await adb.run('shell', 'getprop', 'sys.user.0.ce_available');
  const listing = parseListing(await adb.run('shell', FIND));
  const problem = storageProblem(ceAvailable, listing);
  if (problem) {
    throw new DriverError('PHONE_NOT_READABLE', problem);
  }
  const settings: Record<string, string> = {};
  for (const [namespace, key] of SETTINGS) {
    settings[`${namespace}/${key}`] = (await adb.run('shell', 'settings', 'get', namespace, key)).trim();
  }
  // Android 9 and older have no `cmd uimode night`. A night mode that cannot be read is not recorded.
  const night = /Night mode: (\w+)/.exec(await adb.run('shell', 'cmd', 'uimode', 'night').catch(() => ''))?.[1];
  if (night) {
    settings[NIGHT] = night;
  }
  return {
    packages: parsePackages(await adb.run('shell', 'pm', 'list', 'packages', '-3', '-f')),
    installed: parsePackageNames(await adb.run('shell', 'pm', 'list', 'packages')),
    files: listing.files,
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

// A control character, or the mark left where a name was not UTF-8, means the name on the phone may not be
// the string held here. Such a name is never handed to rm.
function isUnsafeName(path: string): boolean {
  return /[\u0000-\u001f\u007f\ufffd]/.test(path);
}

function removable(path: string): boolean {
  return (
    FILE_ROOTS.some((root) => path.startsWith(root) && path.length > root.length) &&
    path !== SKIPPED && !path.startsWith(`${SKIPPED}/`) &&
    !path.split('/').some((part) => part === '..' || part === '.') &&
    !isUnsafeName(path)
  );
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
  // The data of an app that was on the phone before the lease belongs to the phone's owner and is never cleared.
  // What is left to clear is a package that is new, cannot be uninstalled above, and is still there.
  const owned = new Set([...Object.keys(baseline.packages), ...baseline.installed]);
  for (const pkg of new Set(touched)) {
    if (!owned.has(pkg) && !added.includes(pkg) && current.installed.includes(pkg)) {
      steps.push({ do: 'stop', pkg }, { do: 'clear', pkg });
    }
  }
  const before = new Set(baseline.files);
  const roots: string[] = [];
  for (const path of current.files.filter((f) => !before.has(f)).sort()) {
    if (!roots.some((root) => path.startsWith(`${root}/`)) && removable(path)) {
      roots.push(path);
    }
  }
  for (let i = 0; i < roots.length; i += 50) {
    steps.push({ do: 'remove', paths: roots.slice(i, i + 50) });
  }
  const unknown = unknownSettings(baseline);
  for (const [key, value] of Object.entries(baseline.settings)) {
    if (current.settings[key] !== value && !unknown.includes(key)) {
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
    case 'remove': {
      const paths = step.paths.filter(removable);
      if (paths.length) {
        await adb.run('shell', `rm -rf -- ${paths.map(shellQuote).join(' ')}`);
      }
      return;
    }
    case 'setting': {
      if (step.key === NIGHT) {
        if (!/^[a-z_]+$/.test(step.value)) {
          throw new DriverError('BAD_SETTING', `${JSON.stringify(step.value)} is not a night mode.`);
        }
        await adb.run('shell', 'cmd', 'uimode', 'night', step.value);
        return;
      }
      // The namespace and key sent to the phone are this file's own constants, never text from the record on disk.
      const known = SETTINGS.find(([namespace, key]) => `${namespace}/${key}` === step.key);
      if (!known) {
        throw new DriverError('BAD_SETTING', `${JSON.stringify(step.key)} is not a setting Devicepool manages.`);
      }
      if (step.value === 'null' || step.value === '') {
        await adb.run('shell', 'settings', 'delete', known[0], known[1]);
      } else if (/^[\w.-]+$/.test(step.value)) {
        await adb.run('shell', 'settings', 'put', known[0], known[1], step.value);
      } else {
        throw new DriverError('BAD_SETTING', `${JSON.stringify(step.value)} is not a value Devicepool writes to ${step.key}.`);
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
  const extra = after.files.filter((f) => !before.has(f));
  const left = extra.filter((f) => !isUnsafeName(f));
  if (left.length) {
    found.push(`${left.length} file${left.length === 1 ? '' : 's'} from the lease could not be removed, such as ${left.slice(0, 3).join(', ')}`);
  }
  const unsafe = extra.filter(isUnsafeName);
  if (unsafe.length) {
    found.push(`${unsafe.length} file${unsafe.length === 1 ? ' has a name' : 's have names'} with control characters or bytes that are not UTF-8, which Devicepool does not pass to rm, such as ${unsafe.slice(0, 3).map((f) => JSON.stringify(f)).join(', ')}; delete ${unsafe.length === 1 ? 'it' : 'them'} on the phone`);
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
  const unknown = unknownSettings(baseline);
  if (unknown.length) {
    // The record does not look like one this code wrote, so nothing in it is acted on.
    return { ok: false, problems: [`the record of the phone before the lease names settings Devicepool does not manage (${unknown.map((k) => JSON.stringify(k)).join(', ')}), so nothing was undone`] };
  }
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
    'installed' in v && isStrings(v.installed) &&
    'files' in v && isStrings(v.files) &&
    'settings' in v && isRecord(v.settings) &&
    'reverses' in v && isStrings(v.reverses) &&
    'forwards' in v && isStrings(v.forwards)
  );
}

// The baseline of an open lease is kept on disk, so a phone whose lease outlived the agent is
// still wiped against it when the agent sees the phone again.
export type Stored =
  | { status: 'none' }
  /** A record is there and cannot be used. The phone may hold a lease's leftovers, so it must not become `ready`. */
  | { status: 'invalid'; reason: string }
  | { status: 'ok'; baseline: PhoneState; touched: string[] };

export function baselinePath(dir: string, deviceId: string): string {
  return join(dir, `${deviceId}.baseline.json`);
}

function touchedPath(dir: string, deviceId: string): string {
  return join(dir, `${deviceId}.touched.json`);
}

/** Replaces a file in one step, so a crash leaves the old content or the new, never half of either. */
export async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const file = await open(tmp, 'wx', 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  const dir = await open(dirname(path), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}

export async function saveBaseline(dir: string, deviceId: string, baseline: PhoneState): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeAtomic(touchedPath(dir, deviceId), '[]');
  await writeAtomic(baselinePath(dir, deviceId), JSON.stringify(baseline));
}

export async function saveTouched(dir: string, deviceId: string, touched: string[]): Promise<void> {
  await writeAtomic(touchedPath(dir, deviceId), JSON.stringify(touched));
}

async function readJson(path: string): Promise<{ found: boolean; value: unknown }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return { found: false, value: null };
    }
    throw err;
  }
  return { found: true, value: JSON.parse(text) };
}

export async function loadBaseline(dir: string, deviceId: string): Promise<Stored> {
  const path = baselinePath(dir, deviceId);
  try {
    const baseline = await readJson(path);
    if (!baseline.found) {
      return { status: 'none' };
    }
    if (!isPhoneState(baseline.value)) {
      return { status: 'invalid', reason: `${path} is not a record of a phone` };
    }
    const touched = await readJson(touchedPath(dir, deviceId));
    if (!touched.found || !isStrings(touched.value)) {
      return { status: 'invalid', reason: `${touchedPath(dir, deviceId)}, the list of apps the lease used, is missing or damaged` };
    }
    return { status: 'ok', baseline: baseline.value, touched: touched.value };
  } catch (err) {
    return { status: 'invalid', reason: `${path} could not be read (${err instanceof Error ? err.message : String(err)})` };
  }
}

export async function dropBaseline(dir: string, deviceId: string): Promise<void> {
  await rm(baselinePath(dir, deviceId), { force: true });
  await rm(touchedPath(dir, deviceId), { force: true });
}
