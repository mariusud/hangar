// iOS simulator driver: simctl for lifecycle, idb for input and the accessibility tree.
// Every call goes through execFile with an argument array. Never a shell.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { DeviceInfo, Frame, UiNode } from '@hangar/protocol';
import * as hid from './hid.ts';

const run = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export class DriverError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

async function simctl(...args: string[]): Promise<string> {
  try {
    const { stdout } = await run('xcrun', ['simctl', ...args], { maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (err) {
    throw new DriverError('SIMCTL_FAILED', `simctl ${args[0]} failed: ${stderrOf(err)}`);
  }
}

// One idb companion per booted device, owned by Hangar. idb's own auto-spawned companions go
// stale across reboots and then return an empty accessibility tree (seen on iOS 26.5).
const companions = new Map<string, { proc: ChildProcess; socket: string }>();
const SOCKET_DIR = join(tmpdir(), 'hangar-idb');

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
  // The companion answers once its socket is up and the device is attached.
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

export function stopCompanion(udid: string): void {
  const companion = companions.get(udid);
  if (companion) {
    hid.close(companion.socket);
  }
  companion?.proc.kill();
  companions.delete(udid);
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

export type Runtime = { identifier: string; version: string; name: string };
export type DeviceType = { identifier: string; name: string };

export async function runtimes(): Promise<Runtime[]> {
  const json = JSON.parse(await simctl('list', 'runtimes', '-j')) as {
    runtimes: { identifier: string; version: string; name: string; isAvailable: boolean; platform?: string }[];
  };
  return json.runtimes
    .filter((r) => r.isAvailable && r.identifier.includes('iOS'))
    .map(({ identifier, version, name }) => ({ identifier, version, name }));
}

export async function deviceTypes(): Promise<DeviceType[]> {
  const json = JSON.parse(await simctl('list', 'devicetypes', '-j')) as {
    devicetypes: { identifier: string; name: string; productFamily?: string }[];
  };
  return json.devicetypes
    .filter((d) => d.productFamily === 'iPhone' || d.productFamily === 'iPad')
    .map(({ identifier, name }) => ({ identifier, name }));
}

export async function create(name: string, deviceType: string, runtime: string): Promise<string> {
  return (await simctl('create', name, deviceType, runtime)).trim();
}

export async function clone(sourceUdid: string, name: string): Promise<string> {
  return (await simctl('clone', sourceUdid, name)).trim();
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
  await simctl('delete', udid);
}

// Devices Hangar created carry this prefix, so it never touches anyone else's simulators.
export const NAME_PREFIX = 'hangar-';

export async function listOwned(): Promise<{ udid: string; name: string; state: string }[]> {
  const json = JSON.parse(await simctl('list', 'devices', '-j')) as {
    devices: Record<string, { udid: string; name: string; state: string }[]>;
  };
  return Object.values(json.devices)
    .flat()
    .filter((d) => d.name.startsWith(NAME_PREFIX))
    .map(({ udid, name, state }) => ({ udid, name, state }));
}

// Settle a fresh device: English locale, so labels match what tests and agents expect.
export async function prepareGolden(udid: string): Promise<void> {
  await simctl('bootstatus', udid, '-b');
  await simctl('spawn', udid, 'defaults', 'write', '-g', 'AppleLanguages', '-array', 'en');
  await simctl('spawn', udid, 'defaults', 'write', '-g', 'AppleLocale', 'en_US');
  await shutdown(udid);
}

// `maxSize` downscales the longest side with sips, which ships with macOS. A full-resolution
// JPEG is about 270 KB; at 800 px it is about 33 KB and takes 70 ms more.
export async function screenshot(udid: string, format: 'png' | 'jpeg' = 'png', maxSize?: number, quality = 70): Promise<Buffer> {
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
  const raw = JSON.parse(await idb(udid, 'ui', 'describe-all', '--json')) as IdbElement[];
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

// Input goes over the companion's gRPC session; see hid.ts.
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

// USB HID usage codes for the keys people ask for by name.
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
};

export async function key(udid: string, name: string): Promise<void> {
  const code = KEYS[name.toLowerCase()];
  if (code === undefined) {
    throw new DriverError('UNKNOWN_KEY', `Unknown key "${name}". Known keys: ${Object.keys(KEYS).join(', ')}.`);
  }
  await sendHid(udid, press({ key: code }));
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

export async function info(udid: string, model: string, os: string): Promise<DeviceInfo> {
  const [{ screen }, png] = await Promise.all([describe(udid), screenshot(udid, 'png')]);
  // PNG width sits in the IHDR chunk at byte 16.
  const scale = Math.round(png.readUInt32BE(16) / screen.width);
  return { platform: 'ios-simulator', model, os, screen: { width: screen.width, height: screen.height, scale } };
}

// Annex-B H.264 on stdout. The caller owns the process and kills it when the last viewer leaves.
const SCREEN_SOURCE = fileURLToPath(new URL('../native/screen.swift', import.meta.url));
let screenBuild: Promise<string> | null = null;

// Builds hangar-screen from source with the installed Swift toolchain, once per source version,
// so the repo ships no binaries and the helper matches the installed Xcode.
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
  stop: () => void;
  // Resolves when the helper exits, with its last error line if it failed.
  exited: Promise<string | null>;
};

// Streams the display as H.264. Each frame record is passed on unchanged: u8 flags (1 = keyframe),
// f64 capture time in ms since the epoch, u16 width, u16 height, then Annex B NAL units.
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
  proc.stderr.on('data', (d: Buffer) => {
    lastError = d.toString().trim().split('\n').at(-1) ?? lastError;
  });
  const exited = new Promise<string | null>((resolve) => proc.once('exit', (code) => resolve(code === 0 || code === null ? null : lastError ?? `exit ${code}`)));
  return {
    keyframe: () => {
      proc.stdin.write('k\n');
    },
    stop: () => {
      proc.stdin.end();
      proc.kill();
    },
    exited,
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
