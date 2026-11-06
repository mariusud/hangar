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
  | { type: 'key'; key: string }
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
  | { op: 'openUrl'; url: string };

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
  | { type: 'stream.keyframe'; leaseId: string };

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
  | { type: 'response'; id: number; ok: true; result?: unknown; binary?: string }
  | { type: 'response'; id: number; ok: false; error: { code: string; message: string } };

export type ErrorBody = { error: { code: string; message: string; hint?: string } };

// Messages a console viewer sends over the stream WebSocket. Only the lease holder's input is used.
export type ViewerInput =
  | { type: 'tap'; point: Point }
  | { type: 'swipe'; from: Point; to: Point; durationMs?: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: string }
  | { type: 'button'; button: 'home' | 'lock' | 'siri' }
  | { type: 'keyframe' };
