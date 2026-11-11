import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AnnexBFrames } from './annexb.ts';
import { decodeTimes, HEADER_SIZE, Mp4Recorder, parseRecord, sampleBytes, TIMESCALE } from './mp4.ts';

const run = promisify(execFile);

// 29 frames of idb_companion's video_stream (High profile, 300x654, one IDR then B slices),
// captured from a Settings launch on an iOS 26.5 simulator at scale 0.25.
const SAMPLE = new URL('./testdata/idb-300x654.h264', import.meta.url);

type Box = { type: string; start: number; end: number; body: Buffer };

function boxes(data: Buffer, from = 0, to = data.length): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = data.readUInt32BE(at);
    let head = 8;
    if (size === 1) {
      size = Number(data.readBigUInt64BE(at + 8));
      head = 16;
    }
    if (size < head || at + size > to) {
      break;
    }
    const type = data.toString('latin1', at + 4, at + 8);
    out.push({ type, start: at, end: at + size, body: data.subarray(at + head, at + size) });
    at += size;
  }
  return out;
}

function find(data: Buffer, path: string[]): Box {
  let list = boxes(data);
  let found: Box | undefined;
  for (const [i, type] of path.entries()) {
    found = list.find((b) => b.type === type);
    if (!found) {
      throw new Error(`no ${path.slice(0, i + 1).join('/')} box`);
    }
    if (i === path.length - 1) {
      break;
    }
    // stsd holds its entries after a 4-byte version/flags and a 4-byte count.
    const skip = type === 'stsd' ? 8 : type === 'avc1' ? 78 : 0;
    list = boxes(found.body, skip);
  }
  if (!found) {
    throw new Error('empty path');
  }
  return found;
}

async function record(frames: number, step = 33.4): Promise<{ dir: string; file: string; records: Buffer[] }> {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-mp4-test-'));
  const file = join(dir, 'video.mp4');
  const records: Buffer[] = [];
  let t = 1_700_000_000_000;
  const rec = new Mp4Recorder(file);
  const split = new AnnexBFrames(
    (r) => {
      if (records.length < frames) {
        records.push(r);
        rec.push(r);
      }
    },
    () => (t += step),
  );
  split.push(await readFile(SAMPLE));
  split.flush();
  assert.equal(await rec.finish(), true);
  return { dir, file, records };
}

const STBL = ['moov', 'trak', 'mdia', 'minf', 'stbl'];

test('the idb sample becomes an MP4 whose boxes describe every frame', async () => {
  const { dir, file, records } = await record(1000);
  try {
    const data = await readFile(file);
    assert.equal(records.length, 29);
    assert.deepEqual(boxes(data).map((b) => b.type), ['ftyp', 'mdat', 'moov']);
    const mdat = find(data, ['mdat']);
    assert.equal(mdat.start + 16, HEADER_SIZE);

    const sizes = find(data, [...STBL, 'stsz']).body;
    assert.equal(sizes.readUInt32BE(8), 29);
    const offsets = find(data, [...STBL, 'co64']).body;
    assert.equal(offsets.readUInt32BE(4), 29);
    let total = 0;
    for (let i = 0; i < 29; i++) {
      const size = sizes.readUInt32BE(12 + i * 4);
      const offset = Number(offsets.readBigUInt64BE(8 + i * 8));
      assert.equal(offset, HEADER_SIZE + total);
      const frame = parseRecord(records[i] ?? Buffer.alloc(0));
      assert.deepEqual(data.subarray(offset, offset + size), sampleBytes(frame?.nals ?? []));
      total += size;
    }
    assert.equal(mdat.end, HEADER_SIZE + total, 'the mdat size covers every sample');

    const sync = find(data, [...STBL, 'stss']).body;
    assert.equal(sync.readUInt32BE(4), 1);
    assert.equal(sync.readUInt32BE(8), 1, 'the first sample is the only keyframe');

    const stts = find(data, [...STBL, 'stts']).body;
    let samples = 0;
    let duration = 0;
    for (let i = 0; i < stts.readUInt32BE(4); i++) {
      const count = stts.readUInt32BE(8 + i * 8);
      samples += count;
      duration += count * stts.readUInt32BE(12 + i * 8);
    }
    assert.equal(samples, 29);
    const mdhd = find(data, ['moov', 'trak', 'mdia', 'mdhd']).body;
    assert.equal(mdhd.readUInt32BE(12), TIMESCALE);
    assert.equal(mdhd.readUInt32BE(16), duration);

    const tkhd = find(data, ['moov', 'trak', 'tkhd']).body;
    assert.equal(tkhd.readUInt32BE(76) / 0x10000, 300);
    assert.equal(tkhd.readUInt32BE(80) / 0x10000, 654);

    const avcC = find(data, [...STBL, 'stsd', 'avc1', 'avcC']).body;
    const first = parseRecord(records[0] ?? Buffer.alloc(0));
    const sps = first?.nals.find((n) => ((n[0] ?? 0) & 0x1f) === 7);
    assert.ok(sps);
    assert.equal(avcC[0], 1);
    assert.equal(avcC[1], 100, 'High profile');
    assert.equal(avcC[4], 0xff, '4-byte NAL lengths');
    assert.equal(avcC.readUInt16BE(6), sps.length);
    assert.deepEqual(avcC.subarray(8, 8 + sps.length), sps);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ffprobe reads the recording back, when ffprobe is installed', async (t) => {
  const has = await run('ffprobe', ['-version']).then(() => true, () => false);
  if (!has) {
    t.skip('ffprobe is not installed');
    return;
  }
  const { dir, file } = await record(1000);
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'json', file]);
    const parsed: unknown = JSON.parse(stdout);
    assert.ok(typeof parsed === 'object' && parsed !== null && 'streams' in parsed && Array.isArray(parsed.streams));
    assert.deepEqual(parsed.streams[0], { codec_name: 'h264', width: 300, height: 654, nb_read_frames: '29' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('nothing is written before a keyframe with its parameter sets, and other sizes are dropped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-mp4-test-'));
  try {
    const file = join(dir, 'video.mp4');
    const head = (keyframe: boolean, ms: number, w: number, h: number): Buffer => {
      const b = Buffer.alloc(13);
      b.writeUInt8(keyframe ? 1 : 0, 0);
      b.writeDoubleBE(ms, 1);
      b.writeUInt16BE(w, 9);
      b.writeUInt16BE(h, 11);
      return b;
    };
    const start = Buffer.from([0, 0, 0, 1]);
    const p = Buffer.concat([head(false, 1, 10, 20), start, Buffer.from([0x41, 0x9a, 1])]);
    const rec = new Mp4Recorder(file);
    rec.push(p);
    assert.equal(await rec.finish(), false);
    assert.equal(await stat(file).catch(() => null), null);

    const idr = Buffer.concat([head(true, 10, 10, 20), start, Buffer.from([0x09, 0xf0]), start, Buffer.from([0x67, 0x42, 0, 0x1e]), start, Buffer.from([0x68, 0xce]), start, Buffer.from([0x65, 0x88, 2])]);
    const rotated = Buffer.concat([head(false, 20, 20, 10), start, Buffer.from([0x41, 0x9a, 3])]);
    const after = Buffer.concat([head(false, 30, 10, 20), start, Buffer.from([0x41, 0x9a, 4])]);
    const rec2 = new Mp4Recorder(file);
    rec2.push(p);
    rec2.push(idr);
    rec2.push(rotated);
    rec2.push(after);
    assert.equal(await rec2.finish(), true);
    const data = await readFile(file);
    assert.equal(find(data, [...STBL, 'stsz']).body.readUInt32BE(8), 2);
    const sample = data.subarray(HEADER_SIZE, HEADER_SIZE + 4 + 4 + 4 + 2 + 4 + 3);
    assert.deepEqual([...sample], [0, 0, 0, 4, 0x67, 0x42, 0, 0x1e, 0, 0, 0, 2, 0x68, 0xce, 0, 0, 0, 3, 0x65, 0x88, 2], 'the delimiter is dropped, the parameter sets stay in band');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('decode times count from the first frame at 90 kHz and always move forward', () => {
  assert.deepEqual(decodeTimes([{ ms: 1000 }, { ms: 1033.4 }, { ms: 1033.4 }, { ms: 1100 }]), [0, 3006, 3007, 9000]);
  assert.deepEqual(decodeTimes([]), []);
});
