import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Frame, TestCase, UiNode } from '@hangar/protocol';

const run = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export class DriverError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function stderrOf(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  return String(e.stderr || e.message || err).trim().split('\n').slice(-3).join(' ');
}

export function sdkRoot(): string | null {
  const candidates = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, join(homedir(), 'Library', 'Android', 'sdk'), join(homedir(), 'Android', 'Sdk')];
  return candidates.find((d): d is string => Boolean(d && existsSync(join(d, 'platform-tools', 'adb')))) ?? null;
}

function tool(...path: string[]): string {
  const root = sdkRoot();
  if (!root) {
    throw new DriverError('NO_ANDROID_SDK', 'The Android SDK was not found. Install Android Studio, or set ANDROID_HOME.');
  }
  return join(root, ...path);
}

async function adb(serial: string, ...args: string[]): Promise<string> {
  try {
    return (await run(tool('platform-tools', 'adb'), ['-s', serial, ...args], { maxBuffer: MAX_BUFFER })).stdout;
  } catch (err) {
    throw new DriverError('ADB_FAILED', `adb ${args[0]} failed: ${stderrOf(err)}`);
  }
}

async function adbBuffer(serial: string, ...args: string[]): Promise<Buffer> {
  try {
    return (await run(tool('platform-tools', 'adb'), ['-s', serial, ...args], { encoding: 'buffer', maxBuffer: MAX_BUFFER })).stdout;
  } catch (err) {
    throw new DriverError('ADB_FAILED', `adb ${args[0]} failed: ${stderrOf(err)}`);
  }
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function checkPackage(pkg: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(pkg)) {
    throw new DriverError('BAD_PACKAGE', `${pkg} is not an Android package name.`);
  }
  return pkg;
}

export async function avds(): Promise<string[]> {
  const { stdout } = await run(tool('emulator', 'emulator'), ['-list-avds']).catch(() => ({ stdout: '' }));
  return stdout.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('INFO'));
}

export type Emulator = { serial: string; proc: ChildProcess };

export async function boot(avd: string, port: number, timeoutMs = 180_000): Promise<Emulator> {
  const proc = spawn(
    tool('emulator', 'emulator'),
    ['-avd', avd, '-port', String(port), '-read-only', '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot-save', '-no-metrics'],
    { stdio: 'ignore', detached: false },
  );
  const serial = `emulator-${port}`;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (proc.exitCode !== null) {
      throw new DriverError('EMULATOR_EXITED', `The emulator for ${avd} exited with code ${proc.exitCode}.`);
    }
    const booted = await adb(serial, 'shell', 'getprop', 'sys.boot_completed').catch(() => '');
    if (booted.trim() === '1') {
      for (const key of ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale']) {
        await adb(serial, 'shell', 'settings', 'put', 'global', key, '0').catch(() => {});
      }
      return { serial, proc };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  proc.kill();
  throw new DriverError('BOOT_TIMEOUT', `The emulator for ${avd} did not finish booting in ${timeoutMs / 1000} s.`);
}

export async function kill(e: Emulator): Promise<void> {
  await adb(e.serial, 'emu', 'kill').catch(() => {});
  const exited = new Promise((r) => e.proc.once('exit', r));
  const timer = setTimeout(() => e.proc.kill('SIGKILL'), 10_000);
  if (e.proc.exitCode === null) {
    await exited;
  }
  clearTimeout(timer);
}

export async function info(serial: string): Promise<{ model: string; os: string }> {
  const prop = async (k: string): Promise<string> => (await adb(serial, 'shell', 'getprop', k)).trim();
  return { model: await prop('ro.product.model'), os: await prop('ro.build.version.release') };
}

export async function screenSize(serial: string): Promise<{ width: number; height: number }> {
  const out = await adb(serial, 'shell', 'wm', 'size');
  // "Override size" wins over "Physical size" when both are printed.
  const all = [...out.matchAll(/(\d+)x(\d+)/g)];
  const m = all[all.length - 1];
  if (!m) {
    throw new DriverError('NO_SCREEN_SIZE', `Could not read the screen size: ${out.trim()}`);
  }
  return { width: Number(m[1]), height: Number(m[2]) };
}

export async function screenshot(serial: string): Promise<Buffer> {
  return adbBuffer(serial, 'exec-out', 'screencap', '-p');
}

export function toNodes(xml: string, screen: { width: number; height: number }): { screen: Frame; nodes: UiNode[] } {
  const attr = (tag: string, name: string): string => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? '';
  const unescape = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
  const nodes: UiNode[] = [];
  for (const m of xml.matchAll(/<node\b[^>]*>/g)) {
    const tag = m[0];
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr(tag, 'bounds'));
    if (!b) {
      continue;
    }
    const frame = { x: Number(b[1]), y: Number(b[2]), width: Number(b[3]) - Number(b[1]), height: Number(b[4]) - Number(b[2]) };
    const text = unescape(attr(tag, 'text'));
    const desc = unescape(attr(tag, 'content-desc'));
    const id = attr(tag, 'resource-id');
    if (!text && !desc && !id && attr(tag, 'clickable') !== 'true') {
      continue;
    }
    nodes.push({
      role: attr(tag, 'class').split('.').pop() ?? '',
      label: desc || text || null,
      value: desc && text ? text : null,
      identifier: id ? id.replace(/^.*:id\//, '') : null,
      enabled: attr(tag, 'enabled') !== 'false',
      frame,
      normalized: { x: frame.x / screen.width, y: frame.y / screen.height, width: frame.width / screen.width, height: frame.height / screen.height },
    });
  }
  return { screen: { x: 0, y: 0, width: screen.width, height: screen.height }, nodes };
}

export async function describe(serial: string): Promise<{ screen: Frame; nodes: UiNode[] }> {
  const path = '/data/local/tmp/hangar-ui.xml';
  await adb(serial, 'shell', 'uiautomator', 'dump', path);
  return toNodes(await adb(serial, 'exec-out', 'cat', path), await screenSize(serial));
}

export async function tap(serial: string, x: number, y: number, durationMs?: number): Promise<void> {
  const [px, py] = [String(Math.round(x)), String(Math.round(y))];
  await (durationMs ? adb(serial, 'shell', 'input', 'swipe', px, py, px, py, String(Math.round(durationMs))) : adb(serial, 'shell', 'input', 'tap', px, py));
}

export async function swipe(serial: string, from: [number, number], to: [number, number], durationMs: number): Promise<void> {
  await adb(serial, 'shell', 'input', 'swipe', ...[...from, ...to].map((n) => String(Math.round(n))), String(Math.round(durationMs)));
}

// `input text` reads %s as a space and goes through the device shell, so everything else non-alphanumeric is escaped.
export function inputText(text: string): string {
  if (/[^\x20-\x7e]/.test(text)) {
    throw new DriverError('TEXT_NOT_SUPPORTED', 'Android emulators type printable ASCII only through adb; use a paste or set the field from the app.');
  }
  return text.replace(/[^A-Za-z0-9 ]/g, (c) => `\\${c}`).replace(/ /g, '%s');
}

export async function typeText(serial: string, text: string): Promise<void> {
  if (text) {
    await adb(serial, 'shell', 'input', 'text', inputText(text));
  }
}

const KEYCODES: Record<string, number> = {
  enter: 66, return: 66, backspace: 67, delete: 112, tab: 61, escape: 111, space: 62,
  up: 19, down: 20, left: 21, right: 22, home: 3, back: 4, menu: 82, lock: 26, power: 26,
};

export async function key(serial: string, name: string): Promise<void> {
  const code = KEYCODES[name.toLowerCase()];
  if (code === undefined) {
    throw new DriverError('UNKNOWN_KEY', `Unknown key "${name}". Known keys: ${Object.keys(KEYCODES).join(', ')}.`);
  }
  await adb(serial, 'shell', 'input', 'keyevent', String(code));
}

export async function button(serial: string, name: 'home' | 'lock' | 'siri' | 'back'): Promise<void> {
  if (name === 'siri') {
    throw new DriverError('NOT_ON_ANDROID', 'Android has no Siri button.');
  }
  await key(serial, name);
}

async function packages(serial: string): Promise<Set<string>> {
  const out = await adb(serial, 'shell', 'pm', 'list', 'packages', '-3');
  return new Set(out.split('\n').map((l) => l.replace(/^package:/, '').trim()).filter(Boolean));
}

export async function install(serial: string, apk: string): Promise<string> {
  const before = await packages(serial);
  await adb(serial, 'install', '-r', '-g', apk);
  const added = [...(await packages(serial))].filter((p) => !before.has(p));
  if (added.length === 1) {
    return added[0]!;
  }
  // A reinstall adds nothing new; ask the package manager for the newest update instead.
  const recent = (await adb(serial, 'shell', 'dumpsys', 'package', 'packages')).match(/Package \[([^\]]+)\]/g)?.map((s) => s.slice(9, -1)) ?? [];
  const found = recent.find((p) => before.has(p) && apk.includes(p));
  if (!found) {
    throw new DriverError('UNKNOWN_PACKAGE', 'The app installed, but its package name could not be found.');
  }
  return found;
}

export async function launch(serial: string, pkg: string): Promise<void> {
  const out = await adb(serial, 'shell', 'monkey', '-p', checkPackage(pkg), '-c', 'android.intent.category.LAUNCHER', '1');
  if (/No activities found/.test(out)) {
    throw new DriverError('APP_NOT_INSTALLED', `${pkg} is not installed or has no launcher activity.`);
  }
}

export async function terminate(serial: string, pkg: string): Promise<void> {
  await adb(serial, 'shell', 'am', 'force-stop', checkPackage(pkg));
}

export async function uninstall(serial: string, pkg: string): Promise<void> {
  await adb(serial, 'uninstall', checkPackage(pkg));
}

export async function openUrl(serial: string, url: string): Promise<void> {
  await adb(serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', shellQuote(url));
}

export async function appearance(serial: string, mode: 'light' | 'dark'): Promise<void> {
  await adb(serial, 'shell', 'cmd', 'uimode', 'night', mode === 'dark' ? 'yes' : 'no');
}

export async function location(serial: string, lat: number, lon: number): Promise<void> {
  // The emulator console takes longitude first.
  await adb(serial, 'emu', 'geo', 'fix', String(lon), String(lat));
}

export async function reverse(serial: string, port: number): Promise<void> {
  await adb(serial, 'reverse', `tcp:${port}`, `tcp:${port}`);
}

export async function versions(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const adbVersion = await run(tool('platform-tools', 'adb'), ['version']).then((r) => r.stdout.split('\n')[0]?.replace('Android Debug Bridge version ', '') ?? '', () => '');
  if (adbVersion) {
    out.adb = adbVersion;
  }
  return out;
}

export type ScreenStream = { keyframe: () => void; stop: () => Promise<void> };

export function accessUnits(onUnit: (au: Buffer, isKey: boolean) => void): (chunk: Buffer) => void {
  let pending: Buffer = Buffer.alloc(0);
  let unit: Buffer[] = [];
  let isKey = false;
  const flushNal = (nal: Buffer): void => {
    const type = (nal[nal[2] === 1 ? 3 : 4] ?? 0) & 0x1f;
    unit.push(nal);
    if (type === 5) {
      isKey = true;
    }
    if (type === 1 || type === 5) {
      onUnit(Buffer.concat(unit), isKey);
      unit = [];
      isKey = false;
    }
  };
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const starts: number[] = [];
    for (let i = 0; i + 3 <= pending.length; i++) {
      if (pending[i] === 0 && pending[i + 1] === 0 && (pending[i + 2] === 1 || (pending[i + 2] === 0 && pending[i + 3] === 1))) {
        starts.push(i);
        i += 2;
      }
    }
    for (let k = 0; k + 1 < starts.length; k++) {
      flushNal(pending.subarray(starts[k], starts[k + 1]));
    }
    pending = starts.length ? Buffer.from(pending.subarray(starts[starts.length - 1])) : pending;
  };
}

// screenrecord cannot be asked for a keyframe and stops after three minutes, so it is restarted for either.
export async function screenStream(serial: string, onFrame: (record: Buffer) => void, opts: { bitrate?: number; maxSize?: number } = {}): Promise<ScreenStream> {
  const real = await screenSize(serial);
  const scale = opts.maxSize && Math.max(real.width, real.height) > opts.maxSize ? opts.maxSize / Math.max(real.width, real.height) : 1;
  const width = Math.round((real.width * scale) / 2) * 2;
  const height = Math.round((real.height * scale) / 2) * 2;
  let proc: ChildProcess | null = null;
  let stopped = false;
  const start = (): void => {
    const split = accessUnits((au, isKey) => {
      const record = Buffer.allocUnsafe(13 + au.length);
      record[0] = isKey ? 1 : 0;
      record.writeDoubleBE(Date.now(), 1);
      record.writeUInt16BE(width, 9);
      record.writeUInt16BE(height, 11);
      au.copy(record, 13);
      onFrame(record);
    });
    const p = spawn(tool('platform-tools', 'adb'), ['-s', serial, 'exec-out', 'screenrecord', '--output-format=h264', '--size', `${width}x${height}`, '--bit-rate', String(opts.bitrate ?? 8_000_000), '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.on('data', split);
    p.once('exit', () => {
      if (proc === p && !stopped) {
        start();
      }
    });
    proc = p;
  };
  start();
  return {
    keyframe: () => {
      const old = proc;
      start();
      old?.kill();
    },
    stop: async () => {
      stopped = true;
      proc?.kill();
    },
  };
}

export async function installTestApk(serial: string, apk: string): Promise<void> {
  await adb(serial, 'install', '-r', '-t', '-g', apk);
}

export async function instrumentationFor(serial: string, target: string): Promise<string> {
  const out = await adb(serial, 'shell', 'pm', 'list', 'instrumentation');
  for (const m of out.matchAll(/^instrumentation:(\S+) \(target=([^)]+)\)/gm)) {
    if (m[2] === target) {
      return m[1]!;
    }
  }
  throw new DriverError('NO_INSTRUMENTATION', `No test APK on the device tests ${target}. Build it with ./gradlew assembleAndroidTest.`);
}

export function checkTestNames(tests: string[]): void {
  if (tests.some((t) => !/^[A-Za-z_][\w$]*(\.[A-Za-z_][\w$]*)+(#\w+)?$/.test(t))) {
    throw new DriverError('BAD_TESTS', 'Name tests as classes (com.example.LoginTest) or methods (com.example.LoginTest#signIn).');
  }
}

// am instrument status codes: 0 pass, -2 failed assertion, -1 error, -3 or -4 skipped.
export function parseInstrumentation(out: string, target: string): { cases: TestCase[]; ok: boolean } {
  const cases: TestCase[] = [];
  let fields: Record<string, string> = {};
  let stack = '';
  let started = 0;
  for (const line of out.split('\n')) {
    const status = /^INSTRUMENTATION_STATUS: (\w+)=(.*)$/.exec(line);
    const code = /^INSTRUMENTATION_STATUS_CODE: (-?\d+)/.exec(line);
    if (status) {
      fields[status[1]!] = status[2]!;
      stack = status[1] === 'stack' ? status[2]! : stack;
    } else if (code) {
      const c = Number(code[1]);
      if (c === 1) {
        started = Date.now();
      } else if (fields.class && fields.test && c !== -3 && c !== -4) {
        const message = c === 0 ? undefined : stack.split('\n')[0] || 'failed';
        cases.push({ target, className: fields.class, name: fields.test, status: c === 0 ? 'passed' : 'failed', seconds: started ? (Date.now() - started) / 1000 : 0, ...(message ? { message } : {}) });
      }
      fields = {};
      stack = '';
    }
  }
  return { cases, ok: /^OK \(\d+ tests?\)/m.test(out) };
}

export async function instrument(serial: string, instrumentation: string, tests: string[]): Promise<string> {
  checkTestNames(tests);
  const args = ['shell', 'am', 'instrument', '-w', '-r', ...(tests.length ? ['-e', 'class', tests.join(',')] : []), instrumentation];
  try {
    return (await run(tool('platform-tools', 'adb'), ['-s', serial, ...args], { maxBuffer: MAX_BUFFER, timeout: 60 * 60_000 })).stdout;
  } catch (err) {
    return String((err as { stdout?: string }).stdout ?? '');
  }
}
