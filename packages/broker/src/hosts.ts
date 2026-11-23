
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, type AgentDevice, type AgentMessage, type BrokerMessage, type ImageBuildState, type Platform, type StreamCodec } from '@devicepool/protocol';

export type HostLink = {
  send(message: BrokerMessage): void;
  close(): void;
};

export type Host = {
  id: string;
  name: string;
  versions: Record<string, string>;
  memoryBytes: number;
  offers: { model: string; os: string; platform?: Platform; image?: string }[];
  devices: AgentDevice[];
  connected: boolean;
  lostAt: number | null;
  link: HostLink;
  images: Map<string, { state: ImageBuildState; message?: string }>;
};

export class HostError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type Read<T> = { ok: true; value: T } | { ok: false; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPlatform(v: unknown): v is Platform {
  return v === 'ios-simulator' || v === 'android-emulator' || v === 'android-device';
}

function readStrings(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x): x is string => typeof x === 'string') ? v : null;
}

function readDevices(v: unknown): AgentDevice[] | null {
  if (!Array.isArray(v)) {
    return null;
  }
  const out: AgentDevice[] = [];
  for (const d of v) {
    if (!isRecord(d) || typeof d.deviceId !== 'string' || typeof d.model !== 'string' || typeof d.os !== 'string') {
      return null;
    }
    const { state } = d;
    if (state !== 'ready' && state !== 'busy' && state !== 'wiping' && state !== 'quarantined') {
      return null;
    }
    if ((d.platform !== undefined && !isPlatform(d.platform)) || (d.image !== undefined && typeof d.image !== 'string') || (d.note !== undefined && typeof d.note !== 'string')) {
      return null;
    }
    out.push({ deviceId: d.deviceId, model: d.model, os: d.os, state, ...(d.platform ? { platform: d.platform } : {}), ...(d.image ? { image: d.image } : {}), ...(d.note ? { note: d.note } : {}) });
  }
  return out;
}

function readOffers(v: unknown): Host['offers'] | null {
  if (!Array.isArray(v)) {
    return null;
  }
  const out: Host['offers'] = [];
  for (const o of v) {
    if (!isRecord(o) || typeof o.model !== 'string' || typeof o.os !== 'string') {
      return null;
    }
    if ((o.platform !== undefined && !isPlatform(o.platform)) || (o.image !== undefined && typeof o.image !== 'string')) {
      return null;
    }
    out.push({ model: o.model, os: o.os, ...(o.platform ? { platform: o.platform } : {}), ...(o.image ? { image: o.image } : {}) });
  }
  return out;
}

function readVersions(v: unknown): Record<string, string> | null {
  if (!isRecord(v)) {
    return null;
  }
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== 'string') {
      return null;
    }
    out[k] = x;
  }
  return out;
}

export function readAgentMessage(v: unknown): Read<AgentMessage> {
  if (!isRecord(v) || typeof v.type !== 'string') {
    return { ok: false, reason: 'it has no `type`' };
  }
  const bad = (reason: string): Read<AgentMessage> => ({ ok: false, reason });
  switch (v.type) {
    case 'hello': {
      const versions = readVersions(v.versions);
      const offers = readOffers(v.offers);
      const devices = readDevices(v.devices);
      const leases = readStrings(v.leases);
      if (typeof v.protocol !== 'number' || typeof v.hostName !== 'string' || typeof v.memoryBytes !== 'number') {
        return bad('`protocol`, `hostName` and `memoryBytes` must be a number, a string and a number');
      }
      if (!versions || !offers || !devices || !leases) {
        return bad('`versions`, `offers`, `devices` and `leases` are missing or have the wrong shape');
      }
      return { ok: true, value: { type: 'hello', protocol: v.protocol, hostName: v.hostName, versions, memoryBytes: v.memoryBytes, offers, devices, leases } };
    }
    case 'inventory': {
      const devices = readDevices(v.devices);
      return devices ? { ok: true, value: { type: 'inventory', devices } } : bad('`devices` is missing or has the wrong shape');
    }
    case 'stream.frame':
      if (typeof v.leaseId !== 'string' || (v.codec !== 'h264' && v.codec !== 'jpeg') || !(v.data instanceof Uint8Array)) {
        return bad('it needs a string `leaseId`, a `codec` of h264 or jpeg and binary `data`');
      }
      return { ok: true, value: { type: 'stream.frame', leaseId: v.leaseId, codec: v.codec, data: v.data } };
    case 'stream.failed':
      if (typeof v.leaseId !== 'string' || (v.codec !== 'h264' && v.codec !== 'jpeg') || typeof v.message !== 'string') {
        return bad('it needs a string `leaseId`, a `codec` of h264 or jpeg and a string `message`');
      }
      return { ok: true, value: { type: 'stream.failed', leaseId: v.leaseId, codec: v.codec, message: v.message } };
    case 'tunnel.open':
      if (typeof v.leaseId !== 'string' || typeof v.conn !== 'number' || (v.port !== undefined && typeof v.port !== 'number')) {
        return bad('it needs a string `leaseId`, a numeric `conn` and an optional numeric `port`');
      }
      return { ok: true, value: { type: 'tunnel.open', leaseId: v.leaseId, conn: v.conn, ...(typeof v.port === 'number' ? { port: v.port } : {}) } };
    case 'tunnel.data':
      if (typeof v.leaseId !== 'string' || typeof v.conn !== 'number' || !(v.data instanceof Uint8Array)) {
        return bad('it needs a string `leaseId`, a numeric `conn` and binary `data`');
      }
      return { ok: true, value: { type: 'tunnel.data', leaseId: v.leaseId, conn: v.conn, data: v.data } };
    case 'tunnel.close':
      if (typeof v.leaseId !== 'string' || typeof v.conn !== 'number') {
        return bad('it needs a string `leaseId` and a numeric `conn`');
      }
      return { ok: true, value: { type: 'tunnel.close', leaseId: v.leaseId, conn: v.conn } };
    case 'response': {
      if (typeof v.id !== 'number') {
        return bad('`id` must be a number');
      }
      if (v.ok === true) {
        if (v.binary !== undefined && typeof v.binary !== 'string') {
          return bad('`binary` must be a string');
        }
        return { ok: true, value: { type: 'response', id: v.id, ok: true, ...('result' in v ? { result: v.result } : {}), ...(typeof v.binary === 'string' ? { binary: v.binary } : {}) } };
      }
      if (v.ok === false && isRecord(v.error) && typeof v.error.code === 'string' && typeof v.error.message === 'string') {
        return { ok: true, value: { type: 'response', id: v.id, ok: false, error: { code: v.error.code, message: v.error.message } } };
      }
      return bad('`ok` must be true, or false with an `error` that has a `code` and a `message`');
    }
    case 'images.status':
      if (typeof v.image !== 'string' || typeof v.id !== 'string' || (v.state !== 'building' && v.state !== 'ready' && v.state !== 'failed') || (v.message !== undefined && typeof v.message !== 'string')) {
        return bad('it needs string `image` and `id`, a `state` of building, ready or failed, and an optional string `message`');
      }
      return { ok: true, value: { type: 'images.status', image: v.image, id: v.id, state: v.state, ...(v.message !== undefined ? { message: v.message } : {}) } };
    default:
      return bad('the type is not one a broker knows');
  }
}

type Pending = { resolve: (m: AgentMessage & { type: 'response' }) => void; timer: NodeJS.Timeout };

export class Hosts {
  readonly hosts = new Map<string, Host>();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  onChange: () => void = () => {};
  onHello: (held: string[], link: HostLink) => void = () => {};
  onFrame: (leaseId: string, codec: StreamCodec, data: Uint8Array) => void = () => {};
  onStreamFailed: (leaseId: string, codec: StreamCodec, message: string) => void = () => {};
  onTunnel: (m: AgentMessage & { type: 'tunnel.open' | 'tunnel.data' | 'tunnel.close' }) => void = () => {};

  attach(link: HostLink): { message(raw: unknown): void; rejected(reason: string): void; closed(): void } {
    let host: Host | null = null;
    const who = (): string => (host ? `host ${host.name}` : 'an agent that has not said hello');
    const drop = (what: string, reason: string): void => {
      console.error(`Dropped ${what} from ${who()}: ${reason}.`);
    };
    const handle = (m: AgentMessage): void => {
      if (m.type === 'hello') {
        const existing = [...this.hosts.values()].find((h) => h.name === m.hostName);
        host = {
          id: existing?.id ?? randomUUID(),
          name: m.hostName,
          versions: m.versions,
          memoryBytes: m.memoryBytes,
          offers: m.offers,
          devices: m.devices,
          connected: true,
          lostAt: null,
          link,
          images: existing?.images ?? new Map(),
        };
        this.hosts.set(host.id, host);
        link.send({ type: 'welcome', hostId: host.id });
        this.onHello(m.leases, link);
        this.onChange();
      } else if (m.type === 'inventory' && host) {
        host.devices = m.devices;
        this.onChange();
      } else if (m.type === 'stream.frame') {
        this.onFrame(m.leaseId, m.codec, m.data);
      } else if (m.type === 'tunnel.open' || m.type === 'tunnel.data' || m.type === 'tunnel.close') {
        this.onTunnel(m);
      } else if (m.type === 'stream.failed') {
        this.onStreamFailed(m.leaseId, m.codec, m.message);
      } else if (m.type === 'images.status' && host) {
        host.images.set(m.id, m.message ? { state: m.state, message: m.message.slice(0, 4000) } : { state: m.state });
      } else if (m.type === 'response') {
        const p = this.pending.get(m.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(m.id);
          p.resolve(m);
        }
      }
    };
    return {
      message: (raw) => {
        const type = isRecord(raw) && typeof raw.type === 'string' ? raw.type : 'message';
        if (isRecord(raw) && raw.type === 'hello' && typeof raw.protocol === 'number' && raw.protocol !== PROTOCOL_VERSION) {
          link.send({ type: 'incompatible', message: `Broker speaks protocol ${PROTOCOL_VERSION}, agent speaks ${raw.protocol}. Update the older one.` });
          link.close();
          return;
        }
        const read = readAgentMessage(raw);
        if (!read.ok) {
          drop(type, read.reason);
          if (type === 'hello') {
            link.close();
          }
          return;
        }
        try {
          handle(read.value);
        } catch (err) {
          drop(type, `handling it failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      rejected: (reason) => drop('a message', reason),
      closed: () => {
        if (host) {
          host.connected = false;
          host.lostAt = Date.now();
          try {
            this.onChange();
          } catch (err) {
            drop('close', `reacting to it failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      },
    };
  }

  hostOf(deviceId: string): Host | null {
    for (const h of this.hosts.values()) {
      if (h.devices.some((d) => d.deviceId === deviceId)) {
        return h;
      }
    }
    return null;
  }

  offers(): Host['offers'] {
    return [...this.hosts.values()].filter((h) => h.connected).flatMap((h) => h.offers);
  }

  connectedCount(): number {
    return [...this.hosts.values()].filter((h) => h.connected).length;
  }

  devices(): (AgentDevice & { hostId: string; hostName: string; connected: boolean })[] {
    return [...this.hosts.values()].flatMap((h) =>
      h.devices.map((d) => ({ ...d, hostId: h.id, hostName: h.name, connected: h.connected })),
    );
  }

  broadcast(message: () => BrokerMessage): void {
    for (const h of this.hosts.values()) {
      if (h.connected) {
        h.link.send(message());
      }
    }
  }

  notify(deviceId: string, message: BrokerMessage): void {
    const host = this.hostOf(deviceId);
    if (host?.connected) {
      host.link.send(message);
    }
  }

  request(
    deviceId: string,
    build: (id: number) => BrokerMessage,
    timeoutMs = 60_000,
  ): Promise<AgentMessage & { type: 'response' }> {
    const host = this.hostOf(deviceId);
    if (!host?.connected) {
      return Promise.reject(new HostError('HOST_DISCONNECTED', 'The Mac that holds this device is not connected right now.'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostError('HOST_TIMEOUT', `The Mac did not answer within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      host.link.send(build(id));
    });
  }
}
