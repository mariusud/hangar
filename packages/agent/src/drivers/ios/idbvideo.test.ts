import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerHttp2Stream } from 'node:http2';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { idbVideoStream } from './idbvideo.ts';

function varint(n: number): Buffer {
  const out: number[] = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

// idb.VideoStreamResponse { payload = 2 { data = 2 } } in a gRPC frame.
function videoMessage(data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from([(2 << 3) | 2]), varint(data.length), data]);
  const body = Buffer.concat([Buffer.from([(2 << 3) | 2]), varint(payload.length), payload]);
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A fake idb_companion that answers each video_stream with the captured sample, in pieces.
async function fakeCompanion(delayMs: number): Promise<{ socket: string; streams: () => number; close: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'hv-'));
  const socket = join(dir, 'c.sock');
  const sample = await readFile(new URL('./testdata/idb-300x654.h264', import.meta.url));
  let count = 0;
  const open: ServerHttp2Stream[] = [];
  const server = createServer();
  server.on('stream', (stream) => {
    count += 1;
    open.push(stream);
    stream.on('error', () => {});
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
    stream.on('data', () => {});
    stream.on('end', () => stream.end());
    setTimeout(() => {
      for (let at = 0; at < sample.length && !stream.closed; at += 4096) {
        stream.write(videoMessage(sample.subarray(at, at + 4096)));
      }
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return {
    socket,
    streams: () => count,
    close: async () => {
      for (const s of open) {
        s.close();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('keyframe requests before the first frame do not open more idb streams', async () => {
  const fake = await fakeCompanion(50);
  try {
    let frames = 0;
    const s = await idbVideoStream(fake.socket, () => {
      frames += 1;
    });
    s.keyframe();
    s.keyframe();
    await sleep(20);
    assert.equal(fake.streams(), 1);
    await sleep(150);
    assert.ok(frames > 20, `only ${frames} frames arrived`);
    s.keyframe();
    await sleep(20);
    assert.equal(fake.streams(), 2, 'a keyframe after the first frame opens a new stream');
    await s.stop();
  } finally {
    await fake.close();
  }
});

test('a recording on the idb stream is an MP4 of the frames', async () => {
  const fake = await fakeCompanion(50);
  const dir = await mkdtemp(join(tmpdir(), 'hangar-idb-rec-'));
  try {
    const s = await idbVideoStream(fake.socket, () => {});
    const file = join(dir, 'video.mp4');
    s.record(file);
    await sleep(200);
    await s.stopRecording();
    const data = await readFile(file);
    assert.equal(data.toString('latin1', 4, 8), 'ftyp');
    assert.ok(data.includes(Buffer.from('moov')), 'the file has a moov box');
    assert.ok(data.includes(Buffer.from('avcC')), 'the file has the parameter sets');
    await s.stop();
  } finally {
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  }
});
