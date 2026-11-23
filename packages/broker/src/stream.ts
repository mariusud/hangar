
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { isAndroid, toPoint, type Action, type KeyModifier, type Point, type StreamCodec, type TouchPhase, type ViewerInput } from '@devicepool/protocol';
import * as auth from './auth.ts';
import type { Db } from './db.ts';
import type { Hosts } from './hosts.ts';
import type { Leases } from './leases/service.ts';
import type { Metrics } from './metrics.ts';
import { ApiError } from './leases/service.ts';

const TYPE = { jpeg: 1, h264: 2 } as const;
const BACKLOG = 1024 * 1024;
/** Live touches mark the lease as in use at most this often, so a drag is not a database write per move. */
const ACTIVITY_MS = 1000;
/** A viewer that misses a pong for this long is closed, so a dead connection does not hold an encoder. */
const HEARTBEAT_MS = 15_000;

type Viewer = { ws: WebSocket; codec: StreamCodec; needsKey: boolean };

export type Upgrades = {
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  close: () => void;
};

export function attachStreams(db: Db, hosts: Hosts, leases: Leases, metrics: Metrics, publicUrl: () => string = () => ''): Upgrades {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const viewers = new Map<string, Set<Viewer>>();
  const devices = new Map<string, string>();
  const lastKeyRequest = new Map<string, number>();
  const answered = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!answered.has(ws)) {
        ws.terminate();
        continue;
      }
      answered.delete(ws);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const count = (leaseId: string, codec: StreamCodec): number => [...(viewers.get(leaseId) ?? [])].filter((v) => v.codec === codec).length;

  const askKeyframe = (leaseId: string): void => {
    const device = devices.get(leaseId);
    const now = Date.now();
    if (device && now - (lastKeyRequest.get(leaseId) ?? 0) > 250) {
      lastKeyRequest.set(leaseId, now);
      hosts.notify(device, { type: 'stream.keyframe', leaseId });
    }
  };

  hosts.onFrame = (leaseId, codec, data) => {
    const set = viewers.get(leaseId);
    if (!set) {
      return;
    }
    const message = Buffer.allocUnsafe(data.length + 1);
    message[0] = TYPE[codec];
    message.set(data, 1);
    const keyframe = codec === 'h264' && (data[0]! & 1) === 1;
    for (const v of set) {
      if (v.codec !== codec) {
        continue;
      }
      if (v.ws.bufferedAmount > BACKLOG) {
        metrics.framesDropped.inc({ codec });
        if (codec === 'h264' && !v.needsKey) {
          v.needsKey = true;
          askKeyframe(leaseId);
        }
        continue;
      }
      if (codec === 'h264' && v.needsKey) {
        if (!keyframe) {
          continue;
        }
        v.needsKey = false;
      }
      v.ws.send(message, { binary: true });
      metrics.framesSent.inc({ codec });
    }
  };

  hosts.onStreamFailed = (leaseId, codec, message) => {
    const device = devices.get(leaseId);
    if (codec !== 'h264' || !device) {
      return;
    }
    const moved = [...(viewers.get(leaseId) ?? [])].filter((v) => v.codec === 'h264');
    for (const v of moved) {
      v.codec = 'jpeg';
      v.ws.send(JSON.stringify({ type: 'fallback', codec: 'jpeg', message }));
    }
    if (moved.length && count(leaseId, 'jpeg') === moved.length) {
      hosts.notify(device, { type: 'stream.start', leaseId, codec: 'jpeg' });
    }
  };

  leases.events.on('any', (lease: { id: string; state: string; hostLeaseId?: string }) => {
    if (lease.state === 'ended') {
      const hostId = lease.hostLeaseId ?? lease.id;
      for (const v of viewers.get(hostId) ?? []) {
        v.ws.close(4000, 'lease ended');
      }
      viewers.delete(hostId);
      devices.delete(hostId);
      lastKeyRequest.delete(hostId);
    }
  });

  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const url = new URL(req.url ?? '/', 'http://x');
    const match = /^\/v1\/leases\/([^/]+)\/stream$/.exec(url.pathname);
    if (!match?.[1]) {
      return false;
    }
    const leaseId = decodeURIComponent(match[1]);
    const token = url.searchParams.get('token');
    const codec: StreamCodec = url.searchParams.get('codec') === 'h264' ? 'h264' : 'jpeg';
    if (!token) {
      try {
        auth.assertSameOrigin(req, publicUrl(), true);
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Cross-site request refused.';
        socket.write(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${message}`);
        socket.destroy();
        return true;
      }
    }
    const p = auth.authenticate(db, { authorization: token ? `Bearer ${token}` : req.headers.authorization, cookie: req.headers.cookie }, Date.now());
    let deviceId: string | null = null;
    try {
      deviceId = p ? leases.deviceOf(p, leaseId) : null;
    } catch {
      deviceId = null;
    }
    if (!p || !deviceId || !auth.leaseTokenAllows(p, url.pathname)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return true;
    }
    const principal = p;
    const hostId = leases.hostLeaseId(leases.get(p, leaseId));
    const device = deviceId;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.binaryType = 'nodebuffer';
      answered.add(ws);
      ws.on('pong', () => answered.add(ws));
      const set = viewers.get(hostId) ?? new Set<Viewer>();
      viewers.set(hostId, set);
      devices.set(hostId, device);
      const viewer: Viewer = { ws, codec, needsKey: true };
      set.add(viewer);
      const isIos = !isAndroid(hosts.devices().find((d) => d.deviceId === device)?.platform);
      if (isIos) {
        ws.send(JSON.stringify({ type: 'hello', input: ['touch'] }));
      }
      let lastTouch: Point | null = null;
      let activeAt = 0;
      const touch = (phase: TouchPhase, point: Point): void => {
        lastTouch = phase === 'up' ? null : point;
        hosts.notify(device, { type: 'stream.touch', leaseId: hostId, phase, point });
        const now = Date.now();
        if (now - activeAt >= ACTIVITY_MS) {
          activeAt = now;
          leases.markActive(principal, leaseId);
        }
      };
      if (count(hostId, codec) === 1) {
        hosts.notify(device, { type: 'stream.start', leaseId: hostId, codec });
      } else if (codec === 'h264') {
        askKeyframe(hostId);
      }

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          return;
        }
        const input = parseViewerInput(data.toString());
        if (!input) {
          return;
        }
        if (input.type === 'keyframe') {
          viewer.needsKey = true;
          askKeyframe(hostId);
          return;
        }
        if (input.type === 'touch') {
          if (isIos) {
            touch(input.phase, toPoint(input.point));
          }
          return;
        }
        const action = toAction(input);
        if (!action) {
          return;
        }
        leases.op(principal, leaseId, { op: 'actions', actions: [action] }).catch((err: Error) => {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        });
      });

      ws.on('close', () => {
        if (lastTouch) {
          touch('up', lastTouch);
        }
        set.delete(viewer);
        if (count(hostId, viewer.codec) === 0 && viewers.has(hostId)) {
          hosts.notify(device, { type: 'stream.stop', leaseId: hostId, codec: viewer.codec });
        }
        if (set.size === 0) {
          viewers.delete(hostId);
        }
      });
    });
    return true;
  };

  return {
    upgrade,
    close: () => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) {
        ws.terminate();
      }
    },
  };
}

const isPoint = (v: unknown): v is Point => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
const isString = (v: unknown): v is string => typeof v === 'string';
const isPhase = (v: unknown): v is TouchPhase => v === 'down' || v === 'move' || v === 'up';
const isModifier = (v: unknown): v is KeyModifier => v === 'command' || v === 'shift' || v === 'option' || v === 'control';
const isButton = (v: unknown): v is 'home' | 'lock' | 'siri' => v === 'home' || v === 'lock' || v === 'siri';

export function parseViewerInput(text: string): ViewerInput | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const i: Record<string, unknown> = Object.fromEntries(Object.entries(raw));
  switch (i.type) {
    case 'keyframe':
      return { type: 'keyframe' };
    case 'tap':
      return isPoint(i.point) ? { type: 'tap', point: i.point } : null;
    case 'touch':
      return isPoint(i.point) && isPhase(i.phase) ? { type: 'touch', phase: i.phase, point: i.point } : null;
    case 'swipe':
      if (!isPoint(i.from) || !isPoint(i.to) || (i.durationMs !== undefined && typeof i.durationMs !== 'number')) {
        return null;
      }
      return { type: 'swipe', from: i.from, to: i.to, ...(typeof i.durationMs === 'number' ? { durationMs: i.durationMs } : {}) };
    case 'type':
      return isString(i.text) ? { type: 'type', text: i.text } : null;
    case 'key':
      if (!isString(i.key)) {
        return null;
      }
      if (i.modifiers === undefined) {
        return { type: 'key', key: i.key };
      }
      return Array.isArray(i.modifiers) && i.modifiers.every(isModifier) ? { type: 'key', key: i.key, modifiers: i.modifiers } : null;
    case 'button':
      return isButton(i.button) ? { type: 'button', button: i.button } : null;
    default:
      return null;
  }
}

function toAction(i: ViewerInput): Action | null {
  switch (i.type) {
    case 'tap':
      return { type: 'tap', point: i.point };
    case 'swipe':
      return { type: 'swipe', from: i.from, to: i.to, ...(i.durationMs ? { durationMs: i.durationMs } : {}) };
    case 'type':
      return { type: 'type', text: i.text };
    case 'key':
      return { type: 'key', key: i.key, ...(i.modifiers ? { modifiers: i.modifiers } : {}) };
    case 'button':
      return { type: 'button', button: i.button };
    default:
      return null;
  }
}
