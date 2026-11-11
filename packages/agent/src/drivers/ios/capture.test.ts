import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureOf } from '@hangar/protocol';
import {
  captureStream,
  capturePath,
  failureCode,
  forgetCapture,
  freshHealth,
  isStalled,
  MAX_FAILURES,
  nextPath,
  parseForced,
  recordFailure,
  recordSuccess,
  resetCaptureHealth,
  SKIP_MS,
  type CaptureDeps,
  type Starter,
} from './capture.ts';
import { DriverError, type ScreenStream } from './index.ts';
import { GrpcMessages, startRequest, STOP_REQUEST, videoBytes } from './idbvideo.ts';
import { bytesField } from './hid.ts';

test('nextPath walks iosurface, idb, jpeg and skips paths that keep failing', () => {
  let h = freshHealth();
  assert.equal(nextPath(h, 0, null), 'iosurface');
  assert.equal(nextPath(h, 0, 'iosurface'), 'idb');
  assert.equal(nextPath(h, 0, 'idb'), 'jpeg');
  h = recordFailure(h, 'iosurface', 'STALLED', 0);
  assert.equal(nextPath(h, 0, null), 'iosurface', 'one stall is not enough to skip');
  h = recordFailure(h, 'iosurface', 'STALLED', 0);
  assert.equal(h.iosurface.failures, MAX_FAILURES);
  assert.equal(nextPath(h, 1, null), 'idb');
  assert.equal(nextPath(h, SKIP_MS, null), 'iosurface', 'tried again after a while');
  h = recordSuccess(h, 'iosurface');
  assert.deepEqual(h.iosurface, { failures: 0, skipUntil: 0 });
});

test('a changed SimulatorKit skips the helper after one failure', () => {
  const h = recordFailure(freshHealth(), 'iosurface', 'SIMULATORKIT_CHANGED', 100);
  assert.equal(nextPath(h, 200, null), 'idb');
  const both = recordFailure(recordFailure(h, 'idb', 'X', 100), 'idb', 'X', 100);
  assert.equal(nextPath(both, 200, null), 'jpeg');
});

test('a forced path is the only one tried', () => {
  const h = freshHealth();
  assert.equal(nextPath(h, 0, null, 'idb'), 'idb');
  assert.equal(nextPath(h, 0, 'idb', 'idb'), 'jpeg');
  assert.equal(nextPath(h, 0, null, 'jpeg'), 'jpeg');
  assert.equal(parseForced('idb'), 'idb');
  assert.equal(parseForced('nope'), null);
  assert.equal(parseForced(undefined), null);
});

test('helpers', () => {
  assert.equal(failureCode('SIMULATORKIT_CHANGED: SimulatorKit in this Xcode has no foo.'), 'SIMULATORKIT_CHANGED');
  assert.equal(failureCode('exit 6'), '');
  assert.equal(isStalled(null, 10_000), false);
  assert.equal(isStalled(0, 2999, 3000), false);
  assert.equal(isStalled(0, 3000, 3000), true);
  assert.equal(captureOf({ capture: 'idb' }), 'idb');
  assert.equal(captureOf({ capture: 'other' }), null);
  assert.equal(captureOf({}), null);
});

type Fake = { stream: ScreenStream; emit: () => void; exit: (err: string | null) => void; keyframes: number; stopped: boolean };

// A stream that answers keyframe requests with a frame when `answers` is true.
function fake(answers: boolean, onFrame: (r: Buffer) => void): Fake {
  let exit: (err: string | null) => void = () => {};
  const exited = new Promise<string | null>((resolve) => {
    exit = resolve;
  });
  const f: Fake = {
    keyframes: 0,
    stopped: false,
    emit: () => onFrame(Buffer.from([1])),
    exit: (err) => exit(err),
    stream: {
      keyframe: () => {
        f.keyframes += 1;
        if (answers) {
          f.emit();
        }
      },
      record: () => {},
      stopRecording: () => Promise.resolve(),
      stop: async () => {
        f.stopped = true;
        exit(null);
      },
      exited,
    },
  };
  return f;
}

function deps(behaviour: Record<'iosurface' | 'idb', 'ok' | 'silent' | 'throws'>, made: Fake[], forced: CaptureDeps['forced'] = null): CaptureDeps {
  const starter =
    (b: 'ok' | 'silent' | 'throws', code: string): Starter =>
    async (_udid, onFrame) => {
      if (b === 'throws') {
        throw new DriverError(code, `${code} failed`);
      }
      const f = fake(b === 'ok', onFrame);
      made.push(f);
      return f.stream;
    };
  return { starters: { iosurface: starter(behaviour.iosurface, 'SIMULATORKIT_CHANGED'), idb: starter(behaviour.idb, 'IDB_FAILED') }, now: Date.now, forced, stallMs: 30, firstFrameMs: 30 };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('captureStream uses the IOSurface helper when it works', async () => {
  resetCaptureHealth();
  const made: Fake[] = [];
  const frames: Buffer[] = [];
  const seen: string[] = [];
  const s = await captureStream('dev-a', (r) => frames.push(r), { onPath: (p) => seen.push(p) }, deps({ iosurface: 'ok', idb: 'ok' }, made));
  await sleep(60);
  assert.equal(made.length, 1);
  assert.equal(frames.length, 1);
  assert.equal(capturePath('dev-a'), 'iosurface');
  assert.deepEqual(seen, ['iosurface']);
  await s.stop();
  assert.equal(await s.exited, null);
  forgetCapture('dev-a');
  assert.equal(capturePath('dev-a'), null);
});

test('captureStream moves to idb when the helper cannot start', async () => {
  resetCaptureHealth();
  const made: Fake[] = [];
  const frames: Buffer[] = [];
  const s = await captureStream('dev-b', (r) => frames.push(r), {}, deps({ iosurface: 'throws', idb: 'ok' }, made));
  assert.equal(capturePath('dev-b'), 'idb');
  assert.equal(frames.length, 1);
  await s.stop();
});

test('captureStream moves to idb when the helper sends no frame after a keyframe request', async () => {
  resetCaptureHealth();
  const made: Fake[] = [];
  const frames: Buffer[] = [];
  const s = await captureStream('dev-c', (r) => frames.push(r), {}, deps({ iosurface: 'silent', idb: 'ok' }, made));
  assert.equal(capturePath('dev-c'), 'iosurface');
  await sleep(80);
  assert.equal(made.length, 2);
  assert.equal(made[0]?.stopped, true, 'the stalled helper is stopped');
  assert.equal(capturePath('dev-c'), 'idb');
  assert.equal(frames.length, 1);
  s.keyframe();
  assert.equal(frames.length, 2);
  await s.stop();
});

test('captureStream moves on when a working path exits, and frames from the old path are dropped', async () => {
  resetCaptureHealth();
  const made: Fake[] = [];
  const frames: Buffer[] = [];
  const s = await captureStream('dev-d', (r) => frames.push(r), {}, deps({ iosurface: 'ok', idb: 'ok' }, made));
  made[0]?.exit('SIMULATORKIT_CHANGED: gone');
  await sleep(10);
  assert.equal(capturePath('dev-d'), 'idb');
  const before = frames.length;
  made[0]?.emit();
  assert.equal(frames.length, before);
  await s.stop();
  resetCaptureHealth();
});

test('captureStream ends with the reasons when no H.264 path works, so viewers move to JPEG', async () => {
  resetCaptureHealth();
  const made: Fake[] = [];
  await assert.rejects(captureStream('dev-e', () => {}, {}, deps({ iosurface: 'throws', idb: 'throws' }, made)), /SIMULATORKIT_CHANGED failed; idb: IDB_FAILED failed/);
  assert.equal(capturePath('dev-e'), 'jpeg');

  resetCaptureHealth();
  const s = await captureStream('dev-f', () => {}, {}, deps({ iosurface: 'silent', idb: 'silent' }, made));
  const err = await s.exited;
  assert.match(err ?? '', /iosurface: no frame within 30 ms.*idb: no frame/);
  assert.equal(capturePath('dev-f'), 'jpeg');
  resetCaptureHealth();
});

test('a forced path does not fall back', async () => {
  resetCaptureHealth();
  const made: Fake[] = [];
  const s = await captureStream('dev-g', () => {}, {}, deps({ iosurface: 'ok', idb: 'ok' }, made, 'idb'));
  assert.equal(capturePath('dev-g'), 'idb');
  await s.stop();
  await assert.rejects(captureStream('dev-h', () => {}, {}, deps({ iosurface: 'ok', idb: 'ok' }, made, 'jpeg')), /CAPTURE_FAILED|No H.264/);
});

test('idb video_stream messages', () => {
  const start = startRequest(30);
  assert.equal(start.readUInt32BE(1), start.length - 5);
  const body = start.subarray(5);
  const inner = bytesField(body, 1);
  assert.equal(inner[0], 2 << 3);
  assert.equal(inner[1], 30);
  assert.deepEqual([...STOP_REQUEST], [0, 0, 0, 0, 2, (2 << 3) | 2, 0]);

  const data = Buffer.from([0, 0, 0, 1, 0x65]);
  const payload = Buffer.from([(2 << 3) | 2, data.length, ...data]);
  const response = Buffer.from([(2 << 3) | 2, payload.length, ...payload]);
  const log = Buffer.from([(1 << 3) | 2, 2, 0x68, 0x69]);
  const out: Buffer[] = [];
  const m = new GrpcMessages((msg) => out.push(videoBytes(msg)));
  const framed = Buffer.concat(
    [log, response].map((b) => {
      const head = Buffer.alloc(5);
      head.writeUInt32BE(b.length, 1);
      return Buffer.concat([head, b]);
    }),
  );
  for (const byte of framed) {
    m.push(Buffer.from([byte]));
  }
  assert.equal(out.length, 2);
  assert.equal(out[0]?.length, 0);
  assert.deepEqual(out[1], data);
});

test('a slow first frame is allowed more time than a later keyframe', async () => {
  resetCaptureHealth();
  const frames: Buffer[] = [];
  let send: () => void = () => {};
  const slow: Starter = async (_udid, onFrame) => {
    const f = fake(false, onFrame);
    send = f.emit;
    setTimeout(() => f.emit(), 50);
    return f.stream;
  };
  const idb: Starter = async () => {
    throw new DriverError('IDB_FAILED', 'no idb');
  };
  const s = await captureStream('dev-i', (r) => frames.push(r), {}, { starters: { iosurface: slow, idb }, now: Date.now, forced: null, stallMs: 20, firstFrameMs: 200 });
  await sleep(80);
  assert.equal(frames.length, 1);
  assert.equal(capturePath('dev-i'), 'iosurface');
  s.keyframe();
  const err = await s.exited;
  assert.match(err ?? '', /no frame within 20 ms/);
  assert.equal(capturePath('dev-i'), 'jpeg');
  send();
  assert.equal(frames.length, 1, 'frames after the switch are dropped');
  resetCaptureHealth();
});
