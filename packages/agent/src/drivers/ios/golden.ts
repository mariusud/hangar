import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DeviceImage, ImageSignIn, ImagesStatus, PrivacyService } from '@devicepool/protocol';
import { appearance, boot, DriverError, NAME_PREFIX, privacy, shutdown, simctl } from './index.ts';

const run = promisify(execFile);

export type Runtime = { identifier: string; version: string; name: string };
export type DeviceType = { identifier: string; name: string };

export async function runtimes(): Promise<Runtime[]> {
  const json: {
    runtimes: { identifier: string; version: string; name: string; isAvailable: boolean; platform?: string }[];
  } = JSON.parse(await simctl('list', 'runtimes', '-j'));
  return json.runtimes
    .filter((r) => r.isAvailable && r.identifier.includes('iOS'))
    .map(({ identifier, version, name }) => ({ identifier, version, name }));
}

export async function deviceTypes(): Promise<DeviceType[]> {
  const json: {
    devicetypes: { identifier: string; name: string; productFamily?: string }[];
  } = JSON.parse(await simctl('list', 'devicetypes', '-j'));
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

export async function setLocale(udid: string, locale: string): Promise<void> {
  await simctl('spawn', udid, 'defaults', 'write', '-g', 'AppleLanguages', '-array', locale.split('_')[0] ?? locale);
  await simctl('spawn', udid, 'defaults', 'write', '-g', 'AppleLocale', locale);
}

export async function prepareGolden(udid: string): Promise<void> {
  await simctl('bootstatus', udid, '-b');
  await simctl('spawn', udid, 'defaults', 'write', '-g', 'AppleLanguages', '-array', 'en');
  await simctl('spawn', udid, 'defaults', 'write', '-g', 'AppleLocale', 'en_US');
  await shutdown(udid);
}

export type ImageSteps = {
  boot: (udid: string) => Promise<void>;
  shutdown: (udid: string) => Promise<void>;
  install: (udid: string, app: { url: string; sha256: string }) => Promise<{ bundleId: string }>;
  grant: (udid: string, service: PrivacyService, bundleId: string) => Promise<void>;
  setLocale: (udid: string, locale: string) => Promise<void>;
  appearance: (udid: string, mode: 'light' | 'dark') => Promise<void>;
  signIn: (udid: string, flow: string, env: Record<string, string>) => Promise<void>;
};

export function imageSteps(install: ImageSteps['install']): ImageSteps {
  return {
    boot,
    shutdown,
    install,
    grant: (udid, service, bundleId) => privacy(udid, 'grant', service, bundleId),
    setLocale,
    appearance,
    signIn: runSignIn,
  };
}

export function signInEnv(signIn: ImageSignIn, hostEnv: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of signIn.env) {
    const value = signIn.values[name] ?? hostEnv[name];
    if (value === undefined || value === '') {
      missing.push(name);
    } else {
      env[name] = value;
    }
  }
  if (missing.length) {
    throw new DriverError(
      'SIGN_IN_ENV_MISSING',
      `The sign-in flow reads ${missing.join(', ')}, and neither the broker's secrets nor this Mac's environment has ${missing.length === 1 ? 'it' : 'them'}. Set ${missing.length === 1 ? 'it' : 'them'} with \`devicepool image secret <NAME>\`.`,
    );
  }
  return env;
}

export function redact(text: string, values: string[]): string {
  let out = text;
  for (const v of values.filter((v) => v.length > 0).sort((a, b) => b.length - a.length)) {
    out = out.split(v).join('***');
  }
  return out;
}

export async function buildImage(udid: string, image: DeviceImage, steps: ImageSteps, hostEnv: Record<string, string | undefined> = process.env): Promise<void> {
  const signIn = image.setup?.signIn;
  const env = signIn ? signInEnv(signIn, hostEnv) : {};
  await steps.boot(udid);
  const bundleIds: string[] = [];
  for (const app of image.apps) {
    bundleIds.push((await steps.install(udid, app)).bundleId);
  }
  for (const service of image.setup?.grants ?? []) {
    for (const bundleId of bundleIds) {
      await steps.grant(udid, service, bundleId);
    }
  }
  if (image.locale) {
    await steps.setLocale(udid, image.locale);
  }
  if (image.appearance) {
    await steps.appearance(udid, image.appearance);
  }
  if (signIn) {
    if (image.locale) {
      await steps.shutdown(udid);
      await steps.boot(udid);
    }
    await steps.signIn(udid, signIn.flow, env);
  }
  await steps.shutdown(udid);
}

export async function runSignIn(udid: string, flow: string, env: Record<string, string>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'devicepool-sign-in-'));
  try {
    const file = join(dir, 'sign-in.yaml');
    await writeFile(file, flow, { mode: 0o600 });
    const args = ['--no-ansi', '--device', udid, 'test', file, '--test-output-dir', join(dir, 'debug')];
    for (const [k, v] of Object.entries(env)) {
      args.push('-e', `${k}=${v}`);
    }
    await run('maestro', args, { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 }).catch((err: { stdout?: string; stderr?: string; code?: unknown }) => {
      if (err.code === 'ENOENT') {
        throw new DriverError('MAESTRO_MISSING', 'The image has a sign-in flow, and Maestro is not installed on this Mac. Install it with: curl -fsSL "https://get.maestro.mobile.dev" | bash');
      }
      const log = redact((err.stdout ?? '') + (err.stderr ?? ''), Object.values(env)).trim().slice(-2000);
      throw new DriverError('SIGN_IN_FAILED', `The sign-in flow failed:\n${log}`);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function goldenImageName(imageId: string, model: string, os: string): string {
  return `${NAME_PREFIX}golden-image-${imageId}-${model.replace(/\s+/g, '-')}-${os}`;
}

export type ImageSlot = { image: DeviceImage; golden: string | null; failed: boolean; message?: string };

export type ImagePlan = { slots: Map<string, ImageSlot>; drop: string[]; retire: string[] };

export function planImages(current: ReadonlyMap<string, ImageSlot>, wanted: DeviceImage[]): ImagePlan {
  const byName = new Map(wanted.map((i) => [i.name, i]));
  const slots = new Map<string, ImageSlot>();
  const drop: string[] = [];
  const retire: string[] = [];
  for (const [name, slot] of current) {
    const next = byName.get(name);
    if (next?.id === slot.image.id) {
      slots.set(name, slot.failed ? { image: next, golden: null, failed: false } : slot);
      continue;
    }
    drop.push(name);
    if (slot.golden) {
      retire.push(slot.golden);
    }
  }
  for (const image of wanted) {
    if (!slots.has(image.name)) {
      slots.set(image.name, { image, golden: null, failed: false });
    }
  }
  return { slots, drop, retire };
}

export function retirable(retiring: readonly string[], cloneOf: ReadonlyMap<string, string>, live: ReadonlySet<string>): string[] {
  const used = new Set<string>();
  for (const [device, golden] of cloneOf) {
    if (live.has(device)) {
      used.add(golden);
    }
  }
  return retiring.filter((g) => !used.has(g));
}

export function readyImages(slots: ReadonlyMap<string, ImageSlot>): string[] {
  return [...slots.values()].filter((s) => s.golden !== null && !s.failed).map((s) => s.image.name).sort();
}

const MAX_STATUS_MESSAGE = 2000;

export function imageStatus(slot: ImageSlot, building: boolean): ImagesStatus | null {
  const base: { type: 'images.status'; image: string; id: string } = { type: 'images.status', image: slot.image.name, id: slot.image.id };
  if (slot.failed) {
    const message = (slot.message ?? '').slice(-MAX_STATUS_MESSAGE);
    return message ? { ...base, state: 'failed', message } : { ...base, state: 'failed' };
  }
  if (slot.golden !== null) {
    return { ...base, state: 'ready' };
  }
  return building ? { ...base, state: 'building' } : null;
}
