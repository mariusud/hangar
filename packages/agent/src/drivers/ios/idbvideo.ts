import { connect, type ClientHttp2Session, type ClientHttp2Stream } from 'node:http2';
import { connect as connectSocket } from 'node:net';
import { AnnexBFrames } from './annexb.ts';
import { bytesField } from './hid.ts';
import type { ScreenStream } from './index.ts';

// The last NAL unit of a frame is only known to be whole once the next one starts. idb writes a
// frame in one burst, so a short quiet gap after data also ends it.
const FLUSH_MS = 8;

function varint(n: number): number[] {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

function grpcFrame(body: number[]): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, Buffer.from(body)]);
}

/** idb.VideoStreamRequest { start = 1 { fps = 2, format = 3 (H264 = 0), compression_quality = 4, scale_factor = 5 } }. */
export function startRequest(fps: number, scale = 1): Buffer {
  const double = (n: number, v: number): number[] => {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v);
    return [...varint((n << 3) | 1), ...b];
  };
  const start = [...varint(2 << 3), ...varint(fps), ...double(4, 0.2), ...double(5, scale)];
  return grpcFrame([...varint((1 << 3) | 2), ...varint(start.length), ...start]);
}

/** idb.VideoStreamRequest { stop = 2 {} }. */
export const STOP_REQUEST = grpcFrame([...varint((2 << 3) | 2), 0]);

/** Splits gRPC length-prefixed messages out of HTTP/2 data chunks. */
export class GrpcMessages {
  private pending: Buffer = Buffer.alloc(0);
  private onMessage: (m: Buffer) => void;
  constructor(onMessage: (m: Buffer) => void) {
    this.onMessage = onMessage;
  }
  push(chunk: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    while (this.pending.length >= 5) {
      const len = this.pending.readUInt32BE(1);
      if (this.pending.length < 5 + len) {
        break;
      }
      this.onMessage(this.pending.subarray(5, 5 + len));
      this.pending = this.pending.subarray(5 + len);
    }
  }
}

/** The video bytes in an idb.VideoStreamResponse { payload = 2 { data = 2 } }, empty for log lines. */
export function videoBytes(message: Buffer): Buffer {
  return bytesField(bytesField(message, 2), 2);
}

/**
 * idb_companion's H.264 video stream over its gRPC socket, as frame records. idb cannot force a
 * keyframe, so `keyframe()` opens a new stream, which starts with one. Recording is not supported.
 */
export async function idbVideoStream(socket: string, onFrame: (record: Buffer) => void, opts: { fps?: number } = {}): Promise<ScreenStream> {
  const session: ClientHttp2Session = connect('http://localhost', { createConnection: () => connectSocket(socket) });
  session.on('error', () => {});
  let stopping = false;
  let current: ClientHttp2Stream | null = null;
  let finish: (err: string | null) => void = () => {};
  const exited = new Promise<string | null>((resolve) => {
    finish = resolve;
  });
  session.once('close', () => finish(stopping ? null : 'The idb video stream closed.'));

  const open = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const frames = new AnnexBFrames(onFrame);
      let timer: NodeJS.Timeout | null = null;
      const messages = new GrpcMessages((m) => {
        const data = videoBytes(m);
        if (data.length) {
          frames.push(data);
          if (timer) {
            clearTimeout(timer);
          }
          timer = setTimeout(() => frames.flush(), FLUSH_MS);
        }
      });
      const req = session.request({ ':method': 'POST', ':path': '/idb.CompanionService/video_stream', 'content-type': 'application/grpc', te: 'trailers' });
      let status: string | undefined;
      let message = '';
      let started = false;
      req.on('response', (headers) => {
        status = headers['grpc-status']?.toString();
        if (status === undefined || status === '0') {
          started = true;
          resolve();
        }
      });
      req.on('trailers', (trailers) => {
        status = trailers['grpc-status']?.toString();
        message = decodeURIComponent(trailers['grpc-message']?.toString() ?? '');
      });
      req.on('data', (c: Buffer) => {
        if (current === req) {
          messages.push(c);
        }
      });
      req.on('error', () => {});
      req.on('close', () => {
        if (timer) {
          clearTimeout(timer);
        }
        const why = `idb video_stream ended: ${message || `grpc-status ${status ?? 'missing'}`}`;
        if (!started) {
          reject(new Error(why));
        } else if (current === req && !stopping) {
          finish(why);
          session.destroy();
        }
      });
      const previous = current;
      current = req;
      previous?.end(STOP_REQUEST);
      previous?.close();
      req.write(startRequest(Math.max(1, Math.min(opts.fps ?? 30, 60))));
    });

  try {
    await open();
  } catch (err) {
    session.destroy();
    throw err;
  }
  return {
    keyframe: () => {
      if (!stopping) {
        open().catch((err: Error) => {
          finish(err.message);
          session.destroy();
        });
      }
    },
    record: () => {},
    stopRecording: () => Promise.resolve(),
    stop: async () => {
      stopping = true;
      current?.end(STOP_REQUEST);
      const timer = setTimeout(() => session.destroy(), 2000);
      session.close();
      await exited;
      clearTimeout(timer);
    },
    exited,
  };
}
