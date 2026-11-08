// Live screen over WebSocket: the agent sends frames once per device, the broker fans them out
// to every viewer of that lease. The lease holder's input comes back over the same socket.

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Action, StreamCodec, ViewerInput } from '@hangar/protocol';
import * as auth from './auth.ts';
import type { Db } from './db.ts';
import type { Hosts } from './hosts.ts';
import type { Leases } from './leases/service.ts';
import type { Metrics } from './metrics.ts';

// To the browser, each binary message starts with one byte: 1 is a JPEG image, 2 is an H.264
// frame record from the agent (flags, capture time, size, Annex B).
const TYPE = { jpeg: 1, h264: 2 } as const;
// Above this many unsent bytes a viewer skips frames; for H.264 it then waits for a keyframe.
const BACKLOG = 1024 * 1024;

type Viewer = { ws: WebSocket; codec: StreamCodec; needsKey: boolean };

export type Upgrades = {
  // Handles the upgrade and returns true if the path is this module's.
  upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  // Closes every socket, which server.close() does not track once upgraded.
  close: () => void;
};

export function attachStreams(db: Db, hosts: Hosts, leases: Leases, metrics: Metrics): Upgrades {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const viewers = new Map<string, Set<Viewer>>();
  const devices = new Map<string, string>();
  const lastKeyRequest = new Map<string, number>();

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
        // Never queue video: skip, and for H.264 restart from the next keyframe.
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

  // The native helper could not run on that Mac: move its viewers to JPEG.
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

  leases.events.on('any', (lease: { id: string; state: string }) => {
    if (lease.state === 'ended') {
      for (const v of viewers.get(lease.id) ?? []) {
        v.ws.close(4000, 'lease ended');
      }
      viewers.delete(lease.id);
      devices.delete(lease.id);
      lastKeyRequest.delete(lease.id);
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
    const p = auth.authenticate(db, { authorization: token ? `Bearer ${token}` : undefined, cookie: req.headers.cookie }, Date.now());
    let deviceId: string | null = null;
    try {
      deviceId = p ? leases.deviceOf(p, leaseId) : null;
    } catch {
      deviceId = null;
    }
    if (!p || !deviceId) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return true;
    }
    const principal = p;
    const device = deviceId;
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.binaryType = 'nodebuffer';
      const set = viewers.get(leaseId) ?? new Set<Viewer>();
      viewers.set(leaseId, set);
      devices.set(leaseId, device);
      const viewer: Viewer = { ws, codec, needsKey: true };
      set.add(viewer);
      if (count(leaseId, codec) === 1) {
        hosts.notify(device, { type: 'stream.start', leaseId, codec });
      } else if (codec === 'h264') {
        askKeyframe(leaseId);
      }

      ws.on('message', (data, isBinary) => {
        if (isBinary) {
          return;
        }
        let input: ViewerInput;
        try {
          input = JSON.parse(data.toString()) as ViewerInput;
        } catch {
          return;
        }
        if (input.type === 'keyframe') {
          viewer.needsKey = true;
          askKeyframe(leaseId);
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
        set.delete(viewer);
        if (count(leaseId, viewer.codec) === 0 && viewers.has(leaseId)) {
          hosts.notify(device, { type: 'stream.stop', leaseId, codec: viewer.codec });
        }
        if (set.size === 0) {
          viewers.delete(leaseId);
        }
      });
    });
    return true;
  };

  return {
    upgrade,
    close: () => {
      for (const ws of wss.clients) {
        ws.terminate();
      }
    },
  };
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
