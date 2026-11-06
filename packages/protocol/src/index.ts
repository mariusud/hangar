// Types shared by the broker, the agent and clients. No runtime code except constants.

export const PROTOCOL_VERSION = 1;

export type Platform = 'ios-simulator';

export type DeviceClass = {
  platform?: Platform;
  model?: string;
  os?: string;
  build?: string;
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
  | 'queue_timeout';

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

// Ops the broker may ask an agent to run. The agent maps leaseId to a device itself;
// no op carries a device id, a host path or a command.
export type Op =
  | { op: 'screenshot'; format?: 'png' | 'jpeg'; maxSize?: number }
  | { op: 'describe' }
  | { op: 'actions'; actions: Action[] }
  | { op: 'install'; artifactUrl: string; sha256: string }
  | { op: 'launch'; bundleId: string; args?: string[] }
  | { op: 'terminate'; bundleId: string }
  | { op: 'uninstall'; bundleId: string }
  | { op: 'openUrl'; url: string }
  // Points a React Native debug build at the lease's Metro tunnel (sets RCT_jsLocation).
  | { op: 'useMetro'; bundleId: string }
  // Device presets. The agent checks every value before it reaches simctl.
  | { op: 'push'; bundleId: string; payload: Record<string, unknown> }
  | { op: 'permission'; bundleId: string; service: PrivacyService; action: 'grant' | 'revoke' | 'reset' }
  | { op: 'location'; lat: number; lon: number }
  | { op: 'clearLocation' }
  | { op: 'appearance'; mode: 'light' | 'dark' }
  | { op: 'locale'; bundleId: string; language: string }
  // Runs Maestro flows on the leased device. archive is a base64 tar of the flows folder; flows
  // are paths inside it.
  | { op: 'maestro'; archive: string; flows: string[]; env?: Record<string, string> };

export type MaestroResult = { passed: boolean; junit: string; log: string; durationMs: number };

export const PRIVACY_SERVICES = ['all', 'calendar', 'contacts', 'contacts-limited', 'location', 'location-always', 'photos', 'photos-add', 'media-library', 'microphone', 'motion', 'reminders', 'siri'] as const;
export type PrivacyService = (typeof PRIVACY_SERVICES)[number];

export type KeyModifier = 'command' | 'shift' | 'option' | 'control';

export type OpName = Op['op'];

export type ActionResult = { ok: true } | { ok: false; error: { code: string; message: string } };

// Messages from broker to agent.
export type BrokerMessage =
  | { type: 'welcome'; hostId: string }
  | { type: 'incompatible'; message: string }
  | { type: 'pool'; targets: { model: string; os: string; count: number }[] }
  | { type: 'lease.prepare'; id: number; leaseId: string; deviceId: string; deadline: number }
  | { type: 'lease.end'; leaseId: string }
  | { type: 'op'; id: number; leaseId: string; body: Op }
  | { type: 'stream.start'; leaseId: string; codec: StreamCodec }
  | { type: 'stream.stop'; leaseId: string; codec: StreamCodec }
  | { type: 'stream.keyframe'; leaseId: string }
  // The Metro tunnel: the agent listens on the Mac's loopback for the lease's simulator, and each
  // connection is carried to the lease holder's machine through the broker.
  | { type: 'tunnel.start'; id: number; leaseId: string }
  | { type: 'tunnel.stop'; leaseId: string }
  | TunnelData;

export type TunnelData =
  | { type: 'tunnel.data'; leaseId: string; conn: number; data: Uint8Array }
  | { type: 'tunnel.close'; leaseId: string; conn: number };

// h264 is the native helper's frame record; jpeg is the fallback for browsers without WebCodecs.
export type StreamCodec = 'h264' | 'jpeg';

export type AgentDevice = {
  deviceId: string;
  model: string;
  os: string;
  state: 'ready' | 'busy' | 'wiping' | 'quarantined';
};

// Messages from agent to broker.
export type AgentMessage =
  | {
      type: 'hello';
      protocol: number;
      hostName: string;
      versions: Record<string, string>;
      memoryBytes: number;
      // What this host can create, so leases queue while its pool is still booting.
      offers: { model: string; os: string }[];
      devices: AgentDevice[];
      leases: string[];
    }
  | { type: 'inventory'; devices: AgentDevice[] }
  // Sent as a binary WebSocket frame between processes; passed as bytes in one process.
  | { type: 'stream.frame'; leaseId: string; codec: StreamCodec; data: Uint8Array }
  | { type: 'stream.failed'; leaseId: string; codec: StreamCodec; message: string }
  | { type: 'tunnel.open'; leaseId: string; conn: number }
  | TunnelData
  | { type: 'response'; id: number; ok: true; result?: unknown; binary?: string }
  | { type: 'response'; id: number; ok: false; error: { code: string; message: string } };

export type ErrorBody = { error: { code: string; message: string; hint?: string } };

// Messages a console viewer sends over the stream WebSocket. Only the lease holder's input is used.
export type ViewerInput =
  | { type: 'tap'; point: Point }
  | { type: 'swipe'; from: Point; to: Point; durationMs?: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string; modifiers?: KeyModifier[] }
  | { type: 'button'; button: 'home' | 'lock' | 'siri' }
  | { type: 'keyframe' };
