import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PRIVACY_SERVICES, type BrokerMessage, type DeviceImage, type ImageBuildState, type Platform, type PrivacyService } from '@hangar/protocol';
import * as auth from './auth.ts';
import type { Db, ImageSpec } from './db.ts';
import { ApiError } from './leases/service.ts';

// follow: an upload of a build named like one of the image's apps refreshes the image.
export type ImageSetupSpec = { grants?: PrivacyService[]; signIn?: { flow: string; env: string[] }; follow?: boolean };

export const MAX_FLOW_BYTES = 64 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isPrivacyService(s: string): s is PrivacyService {
  return PRIVACY_SERVICES.some((p) => p === s);
}

// Images declared before setups existed keep their id, so hosts do not rebuild them.
export function imageId(spec: ImageSpec, setup: ImageSetupSpec = {}): string {
  const parts: unknown[] = [spec.name.toLowerCase(), spec.apps, spec.locale ?? null, spec.appearance ?? null];
  if (setup.grants?.length || setup.signIn) {
    parts.push(setup.grants ?? [], setup.signIn ? [sha256(setup.signIn.flow), setup.signIn.env] : null);
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

export function isEnvName(name: string): boolean {
  return ENV_NAME.test(name);
}

// Checks a declaration from the API or the database. Grants and env names come back sorted and unique.
export function parseImageSetup(input: { grants?: unknown; signIn?: unknown; follow?: unknown }): ImageSetupSpec {
  const setup: ImageSetupSpec = {};
  if (input.follow !== undefined && input.follow !== null && typeof input.follow !== 'boolean') {
    throw new ApiError(400, 'BAD_FOLLOW', 'follow is true or false.');
  }
  if (input.follow) {
    setup.follow = true;
  }
  if (input.grants !== undefined && input.grants !== null) {
    if (!Array.isArray(input.grants)) {
      throw new ApiError(400, 'BAD_GRANTS', 'grants is a list of services, such as ["photos", "location"].');
    }
    const grants = new Set<PrivacyService>();
    for (const g of input.grants) {
      const name = String(g);
      if (name === 'camera') {
        throw new ApiError(400, 'BAD_GRANT', 'The iOS simulator has no camera, and simctl privacy cannot grant it.', `Grant one of: ${PRIVACY_SERVICES.join(', ')}.`);
      }
      if (!isPrivacyService(name)) {
        throw new ApiError(400, 'BAD_GRANT', `${name} is not a permission the simulator can grant.`, `Grant one of: ${PRIVACY_SERVICES.join(', ')}.`);
      }
      grants.add(name);
    }
    if (grants.size) {
      setup.grants = [...grants].sort();
    }
  }
  if (input.signIn !== undefined && input.signIn !== null) {
    const s = input.signIn;
    if (typeof s !== 'object' || !('flow' in s) || typeof s.flow !== 'string' || !s.flow.trim()) {
      throw new ApiError(400, 'BAD_SIGN_IN', 'signIn needs flow, the text of one Maestro flow file.');
    }
    if (Buffer.byteLength(s.flow) > MAX_FLOW_BYTES) {
      throw new ApiError(400, 'BAD_SIGN_IN', `The sign-in flow is over ${MAX_FLOW_BYTES / 1024} KB.`);
    }
    const env = new Set<string>();
    const raw = 'env' in s ? s.env : undefined;
    if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
      throw new ApiError(400, 'BAD_SIGN_IN', 'signIn.env is a list of environment variable names, not values.');
    }
    for (const e of raw ?? []) {
      const name = String(e);
      if (!isEnvName(name)) {
        throw new ApiError(400, 'BAD_ENV_NAME', `${name} is not an environment variable name. Use letters, digits and underscores.`);
      }
      env.add(name);
    }
    if (env.size > 32) {
      throw new ApiError(400, 'BAD_SIGN_IN', 'A sign-in flow reads at most 32 environment variables.');
    }
    setup.signIn = { flow: s.flow, env: [...env].sort() };
  }
  return setup;
}

export function loadImageSetup(db: Db, name: string): ImageSetupSpec {
  const raw = db.imageSetup(name);
  return raw ? parseImageSetup(JSON.parse(raw)) : {};
}

export function saveImageSetup(db: Db, name: string, setup: ImageSetupSpec): void {
  db.saveImageSetup(name, setup.grants || setup.signIn || setup.follow ? JSON.stringify(setup) : null);
}

// What the API shows: the flow by its hash and the names it reads, never secret values.
type ImageView = ImageSpec & { id: string; grants?: PrivacyService[]; signIn?: { sha256: string; env: string[] }; follow?: boolean };

export function imageView(spec: ImageSpec, setup: ImageSetupSpec): ImageView {
  const view: ImageView = { ...spec, id: imageId(spec, setup) };
  if (setup.follow) {
    view.follow = true;
  }
  if (setup.grants) {
    view.grants = setup.grants;
  }
  if (setup.signIn) {
    view.signIn = { sha256: sha256(setup.signIn.flow), env: setup.signIn.env };
  }
  return view;
}

// Each link is good for one download within an hour, enough for a host building every image after it connects.
export function imagesMessage(db: Db, internalUrl: string): BrokerMessage {
  const images: DeviceImage[] = db.images().map((spec) => {
    const setup = loadImageSetup(db, spec.name);
    const image: DeviceImage = {
      id: imageId(spec, setup),
      name: spec.name,
      apps: spec.apps.map((sha256) => ({ sha256, url: `${internalUrl}/v1/artifacts/${sha256}?t=${auth.mintToken(db, 'artifact', { expiresAt: Date.now() + 60 * 60_000 })}` })),
    };
    if (spec.locale) {
      image.locale = spec.locale;
    }
    if (spec.appearance) {
      image.appearance = spec.appearance;
    }
    if (setup.grants || setup.signIn) {
      image.setup = {};
      if (setup.grants) {
        image.setup.grants = setup.grants;
      }
      if (setup.signIn) {
        image.setup.signIn = { ...setup.signIn, values: imageSecretValues(db, setup.signIn.env) };
      }
    }
    return image;
  });
  return { type: 'images', images };
}

type Build = { sha256: string; name: string };

// Each new build takes the place of the image's app with the same build name. An image with one
// app takes a single new build whatever its name.
export function refreshApps(current: Build[], builds: Build[]): string[] {
  if (!builds.length) {
    throw new ApiError(400, 'NO_BUILD', 'Send the new build as {"apps": ["App.app"]}, by build name or sha256.', 'Upload it first with POST /v1/builds.');
  }
  const apps = current.map((b) => b.sha256);
  for (const build of builds) {
    let at = current.findIndex((b) => b.name === build.name);
    if (at < 0 && current.length === 1 && builds.length === 1) {
      at = 0;
    }
    if (at < 0) {
      const names = current.map((b) => b.name).join(', ') || 'none';
      throw new ApiError(400, 'WHICH_APP', `The image has no app built as ${build.name}, so Hangar can't tell which app it replaces. Its apps: ${names}.`, 'Upload the build under the same name, or declare the image again with `hangar image set`.');
    }
    apps[at] = build.sha256;
  }
  return apps;
}

export type ImageHostState = { host: string; state: 'ready' | 'pending' | 'building' | 'failed'; message?: string };

export type ImageStatus = { state: ImageBuildState; message?: string };

type HostView = { name: string; connected: boolean; offers: { model: string; os: string; platform?: Platform; image?: string }[]; images?: ReadonlyMap<string, ImageStatus> };

// A host offers an image once the golden for its current declaration (id) is built. Until then it
// is building, failed with the host's message, or pending while the host has not said.
export function imageHosts(name: string, hosts: HostView[], id?: string): { state: 'ready' | 'pending' | 'failed' | 'no-hosts'; hosts: ImageHostState[] } {
  const ios = hosts.filter((h) => h.connected && h.offers.some((o) => (o.platform ?? 'ios-simulator') === 'ios-simulator'));
  const out: ImageHostState[] = ios.map((h) => {
    if (h.offers.some((o) => o.image?.toLowerCase() === name.toLowerCase())) {
      return { host: h.name, state: 'ready' };
    }
    const status = id === undefined ? undefined : h.images?.get(id);
    if (status?.state === 'failed') {
      return status.message ? { host: h.name, state: 'failed', message: status.message } : { host: h.name, state: 'failed' };
    }
    return { host: h.name, state: status?.state === 'building' ? 'building' : 'pending' };
  });
  if (!out.length) {
    return { state: 'no-hosts', hosts: out };
  }
  if (out.every((h) => h.state === 'ready')) {
    return { state: 'ready', hosts: out };
  }
  return { state: out.every((h) => h.state === 'failed') ? 'failed' : 'pending', hosts: out };
}

// A lease on an image that failed on every connected Mac would wait forever, so it is refused.
export function imageFailure(db: Db, hosts: HostView[], name: string): ApiError | null {
  const spec = db.images().find((i) => i.name.toLowerCase() === name.toLowerCase());
  if (!spec) {
    return null;
  }
  const view = imageHosts(spec.name, hosts, imageId(spec, loadImageSetup(db, spec.name)));
  if (view.state !== 'failed') {
    return null;
  }
  const why = view.hosts.map((h) => `${h.host}: ${h.message ?? 'no reason given'}`).join('\n');
  return new ApiError(
    409,
    'IMAGE_FAILED',
    `Image ${spec.name} failed to build on every connected Mac.\n${why}`,
    'Fix what the message says, for example set a missing value with `hangar image secret <NAME>` or upload a working build, then run `hangar image set` again. Each Mac builds a failed image again when the broker sends it images.',
  );
}

export function imageBuilds(db: Db, spec: ImageSpec): Build[] {
  return spec.apps.map((sha256) => ({ sha256, name: db.getBuild(sha256)?.name ?? sha256.slice(0, 12) }));
}

// An upload refreshes each image that follows its builds and has an app built under the same name.
export function followUpload(db: Db, build: Build): string[] {
  const refreshed: string[] = [];
  for (const spec of db.images()) {
    if (!loadImageSetup(db, spec.name).follow) {
      continue;
    }
    const current = imageBuilds(db, spec);
    if (!current.some((b) => b.name === build.name) || current.some((b) => b.sha256 === build.sha256)) {
      continue;
    }
    db.saveImage({ ...spec, apps: refreshApps(current, [build]) });
    refreshed.push(spec.name);
  }
  return refreshed;
}

// Secret values are stored encrypted with AES-256-GCM. The key is a file next to the database,
// made on first use and readable only by the broker's user. Each value is bound to its name.
const SEALED = 'aes-256-gcm:';
const secretKeys = new WeakMap<Db, Buffer>();

function secretKey(db: Db): Buffer {
  const known = secretKeys.get(db);
  if (known) {
    return known;
  }
  const row = db.sql.prepare("select file from pragma_database_list where name = 'main'").get();
  const dbFile = row && typeof row.file === 'string' ? row.file : '';
  let key: Buffer;
  if (!dbFile) {
    key = randomBytes(32);
  } else {
    const file = join(dirname(dbFile), 'image-secrets.key');
    try {
      writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) {
        throw err;
      }
    }
    key = readFileSync(file);
    if (key.length !== 32) {
      throw new Error(`${file} is not a Hangar secret key. Move it away, then set the image secrets again with \`hangar image secret\`.`);
    }
  }
  secretKeys.set(db, key);
  sealPlaintext(db, key);
  return key;
}

export function sealSecret(key: Buffer, name: string, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(name));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return SEALED + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}

// Null when the value was sealed with another key or for another name.
export function openSecret(key: Buffer, name: string, sealed: string): string | null {
  if (!sealed.startsWith(SEALED)) {
    return null;
  }
  const raw = Buffer.from(sealed.slice(SEALED.length), 'base64url');
  if (raw.length < 28) {
    return null;
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function sealPlaintext(db: Db, key: Buffer): void {
  const rows = db.imageSecrets();
  const values = db.imageSecretValues(rows.map((r) => r.name));
  for (const r of rows) {
    const value = values[r.name];
    if (value !== undefined && !value.startsWith(SEALED)) {
      db.saveImageSecret(r.name, sealSecret(key, r.name, value), r.updatedAt);
    }
  }
}

// Makes the key if there is none and encrypts any value stored before encryption existed.
// The broker calls it on start; every other secret read or write does it too.
export function sealStoredSecrets(db: Db): void {
  secretKey(db);
}

export function saveImageSecret(db: Db, name: string, value: string, at: number): void {
  db.saveImageSecret(name, sealSecret(secretKey(db), name, value), at);
}

export function imageSecretValues(db: Db, names: string[]): Record<string, string> {
  const key = secretKey(db);
  const values: Record<string, string> = {};
  for (const [name, sealed] of Object.entries(db.imageSecretValues(names))) {
    const value = openSecret(key, name, sealed);
    if (value !== null) {
      values[name] = value;
    }
  }
  return values;
}

// Names and times only. unreadable marks a value the key cannot open, for example after the key file was lost.
export function imageSecretList(db: Db): { name: string; updatedAt: number; unreadable?: true }[] {
  const secrets = db.imageSecrets();
  const readable = imageSecretValues(db, secrets.map((s) => s.name));
  return secrets.map((s) => (Object.hasOwn(readable, s.name) ? s : { ...s, unreadable: true }));
}
