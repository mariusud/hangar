// Connected agents, their devices, and request/response over each agent's link.

import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, type AgentDevice, type AgentMessage, type BrokerMessage, type Platform, type StreamCodec } from '@hangar/protocol';

// One link per agent: a WebSocket, or an in-memory pair when broker and agent share a process.
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
};

export class HostError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type Pending = { resolve: (m: AgentMessage & { type: 'response' }) => void; timer: NodeJS.Timeout };

export class Hosts {
  readonly hosts = new Map<string, Host>();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  onChange: () => void = () => {};
  // The leases an agent says it holds, on every (re)connect.
  onHello: (held: string[], link: HostLink) => void = () => {};
  onFrame: (leaseId: string, codec: StreamCodec, data: Uint8Array) => void = () => {};
  onStreamFailed: (leaseId: string, codec: StreamCodec, message: string) => void = () => {};
  onTunnel: (m: AgentMessage & { type: 'tunnel.open' | 'tunnel.data' | 'tunnel.close' }) => void = () => {};

  // Returns the handlers the transport calls for this link.
  attach(link: HostLink): { message(m: AgentMessage): void; closed(): void } {
    let host: Host | null = null;
    return {
      message: (m) => {
        if (m.type === 'hello') {
          if (m.protocol !== PROTOCOL_VERSION) {
            link.send({ type: 'incompatible', message: `Broker speaks protocol ${PROTOCOL_VERSION}, agent speaks ${m.protocol}. Update the older one.` });
            link.close();
            return;
          }
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
        } else if (m.type === 'response') {
          const p = this.pending.get(m.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(m.id);
            p.resolve(m);
          }
        }
      },
      closed: () => {
        if (host) {
          host.connected = false;
          host.lostAt = Date.now();
          this.onChange();
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

  // Sends a message that carries an `id` and waits for the agent's response.
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
