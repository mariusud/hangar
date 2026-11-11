import { createHash } from 'node:crypto';
import { PRIVACY_SERVICES, type BrokerMessage, type DeviceImage, type Platform, type PrivacyService } from '@hangar/protocol';
import * as auth from './auth.ts';
import type { Db, ImageSpec } from './db.ts';
import { ApiError } from './leases/service.ts';

export type ImageSetupSpec = { grants?: PrivacyService[]; signIn?: { flow: string; env: string[] } };

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
export function parseImageSetup(input: { grants?: unknown; signIn?: unknown }): ImageSetupSpec {
  const setup: ImageSetupSpec = {};
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
  db.saveImageSetup(name, setup.grants || setup.signIn ? JSON.stringify(setup) : null);
}

// What the API shows: the flow by its hash and the names it reads, never secret values.
export function imageView(spec: ImageSpec, setup: ImageSetupSpec): ImageSpec & { id: string; grants?: PrivacyService[]; signIn?: { sha256: string; env: string[] } } {
  const view: ImageSpec & { id: string; grants?: PrivacyService[]; signIn?: { sha256: string; env: string[] } } = { ...spec, id: imageId(spec, setup) };
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
        image.setup.signIn = { ...setup.signIn, values: db.imageSecretValues(setup.signIn.env) };
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

export type ImageHostState = { host: string; state: 'ready' | 'pending' };

type HostView = { name: string; connected: boolean; offers: { model: string; os: string; platform?: Platform; image?: string }[] };

// A host offers an image once the golden for its current declaration is built. Until then it is
// pending: building, or failed, in which case the host's log says why.
export function imageHosts(name: string, hosts: HostView[]): { state: 'ready' | 'pending' | 'no-hosts'; hosts: ImageHostState[] } {
  const ios = hosts.filter((h) => h.connected && h.offers.some((o) => (o.platform ?? 'ios-simulator') === 'ios-simulator'));
  const out: ImageHostState[] = ios.map((h) => ({
    host: h.name,
    state: h.offers.some((o) => o.image?.toLowerCase() === name.toLowerCase()) ? 'ready' : 'pending',
  }));
  if (!out.length) {
    return { state: 'no-hosts', hosts: out };
  }
  return { state: out.every((h) => h.state === 'ready') ? 'ready' : 'pending', hosts: out };
}

export function imageBuilds(db: Db, spec: ImageSpec): Build[] {
  return spec.apps.map((sha256) => ({ sha256, name: db.getBuild(sha256)?.name ?? sha256.slice(0, 12) }));
}
