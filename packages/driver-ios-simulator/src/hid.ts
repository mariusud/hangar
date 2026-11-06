// Touch, key and button input straight to the idb companion over gRPC, on one HTTP/2 session
// per device. Spawning the idb CLI costs 100 to 300 ms per tap; this costs a few milliseconds.
// Only the few HID messages Hangar sends are encoded here, by hand, so there is no dependency.

import { connect, type ClientHttp2Session } from 'node:http2';
import { connect as connectSocket } from 'node:net';

export type HidEvent =
  | { press: { touch: [number, number] } | { button: number } | { key: number }; up: boolean }
  | { swipe: { from: [number, number]; to: [number, number]; durationS: number } }
  | { delayS: number };

export const BUTTONS = { home: 1, lock: 2, siri: 4 } as const;

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

function field(n: number, bytes: number[]): number[] {
  return [...varint((n << 3) | 2), ...varint(bytes.length), ...bytes];
}

function double(n: number, v: number): number[] {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(v);
  return [...varint((n << 3) | 1), ...b];
}

// proto3 leaves out fields that hold their default.
function int(n: number, v: number): number[] {
  return v === 0 ? [] : [...varint(n << 3), ...varint(v)];
}

const point = (p: [number, number]): number[] => [...double(1, p[0]), ...double(2, p[1])];

// idb.HIDEvent: press = 1, swipe = 2, delay = 3.
export function encode(e: HidEvent): Buffer {
  let bytes: number[];
  if ('press' in e) {
    const p = e.press;
    const action = 'touch' in p ? field(1, field(1, point(p.touch))) : 'button' in p ? field(2, int(1, p.button)) : field(3, int(1, p.key));
    bytes = field(1, [...field(1, action), ...int(2, e.up ? 1 : 0)]);
  } else if ('swipe' in e) {
    bytes = field(2, [...field(1, point(e.swipe.from)), ...field(2, point(e.swipe.to)), ...double(6, e.swipe.durationS)]);
  } else {
    bytes = field(3, double(1, e.delayS));
  }
  return Buffer.from(bytes);
}

const sessions = new Map<string, ClientHttp2Session>();

function session(socket: string): ClientHttp2Session {
  const existing = sessions.get(socket);
  if (existing && !existing.closed && !existing.destroyed) {
    return existing;
  }
  const s = connect('http://localhost', { createConnection: () => connectSocket(socket) });
  s.on('error', () => sessions.delete(socket));
  s.on('close', () => sessions.delete(socket));
  s.unref();
  sessions.set(socket, s);
  return s;
}

// Sends the events as one call to CompanionService/hid and resolves when the companion has
// performed them.
export function send(socket: string, events: HidEvent[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = session(socket).request({ ':method': 'POST', ':path': '/idb.CompanionService/hid', 'content-type': 'application/grpc', te: 'trailers' });
    let status: string | undefined;
    let message = '';
    req.on('response', (headers) => {
      status = headers['grpc-status']?.toString() ?? status;
    });
    req.on('trailers', (trailers) => {
      status = trailers['grpc-status']?.toString();
      message = decodeURIComponent(trailers['grpc-message']?.toString() ?? '');
    });
    req.on('data', () => {});
    req.on('error', reject);
    req.on('close', () => (status === '0' ? resolve() : reject(new Error(message || `grpc-status ${status ?? 'missing'}`))));
    for (const e of events) {
      const body = encode(e);
      const frame = Buffer.alloc(5);
      frame.writeUInt32BE(body.length, 1);
      req.write(Buffer.concat([frame, body]));
    }
    req.end();
  });
}

export function close(socket: string): void {
  sessions.get(socket)?.close();
  sessions.delete(socket);
}
