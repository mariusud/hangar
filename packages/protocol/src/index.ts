import type { ImageSetup } from './images.ts';
import type { DeviceToolOp } from './devicetools.ts';

export const PROTOCOL_VERSION = 1;

export type Platform = 'ios-simulator' | 'android-emulator';

export type DeviceClass = {
  platform?: Platform;
  model?: string;
  os?: string;
  build?: string;
  image?: string;
};

export type DeviceImage = {
  id: string;
  name: string;
  locale?: string;
  appearance?: 'light' | 'dark';
  apps: { url: string; sha256: string }[];
  setup?: ImageSetup;
};

export type DeviceInfo = {
  platform: Platform;
  model: string;
  os: string;
  screen: { width: number; height: number; scale: number };
};

export type LeaseState = 'queued' | 'preparing' | 'active' | 'ended';

export type LeaseEndReason =
  | 'released'
  | 'expired'
  | 'idle'
  | 'revoked'
  | 'device_lost'
  | 'failed'
  | 'cancelled'
  | 'queue_timeout'
  | 'preempted'
  | 'window_closed';

/** Who a lease limit applies to: a person by account role, or a token made for an agent. */
export type LimitRole = 'member' | 'operator' | 'agent';

/** How long a lease lasts: ended after `idleMs` without use, `maxMs` after it started, or `ttlMs` after the last renew. */
export type LeaseLimits = { idleMs: number; maxMs: number; ttlMs: number; graceMs: number };

/** What a token allows its leases; `graceMs` is how long a lease that lost its client is kept from going idle. */
export type TokenLimits = { agent: boolean; idleMs: number; maxMs: number; graceMs: number };

export type Point = [number, number];

export type ElementSelector = {
  label?: string;
  identifier?: string;
  role?: string;
  exact?: boolean;
};

export type Action =
  | { type: 'tap'; point: Point }
  | { type: 'tap'; element: ElementSelector }
  | { type: 'longPress'; point: Point; durationMs?: number }
  | { type: 'swipe'; from: Point; to: Point; durationMs?: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string; modifiers?: KeyModifier[] }
  | { type: 'button'; button: 'home' | 'lock' | 'siri' }
  | { type: 'waitFor'; element: ElementSelector; gone?: boolean; timeoutMs?: number };

export type Frame = { x: number; y: number; width: number; height: number };

export type UiNode = {
  role: string;
  label: string | null;
  value: string | null;
  identifier: string | null;
  enabled: boolean;
  frame: Frame;
  normalized: Frame;
};

export type Op =
  | { op: 'screenshot'; format?: 'png' | 'jpeg'; maxSize?: number }
  | { op: 'describe' }
  | { op: 'actions'; actions: Action[] }
  | { op: 'install'; artifactUrl: string; sha256: string }
  | { op: 'launch'; bundleId: string; args?: string[] }
  | { op: 'terminate'; bundleId: string }
  | { op: 'uninstall'; bundleId: string }
  | { op: 'openUrl'; url: string }
  | { op: 'useMetro'; bundleId: string }
  | { op: 'push'; bundleId: string; payload: Record<string, unknown> }
  | { op: 'permission'; bundleId: string; service: PrivacyService; action: 'grant' | 'revoke' | 'reset' }
  | { op: 'location'; lat: number; lon: number }
  | { op: 'clearLocation' }
  | { op: 'appearance'; mode: 'light' | 'dark' }
  | { op: 'locale'; bundleId: string; language: string }
  | { op: 'maestro'; archive: string; flows: string[]; env?: Record<string, string> }
  | { op: 'xcuitest'; artifactUrl: string; sha256: string; tests: string[] }
  | { op: 'espresso'; app: { url: string; sha256: string }; testApp: { url: string; sha256: string }; tests: string[] }
  | { op: 'recordStart'; uploads: { video: string; log: string; screenshot: string } }
  | { op: 'recordStop' }
  | DeviceToolOp;

export type MaestroResult = { passed: boolean; junit: string; log: string; durationMs: number };

export type TestCase = { target: string; className: string; name: string; status: 'passed' | 'failed'; seconds: number; message?: string };
export type TestResult = { passed: boolean; cases: TestCase[]; log: string; durationMs: number };

export const PRIVACY_SERVICES = ['all', 'calendar', 'contacts', 'contacts-limited', 'location', 'location-always', 'photos', 'photos-add', 'media-library', 'microphone', 'motion', 'reminders', 'siri'] as const;
export type PrivacyService = (typeof PRIVACY_SERVICES)[number];

export type KeyModifier = 'command' | 'shift' | 'option' | 'control';

export type OpName = Op['op'];

export type ActionResult = { ok: true } | { ok: false; error: { code: string; message: string } };

export type BrokerMessage =
  | { type: 'welcome'; hostId: string }
  | { type: 'incompatible'; message: string }
  | { type: 'pool'; targets: { model: string; os: string; count: number }[] }
  | { type: 'images'; images: DeviceImage[] }
  | { type: 'lease.prepare'; id: number; leaseId: string; deviceId: string; deadline: number }
  | { type: 'lease.end'; leaseId: string }
  | { type: 'op'; id: number; leaseId: string; body: Op }
  | { type: 'stream.start'; leaseId: string; codec: StreamCodec }
  | { type: 'stream.stop'; leaseId: string; codec: StreamCodec }
  | { type: 'stream.keyframe'; leaseId: string }
  | { type: 'tunnel.start'; id: number; leaseId: string }
  | { type: 'tunnel.stop'; leaseId: string }
  | TunnelData;

export type TunnelData =
  | { type: 'tunnel.data'; leaseId: string; conn: number; data: Uint8Array }
  | { type: 'tunnel.close'; leaseId: string; conn: number };

export type StreamCodec = 'h264' | 'jpeg';

export type AgentDevice = {
  deviceId: string;
  model: string;
  os: string;
  state: 'ready' | 'busy' | 'wiping' | 'quarantined';
  platform?: Platform;
  image?: string;
};

/** A device's state as the broker sees it: what its host reports, or `held` while a failed run flow keeps it. */
export type DeviceState = AgentDevice['state'] | 'held';

export type AgentMessage =
  | {
      type: 'hello';
      protocol: number;
      hostName: string;
      versions: Record<string, string>;
      memoryBytes: number;
      offers: { model: string; os: string; platform?: Platform; image?: string }[];
      devices: AgentDevice[];
      leases: string[];
    }
  | { type: 'inventory'; devices: AgentDevice[] }
  | { type: 'stream.frame'; leaseId: string; codec: StreamCodec; data: Uint8Array }
  | { type: 'stream.failed'; leaseId: string; codec: StreamCodec; message: string }
  | { type: 'tunnel.open'; leaseId: string; conn: number }
  | TunnelData
  | { type: 'response'; id: number; ok: true; result?: unknown; binary?: string }
  | { type: 'response'; id: number; ok: false; error: { code: string; message: string } }
  | ImagesStatus;

export type ErrorBody = { error: { code: string; message: string; hint?: string } };

export type ViewerInput =
  | { type: 'tap'; point: Point }
  | { type: 'swipe'; from: Point; to: Point; durationMs?: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string; modifiers?: KeyModifier[] }
  | { type: 'button'; button: 'home' | 'lock' | 'siri' }
  | { type: 'keyframe' };

// Messages with bytes in `data` go as a binary frame: 4-byte big-endian header length, JSON header, then the bytes.
export function encodeMessage(m: AgentMessage | BrokerMessage): string | Buffer {
  if (!('data' in m) || !(m.data instanceof Uint8Array)) {
    return JSON.stringify(m);
  }
  const { data, ...rest } = m;
  const header = Buffer.from(JSON.stringify(rest));
  const out = Buffer.allocUnsafe(4 + header.length + data.length);
  out.writeUInt32BE(header.length, 0);
  header.copy(out, 4);
  out.set(data, 4 + header.length);
  return out;
}

export function decodeMessage<T extends AgentMessage | BrokerMessage>(raw: Buffer, isBinary: boolean): T {
  if (!isBinary) {
    return JSON.parse(raw.toString('utf8'));
  }
  const length = raw.readUInt32BE(0);
  return { ...JSON.parse(raw.subarray(4, 4 + length).toString('utf8')), data: raw.subarray(4 + length) };
}

export * from './schedule.ts';
export * from './findings.ts';
export * from './devicetools.ts';
export * from './images.ts';
export * from './capture.ts';

export type ImageBuildState = 'building' | 'ready' | 'failed';

/** How a host's build of one image declaration went. `image` is the image name, `id` its declaration id. */
export type ImagesStatus = { type: 'images.status'; image: string; id: string; state: ImageBuildState; message?: string };
