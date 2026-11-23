import type { ParseArgsConfig } from 'node:util';

type Options = NonNullable<ParseArgsConfig['options']>;

export const UP_OPTIONS = { port: { type: 'string' }, warm: { type: 'string' }, max: { type: 'string' }, url: { type: 'string' }, android: { type: 'string' }, phones: { type: 'boolean' }, install: { type: 'boolean' }, uninstall: { type: 'boolean' }, system: { type: 'boolean' }, user: { type: 'string' } } satisfies Options;

export const BROKER_OPTIONS = { port: { type: 'string' }, url: { type: 'string' }, host: { type: 'string' } } satisfies Options;

export const JOIN_OPTIONS = { token: { type: 'string' }, warm: { type: 'string' }, max: { type: 'string' }, android: { type: 'string' }, phones: { type: 'boolean' } } satisfies Options;

export const RUN_IOS_OPTIONS = { app: { type: 'string' }, build: { type: 'string' }, port: { type: 'string', multiple: true }, scheme: { type: 'string' }, model: { type: 'string' }, lease: { type: 'string' } } satisfies Options;

export const RUN_ANDROID_OPTIONS = { app: { type: 'string' }, build: { type: 'string' }, port: { type: 'string', multiple: true }, lease: { type: 'string' } } satisfies Options;

export const RUN_MAESTRO_OPTIONS = {
  app: { type: 'string' },
  shards: { type: 'string' },
  retries: { type: 'string' },
  junit: { type: 'string' },
  model: { type: 'string' },
  env: { type: 'string', short: 'e', multiple: true },
  rerun: { type: 'string' },
  flow: { type: 'string' },
  hold: { type: 'string' },
  booking: { type: 'string' },
  'build-name': { type: 'string' },
} satisfies Options;

export const RUN_XCUITEST_OPTIONS = { tests: { type: 'string' }, shards: { type: 'string' }, retries: { type: 'string' }, junit: { type: 'string' }, model: { type: 'string' }, booking: { type: 'string' }, 'build-name': { type: 'string' } } satisfies Options;

export const RUN_ESPRESSO_OPTIONS = { app: { type: 'string' }, 'test-apk': { type: 'string' }, tests: { type: 'string' }, shards: { type: 'string' }, retries: { type: 'string' }, junit: { type: 'string' }, booking: { type: 'string' }, 'build-name': { type: 'string' } } satisfies Options;

export const IMAGE_SET_OPTIONS = { app: { type: 'string', multiple: true }, follow: { type: 'boolean' }, locale: { type: 'string' }, appearance: { type: 'string' }, grant: { type: 'string', multiple: true }, 'sign-in': { type: 'string' }, env: { type: 'string', multiple: true } } satisfies Options;

export const IMAGE_REFRESH_OPTIONS = { app: { type: 'string', multiple: true } } satisfies Options;

export const LEASE_OPTIONS = { android: { type: 'boolean' }, phone: { type: 'boolean' }, model: { type: 'string' }, os: { type: 'string' }, image: { type: 'string' }, hold: { type: 'boolean' }, ttl: { type: 'string' }, idle: { type: 'string' }, max: { type: 'string' }, record: { type: 'boolean' }, purpose: { type: 'string' } } satisfies Options;

export const BOOK_OPTIONS = { devices: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, days: { type: 'string' }, image: { type: 'string' }, android: { type: 'boolean' }, model: { type: 'string' }, os: { type: 'string' }, team: { type: 'string' } } satisfies Options;

export const LEASE_FLAG = { lease: { type: 'string' } } satisfies Options;

export const SCREENSHOT_OPTIONS = { ...LEASE_FLAG, out: { type: 'string', short: 'o' } } satisfies Options;

export const UI_OPTIONS = { ...LEASE_FLAG, json: { type: 'boolean' } } satisfies Options;

export const TAP_OPTIONS = { ...LEASE_FLAG, label: { type: 'string' }, id: { type: 'string' }, role: { type: 'string' }, point: { type: 'string' } } satisfies Options;

export const INSTALL_OPTIONS = { ...LEASE_FLAG, launch: { type: 'boolean' }, 'build-name': { type: 'string' } } satisfies Options;

export const ATTACH_OPTIONS = { hold: { type: 'boolean' } } satisfies Options;

export const NIGHT_OPTIONS = { format: { type: 'string' }, 'slack-webhook': { type: 'string' }, booking: { type: 'string' } } satisfies Options;

export const OPTION_TABLES: Record<string, Options> = {
  up: UP_OPTIONS,
  broker: BROKER_OPTIONS,
  join: JOIN_OPTIONS,
  'run ios': RUN_IOS_OPTIONS,
  'run android': RUN_ANDROID_OPTIONS,
  'run maestro': RUN_MAESTRO_OPTIONS,
  'run xcuitest': RUN_XCUITEST_OPTIONS,
  'run espresso': RUN_ESPRESSO_OPTIONS,
  'image set': IMAGE_SET_OPTIONS,
  'image refresh': IMAGE_REFRESH_OPTIONS,
  lease: LEASE_OPTIONS,
  book: BOOK_OPTIONS,
  screenshot: SCREENSHOT_OPTIONS,
  ui: UI_OPTIONS,
  tap: TAP_OPTIONS,
  install: INSTALL_OPTIONS,
  attach: ATTACH_OPTIONS,
  night: NIGHT_OPTIONS,
};
