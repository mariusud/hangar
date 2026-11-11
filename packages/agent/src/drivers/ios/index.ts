import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { PRIVACY_SERVICES, type DeviceInfo, type Frame, type KeyModifier, type PrivacyService, type UiNode } from '@hangar/protocol';
import * as hid from './hid.ts';
import { iosPredicate, parseIosLine, type LogSource } from '../applog.ts';
import { forgetCapture } from './capture.ts';

export * from './golden.ts';
export * from './capture.ts';

const run = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export class DriverError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function simctl(...args: string[]): Promise<string> {
  try {
    const { stdout } = await run('xcrun', ['simctl', ...args], { maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (err) {
    throw new DriverError('SIMCTL_FAILED', `simctl ${args[0]} failed: ${stderrOf(err)}`);
  }
}

// idb's own auto-spawned companions go stale across reboots and return an empty accessibility tree.
const companions = new Map<string, { proc: ChildProcess; socket: string }>();
/** Hangar owns the simulators whose names start with this. HANGAR_SIM_PREFIX gives the smoke test its own set. */
export const NAME_PREFIX = process.env.HANGAR_SIM_PREFIX || 'hangar-';
// Socket paths are capped at 104 bytes, so another prefix gets a short directory of its own.
const SOCKET_DIR = join(tmpdir(), NAME_PREFIX === 'hangar-' ? 'hangar-idb' : `idb-${createHash('sha256').update(NAME_PREFIX).digest('hex').slice(0, 6)}`);

export async function startCompanion(udid: string): Promise<void> {
  if (companions.has(udid)) {
    return;
  }
  await mkdir(SOCKET_DIR, { recursive: true });
  const socket = join(SOCKET_DIR, `${udid}.sock`);
  await rm(socket, { force: true });
  const proc = spawn('idb_companion', ['--udid', udid, '--grpc-domain-sock', socket, '--only', 'simulator'], {
    stdio: 'ignore',
  });
  companions.set(udid, { proc, socket });
  proc.once('exit', () => companions.delete(udid));
  for (let i = 0; i < 50; i++) {
    try {
      await run('idb', ['--companion', socket, 'describe', '--json'], { maxBuffer: MAX_BUFFER });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  stopCompanion(udid);
  throw new DriverError('IDB_COMPANION_TIMEOUT', `The idb companion for ${udid} did not start within 10 s.`);
}

export async function stopLeftoverCompanions(): Promise<void> {
  await run('pkill', ['-f', `idb_companion .*--grpc-domain-sock ${SOCKET_DIR}/`]).catch(() => {});
}

export function stopCompanion(udid: string): void {
  const companion = companions.get(udid);
  if (companion) {
    hid.close(companion.socket);
  }
  companion?.proc.kill();
  companions.delete(udid);
}

export function companionSocket(udid: string): string | null {
  return companions.get(udid)?.socket ?? null;
}

async function idb(udid: string, ...args: string[]): Promise<string> {
  const companion = companions.get(udid);
  if (!companion) {
    throw new DriverError('IDB_NOT_STARTED', `No idb companion is running for ${udid}. Boot the device through Hangar first.`);
  }
  try {
    const { stdout } = await run('idb', ['--companion', companion.socket, ...args], { maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (err) {
    throw new DriverError('IDB_FAILED', `idb ${args.join(' ')} failed: ${stderrOf(err)}`);
  }
}

function stderrOf(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err && typeof err.stderr === 'string' && err.stderr.trim()) {
    return err.stderr.trim().split('\n').slice(-1)[0] ?? '';
  }
  return err instanceof Error ? err.message : String(err);
}

export async function boot(udid: string): Promise<void> {
  await simctl('bootstatus', udid, '-b');
  await startCompanion(udid);
}

export async function shutdown(udid: string): Promise<void> {
  stopCompanion(udid);
  try {
    await simctl('shutdown', udid);
  } catch (err) {
    if (!(err instanceof DriverError && err.message.includes('current state: Shutdown'))) {
      throw err;
    }
  }
}

export async function remove(udid: string): Promise<void> {
  stopCompanion(udid);
  forgetCapture(udid);
  await simctl('delete', udid);
}

export async function listOwned(): Promise<{ udid: string; name: string; state: string }[]> {
  const json = JSON.parse(await simctl('list', 'devices', '-j')) as {
    devices: Record<string, { udid: string; name: string; state: string }[]>;
  };
  return Object.values(json.devices)
    .flat()
    .filter((d) => d.name.startsWith(NAME_PREFIX))
    .map(({ udid, name, state }) => ({ udid, name, state }));
}

export async function screenshot(udid: string, format: 'png' | 'jpeg' = 'png', maxSize?: number, quality = 70): Promise<Buffer> {
  if (format === 'jpeg') {
    const shot = await images(1, Buffer.from(udid), maxSize ?? 0, quality).catch(() => null);
    if (shot) {
      return shot;
    }
  }
  const companion = companions.get(udid);
  if (!companion) {
    return screenshotWithSimctl(udid, format, maxSize, quality);
  }
  const res = await hid.unary(companion.socket, 'screenshot').catch((err: Error) => {
    throw new DriverError('SCREENSHOT_FAILED', `The screenshot of ${udid} failed: ${err.message}`);
  });
  const image = hid.bytesField(res, 1);
  const isPng = image.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (format === 'png' && !maxSize && isPng) {
    return image;
  }
  if (format === 'png') {
    return screenshotWithSimctl(udid, format, maxSize, quality);
  }
  return images(0, image, maxSize ?? 0, quality);
}

async function screenshotWithSimctl(udid: string, format: 'png' | 'jpeg', maxSize: number | undefined, quality: number): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-shot-'));
  const file = join(dir, `shot.${format}`);
  try {
    await simctl('io', udid, 'screenshot', `--type=${format}`, file);
    if (maxSize) {
      const args = ['-Z', String(maxSize), file];
      if (format === 'jpeg') {
        args.splice(2, 0, '-s', 'formatOptions', String(quality));
      }
      await run('sips', args);
    }
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

type Waiting = { resolve: (b: Buffer) => void; reject: (e: Error) => void };
let imageHelper: Promise<{ proc: ChildProcess; waiting: Waiting[] }> | null = null;

function imageProcess(): Promise<{ proc: ChildProcess; waiting: Waiting[] }> {
  imageHelper ??= (async () => {
    const proc = spawn(await screenBinary(), ['--images'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const waiting: Waiting[] = [];
    let pending = Buffer.alloc(0);
    proc.stdout?.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
        const length = pending.readUInt32BE(0);
        const out = pending.subarray(4, 4 + length);
        pending = pending.subarray(4 + length);
        const w = waiting.shift();
        if (length === 0) {
          w?.reject(new DriverError('SCREENSHOT_FAILED', 'The helper could not make that JPEG.'));
        } else {
          w?.resolve(Buffer.from(out));
        }
      }
    });
    proc.once('exit', () => {
      imageHelper = null;
      for (const w of waiting.splice(0)) {
        w.reject(new DriverError('SCREENSHOT_FAILED', 'The image helper exited.'));
      }
    });
    proc.unref();
    for (const stream of [proc.stdin, proc.stdout]) {
      if (stream instanceof Socket) {
        stream.unref();
      }
    }
    return { proc, waiting };
  })();
  imageHelper.catch(() => {
    imageHelper = null;
  });
  return imageHelper;
}

async function images(kind: 0 | 1, payload: Buffer, maxSize: number, quality: number): Promise<Buffer> {
  const { proc, waiting } = await imageProcess();
  return new Promise((resolve, reject) => {
    waiting.push({ resolve, reject });
    const head = Buffer.alloc(8);
    head.writeUInt32BE(4 + payload.length, 0);
    head.writeUInt8(kind, 4);
    head.writeUInt16BE(Math.min(maxSize, 0xffff), 5);
    head.writeUInt8(Math.max(1, Math.min(100, quality)), 7);
    proc.stdin?.write(Buffer.concat([head, payload]));
  });
}

type IdbElement = {
  type: string | null;
  role: string | null;
  AXLabel: string | null;
  AXValue: string | null;
  AXUniqueId: string | null;
  enabled: boolean;
  frame: Frame;
};

export async function describe(udid: string): Promise<{ screen: Frame; nodes: UiNode[] }> {
  const companion = companions.get(udid);
  if (!companion) {
    return toNodes(JSON.parse(await idb(udid, 'ui', 'describe-all', '--json')));
  }
  const res = await hid.unary(companion.socket, 'accessibility_info').catch((err: Error) => {
    throw new DriverError('DESCRIBE_FAILED', `Reading the element tree of ${udid} failed: ${err.message}`);
  });
  const raw: IdbElement[] = JSON.parse(hid.bytesField(res, 1).toString('utf8'));
  return toNodes(raw);
}

export function toNodes(raw: IdbElement[]): { screen: Frame; nodes: UiNode[] } {
  const app = raw.find((e) => e.type === 'Application');
  const screen = app?.frame ?? { x: 0, y: 0, width: 1, height: 1 };
  const nodes = raw.map((e) => ({
    role: (e.role ?? e.type ?? 'unknown').replace(/^AX/, '').toLowerCase(),
    label: e.AXLabel,
    value: e.AXValue,
    identifier: e.AXUniqueId,
    enabled: e.enabled,
    frame: e.frame,
    normalized: {
      x: round(e.frame.x / screen.width),
      y: round(e.frame.y / screen.height),
      width: round(e.frame.width / screen.width),
      height: round(e.frame.height / screen.height),
    },
  }));
  return { screen, nodes };
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

async function sendHid(udid: string, events: hid.HidEvent[]): Promise<void> {
  const companion = companions.get(udid);
  if (!companion) {
    throw new DriverError('IDB_NOT_STARTED', `No idb companion is running for ${udid}. Boot the device through Hangar first.`);
  }
  try {
    await hid.send(companion.socket, events);
  } catch (err) {
    throw new DriverError('INPUT_FAILED', `Input to ${udid} failed: ${(err as Error).message}`);
  }
}

function press(action: { touch: [number, number] } | { button: number } | { key: number }, durationS?: number): hid.HidEvent[] {
  const events: hid.HidEvent[] = [{ press: action, up: false }];
  if (durationS) {
    events.push({ delayS: durationS });
  }
  events.push({ press: action, up: true });
  return events;
}

export async function tap(udid: string, x: number, y: number, durationS?: number): Promise<void> {
  await sendHid(udid, press({ touch: [x, y] }, durationS));
}

export async function swipe(udid: string, from: [number, number], to: [number, number], durationS: number): Promise<void> {
  await sendHid(udid, [{ swipe: { from, to, durationS } }]);
}

export async function typeText(udid: string, text: string): Promise<void> {
  await idb(udid, 'ui', 'text', '--', text);
}

const KEYS: Record<string, number> = {
  return: 40,
  enter: 40,
  escape: 41,
  backspace: 42,
  delete: 42,
  tab: 43,
  space: 44,
  right: 79,
  left: 80,
  down: 81,
  up: 82,
  ...Object.fromEntries([...'abcdefghijklmnopqrstuvwxyz'].map((c, i) => [c, 4 + i])),
};

const MODIFIERS: Record<KeyModifier, number> = { control: 224, shift: 225, option: 226, command: 227 };

export async function key(udid: string, name: string, modifiers: KeyModifier[] = []): Promise<void> {
  const code = KEYS[name.toLowerCase()];
  if (code === undefined) {
    throw new DriverError('UNKNOWN_KEY', `Unknown key "${name}". Known keys: ${Object.keys(KEYS).join(', ')}.`);
  }
  const held = modifiers.map((m) => {
    const c = MODIFIERS[m];
    if (c === undefined) {
      throw new DriverError('UNKNOWN_KEY', `Unknown modifier "${m}". Use command, shift, option or control.`);
    }
    return c;
  });
  await sendHid(udid, [
    ...held.map((k): hid.HidEvent => ({ press: { key: k }, up: false })),
    ...press({ key: code }),
    ...held.reverse().map((k): hid.HidEvent => ({ press: { key: k }, up: true })),
  ]);
}

export async function button(udid: string, name: 'home' | 'lock' | 'siri'): Promise<void> {
  await sendHid(udid, press({ button: hid.BUTTONS[name] }));
}

export async function install(udid: string, appPath: string): Promise<void> {
  await simctl('install', udid, appPath);
}

export async function launch(udid: string, bundleId: string, args: string[] = []): Promise<void> {
  await simctl('launch', udid, bundleId, ...args);
}

export async function terminate(udid: string, bundleId: string): Promise<void> {
  await simctl('terminate', udid, bundleId);
}

export async function uninstall(udid: string, bundleId: string): Promise<void> {
  await simctl('uninstall', udid, bundleId);
}

export async function openUrl(udid: string, url: string): Promise<void> {
  await simctl('openurl', udid, url);
}

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

function checkBundleId(bundleId: string): void {
  if (!BUNDLE_ID.test(bundleId)) {
    throw new DriverError('BAD_BUNDLE_ID', `"${bundleId}" is not a bundle id.`);
  }
}

export async function push(udid: string, bundleId: string, payload: Record<string, unknown>): Promise<void> {
  checkBundleId(bundleId);
  if (typeof payload !== 'object' || payload === null || !('aps' in payload)) {
    throw new DriverError('BAD_PAYLOAD', 'The push payload needs an "aps" key, for example {"aps":{"alert":"Hi"}}.');
  }
  const dir = await mkdtemp(join(tmpdir(), 'hangar-push-'));
  try {
    const file = join(dir, 'payload.json');
    await writeFile(file, JSON.stringify(payload));
    await simctl('push', udid, bundleId, file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function privacy(udid: string, action: 'grant' | 'revoke' | 'reset', service: PrivacyService, bundleId: string): Promise<void> {
  checkBundleId(bundleId);
  if (!['grant', 'revoke', 'reset'].includes(action) || !PRIVACY_SERVICES.includes(service)) {
    throw new DriverError('BAD_PERMISSION', `Use grant, revoke or reset, with one of: ${PRIVACY_SERVICES.join(', ')}.`);
  }
  await simctl('privacy', udid, action, service, bundleId);
}

export async function location(udid: string, lat: number | null, lon?: number): Promise<void> {
  if (lat === null) {
    await simctl('location', udid, 'clear');
    return;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon!) > 180) {
    throw new DriverError('BAD_LOCATION', 'Latitude goes from -90 to 90 and longitude from -180 to 180.');
  }
  await simctl('location', udid, 'set', `${lat},${lon}`);
}

export async function appearance(udid: string, mode: 'light' | 'dark'): Promise<void> {
  if (mode !== 'light' && mode !== 'dark') {
    throw new DriverError('BAD_APPEARANCE', 'Appearance is light or dark.');
  }
  await simctl('ui', udid, 'appearance', mode);
}

export async function appLocale(udid: string, bundleId: string, language: string): Promise<void> {
  checkBundleId(bundleId);
  if (!/^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/.test(language)) {
    throw new DriverError('BAD_LANGUAGE', `"${language}" is not a language tag such as nb-NO or en-US.`);
  }
  await simctl('spawn', udid, 'defaults', 'write', bundleId, 'AppleLanguages', '-array', language);
  await simctl('spawn', udid, 'defaults', 'write', bundleId, 'AppleLocale', '-string', language.replace('-', '_'));
}

export async function setDefault(udid: string, domain: string, key: string, value: string): Promise<void> {
  await simctl('spawn', udid, 'defaults', 'write', domain, key, '-string', value);
}

export async function info(udid: string, model: string, os: string): Promise<DeviceInfo> {
  const [{ screen }, png] = await Promise.all([describe(udid), screenshot(udid, 'png')]);
  const scale = Math.round(png.readUInt32BE(16) / screen.width);
  return { platform: 'ios-simulator', model, os, screen: { width: screen.width, height: screen.height, scale } };
}

const SCREEN_SOURCE = fileURLToPath(new URL('../../../native/screen.swift', import.meta.url));
let screenBuild: Promise<string> | null = null;

export function screenBinary(): Promise<string> {
  screenBuild ??= (async () => {
    const hash = createHash('sha256').update(await readFile(SCREEN_SOURCE)).digest('hex').slice(0, 12);
    const dir = join(process.env.HANGAR_HOME ?? join(homedir(), '.hangar'), 'bin');
    const bin = join(dir, `hangar-screen-${hash}`);
    if (await access(bin).then(() => true, () => false)) {
      return bin;
    }
    await mkdir(dir, { recursive: true });
    const tmp = `${bin}.${process.pid}.tmp`;
    try {
      await run('xcrun', ['swiftc', '-O', SCREEN_SOURCE, '-o', tmp], { maxBuffer: MAX_BUFFER });
    } catch (err) {
      throw new DriverError('SCREEN_BUILD_FAILED', `Could not build the screen helper: ${stderrOf(err)}`);
    }
    await rename(tmp, bin);
    return bin;
  })();
  screenBuild.catch(() => {
    screenBuild = null;
  });
  return screenBuild;
}

export type ScreenStream = {
  keyframe: () => void;
  record: (path: string) => void;
  stopRecording: () => Promise<void>;
  stop: () => Promise<void>;
  exited: Promise<string | null>;
};

export async function screenStream(udid: string, onFrame: (record: Buffer) => void, opts: { fps?: number; bitrate?: number; maxSize?: number } = {}): Promise<ScreenStream> {
  const bin = await screenBinary();
  const args = [udid, '--fps', String(opts.fps ?? 60), '--bitrate', String(opts.bitrate ?? 8_000_000), '--max-size', String(opts.maxSize ?? 0)];
  const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let pending: Buffer = Buffer.alloc(0);
  proc.stdout.on('data', (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 4) {
      const len = pending.readUInt32BE(0);
      if (pending.length < 4 + len) {
        break;
      }
      onFrame(pending.subarray(4, 4 + len));
      pending = pending.subarray(4 + len);
    }
  });
  let lastError: string | null = null;
  const recorded: (() => void)[] = [];
  proc.stderr.on('data', (d: Buffer) => {
    for (const line of d.toString().trim().split('\n')) {
      if (line.startsWith('recorded ')) {
        recorded.shift()?.();
      } else if (line) {
        lastError = line;
      }
    }
  });
  const exited = new Promise<string | null>((resolve) => proc.once('exit', (code) => resolve(code === 0 || code === null ? null : lastError ?? `exit ${code}`)));
  return {
    keyframe: () => {
      proc.stdin.write('k\n');
    },
    record: (path) => {
      proc.stdin.write(`r ${path}\n`);
    },
    stopRecording: () =>
      Promise.race([
        new Promise<void>((resolve) => {
          recorded.push(resolve);
          proc.stdin.write('s\n');
        }),
        exited.then(() => {}),
      ]),
    stop: async () => {
      proc.stdin.end();
      const timer = setTimeout(() => proc.kill(), 5000);
      await exited;
      clearTimeout(timer);
    },
    exited,
  };
}

export type AppLog = { stop: () => Promise<void> };

export function appLog(udid: string, path: string, maxBytes = 16 * 1024 * 1024): AppLog {
  const proc = spawn('xcrun', ['simctl', 'spawn', udid, 'log', 'stream', '--style', 'ndjson', '--level', 'info', '--predicate', 'processImagePath CONTAINS "/Containers/Bundle/Application/"'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const file = createWriteStream(path);
  let written = 0;
  proc.stdout.on('data', (chunk: Buffer) => {
    if (written < maxBytes) {
      written += chunk.length;
      file.write(chunk);
    }
  });
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  return {
    stop: async () => {
      proc.kill();
      await exited;
      await new Promise<void>((resolve) => file.end(resolve));
    },
  };
}

export async function versions(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const { stdout } = await run('xcodebuild', ['-version']);
    out.xcode = stdout.split('\n')[0]?.replace('Xcode ', '') ?? 'unknown';
  } catch {
    out.xcode = 'missing';
  }
  try {
    const { stdout } = await run('idb_companion', ['--version']);
    out.idbCompanion = stdout.trim();
  } catch {
    out.idbCompanion = 'missing';
  }
  return out;
}

export async function deviceName(udid: string): Promise<string> {
  const owned = await listOwned();
  return owned.find((d) => d.udid === udid)?.name ?? '';
}

// Lines the app's own process logs, found by the path of its installed bundle.
export async function appLogSource(udid: string, bundleId: string): Promise<LogSource> {
  checkBundleId(bundleId);
  const container = (
    await simctl('get_app_container', udid, bundleId, 'app').catch(() => {
      throw new DriverError('APP_NOT_INSTALLED', `${bundleId} is not installed on this device.`);
    })
  ).trim();
  const predicate = iosPredicate(container);
  return {
    key: predicate,
    command: 'xcrun',
    args: ['simctl', 'spawn', udid, 'log', 'stream', '--style', 'ndjson', '--level', 'info', '--predicate', predicate],
    parse: parseIosLine,
    backfill: async () => {
      const { stdout } = await run('xcrun', ['simctl', 'spawn', udid, 'log', 'show', '--style', 'ndjson', '--info', '--last', '2m', '--predicate', predicate], { maxBuffer: MAX_BUFFER, timeout: 20_000 });
      return stdout.split('\n').flatMap((l) => parseIosLine(l) ?? []);
    },
  };
}

export function orientation(): never {
  throw new DriverError('UNSUPPORTED', 'Rotating an iOS simulator is not supported: simctl has no command for it and the idb companion has no orientation call.');
}

export function multiTouch(): never {
  throw new DriverError('UNSUPPORTED', "Pinch and rotate are not supported on iOS simulators: the idb companion's HID call takes one touch point at a time.");
}
