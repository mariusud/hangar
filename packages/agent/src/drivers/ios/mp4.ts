// Writes H.264 frame records (see annexb.ts) to an MP4 file with no second encode: the idb capture
// path has no AVAssetWriter, so this is the muxer for it. One video track, one sample per chunk,
// parameter sets in the avcC box and left in band as well.
import { open, type FileHandle } from 'node:fs/promises';

/** Track and movie timescale: 90 kHz, the usual one for video. */
export const TIMESCALE = 90_000;
/** Duration given to the last sample, which has no next sample to measure against. */
const LAST_SAMPLE = TIMESCALE / 30;
const START = Buffer.from([0, 0, 1]);

export type Frame = { keyframe: boolean; ms: number; width: number; height: number; nals: Buffer[] };
export type SampleEntry = { size: number; offset: number; ms: number; keyframe: boolean };
export type Track = { sps: Buffer; pps: Buffer; width: number; height: number };

/** Reads a frame record: u8 flags, f64 ms, u16 width, u16 height, then Annex B NAL units. */
export function parseRecord(record: Buffer): Frame | null {
  if (record.length < 13) {
    return null;
  }
  const nals: Buffer[] = [];
  const body = record.subarray(13);
  let start = body.indexOf(START);
  while (start >= 0) {
    const next = body.indexOf(START, start + 3);
    let nal = body.subarray(start + 3, next < 0 ? body.length : next);
    let end = nal.length;
    while (end > 0 && nal[end - 1] === 0) {
      end -= 1;
    }
    nal = nal.subarray(0, end);
    if (nal.length) {
      nals.push(nal);
    }
    start = next;
  }
  return { keyframe: ((record[0] ?? 0) & 1) === 1, ms: record.readDoubleBE(1), width: record.readUInt16BE(9), height: record.readUInt16BE(11), nals };
}

const nalType = (nal: Buffer): number => (nal[0] ?? 0) & 0x1f;

/** The sample bytes for a frame: each NAL unit with a 4-byte length, access unit delimiters dropped. */
export function sampleBytes(nals: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  for (const nal of nals) {
    if (nalType(nal) === 9) {
      continue;
    }
    const len = Buffer.alloc(4);
    len.writeUInt32BE(nal.length);
    parts.push(len, nal);
  }
  return Buffer.concat(parts);
}

function u8(v: number): Buffer {
  return Buffer.from([v & 0xff]);
}

function u16(v: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(v & 0xffff);
  return b;
}

function u32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(v >>> 0);
  return b;
}

function u64(v: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(v));
  return b;
}

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]);
}

function fullBox(type: string, version: number, flags: number, ...parts: Buffer[]): Buffer {
  return box(type, u32((version << 24) | flags), ...parts);
}

const MATRIX = Buffer.concat([0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32));

/** ftyp, then an mdat header with a 64-bit size that finish() fills in. */
export function header(): Buffer {
  const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), u32(0x200), Buffer.from('isomiso2avc1mp41', 'latin1'));
  return Buffer.concat([ftyp, u32(1), Buffer.from('mdat', 'latin1'), u64(0)]);
}

export const HEADER_SIZE = header().length;

/** Decode times in TIMESCALE units from the first sample, each at least one unit after the last. */
export function decodeTimes(samples: { ms: number }[]): number[] {
  const first = samples[0]?.ms ?? 0;
  const out: number[] = [];
  for (const s of samples) {
    const t = Math.round(((s.ms - first) * TIMESCALE) / 1000);
    const prev = out[out.length - 1];
    out.push(prev === undefined ? 0 : Math.max(t, prev + 1));
  }
  return out;
}

function avcC(track: Track): Buffer {
  return box(
    'avcC',
    u8(1),
    u8(track.sps[1] ?? 0),
    u8(track.sps[2] ?? 0),
    u8(track.sps[3] ?? 0),
    u8(0xff),
    u8(0xe1),
    u16(track.sps.length),
    track.sps,
    u8(1),
    u16(track.pps.length),
    track.pps,
  );
}

/** The moov box for a finished recording. Pure, so tests can read it back. */
export function movie(track: Track, samples: SampleEntry[]): Buffer {
  const times = decodeTimes(samples);
  const deltas = times.map((t, i) => (times[i + 1] ?? t + LAST_SAMPLE) - t);
  const duration = deltas.reduce((a, b) => a + b, 0);

  const stts: Buffer[] = [];
  let runs = 0;
  for (let i = 0; i < deltas.length; ) {
    let j = i;
    while (j < deltas.length && deltas[j] === deltas[i]) {
      j += 1;
    }
    stts.push(u32(j - i), u32(deltas[i] ?? 0));
    runs += 1;
    i = j;
  }
  const sync = samples.flatMap((s, i) => (s.keyframe ? [u32(i + 1)] : []));

  const avc1 = box(
    'avc1',
    Buffer.alloc(6),
    u16(1),
    Buffer.alloc(16),
    u16(track.width),
    u16(track.height),
    u32(0x480000),
    u32(0x480000),
    u32(0),
    u16(1),
    Buffer.alloc(32),
    u16(0x18),
    u16(0xffff),
    avcC(track),
  );
  const stbl = box(
    'stbl',
    fullBox('stsd', 0, 0, u32(1), avc1),
    fullBox('stts', 0, 0, u32(runs), ...stts),
    fullBox('stss', 0, 0, u32(sync.length), ...sync),
    fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)),
    fullBox('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.size))),
    fullBox('co64', 0, 0, u32(samples.length), ...samples.map((s) => u64(s.offset))),
  );
  const minf = box(
    'minf',
    fullBox('vmhd', 0, 1, Buffer.alloc(8)),
    box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
    stbl,
  );
  const mdia = box(
    'mdia',
    fullBox('mdhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(duration), u16(0x55c4), u16(0)),
    fullBox('hdlr', 0, 0, u32(0), Buffer.from('vide', 'latin1'), Buffer.alloc(12), Buffer.from('VideoHandler\0', 'latin1')),
    minf,
  );
  const tkhd = fullBox('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(duration), Buffer.alloc(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(track.width * 0x10000), u32(track.height * 0x10000));
  const mvhd = fullBox('mvhd', 0, 0, u32(0), u32(0), u32(TIMESCALE), u32(duration), u32(0x10000), u16(0x100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(2));
  return box('moov', mvhd, box('trak', tkhd, mdia));
}

/**
 * Records frame records to an MP4 file. Nothing is written until the first keyframe that carries
 * its SPS and PPS. Frames of another size (after a rotation) are dropped, like the screen helper
 * does, because one track holds one size.
 */
export class Mp4Recorder {
  readonly path: string;
  private track: Track | null = null;
  private samples: SampleEntry[] = [];
  private offset = HEADER_SIZE;
  private file: Promise<FileHandle> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private failed: Error | null = null;
  private done: Promise<boolean> | null = null;

  constructor(path: string) {
    this.path = path;
  }

  push(record: Buffer): void {
    if (this.done || this.failed) {
      return;
    }
    const frame = parseRecord(record);
    if (!frame) {
      return;
    }
    if (!this.track) {
      const sps = frame.nals.find((n) => nalType(n) === 7);
      const pps = frame.nals.find((n) => nalType(n) === 8);
      if (!frame.keyframe || !sps || !pps) {
        return;
      }
      this.track = { sps: Buffer.from(sps), pps: Buffer.from(pps), width: frame.width, height: frame.height };
      this.file = open(this.path, 'w');
      this.write(header(), 0);
    } else if (frame.width !== this.track.width || frame.height !== this.track.height) {
      return;
    }
    const data = sampleBytes(frame.nals);
    this.samples.push({ size: data.length, offset: this.offset, ms: frame.ms, keyframe: frame.keyframe });
    this.write(data, this.offset);
    this.offset += data.length;
  }

  /** Writes the moov box and closes the file. Resolves false when no keyframe ever came, and no file exists. */
  finish(): Promise<boolean> {
    this.done ??= this.close();
    return this.done;
  }

  private write(data: Buffer, position: number): void {
    const file = this.file;
    this.writes = this.writes.then(async () => {
      if (!file || this.failed) {
        return;
      }
      try {
        await (await file).write(data, 0, data.length, position);
      } catch (err) {
        this.failed = err instanceof Error ? err : new Error(String(err));
      }
    });
  }

  private async close(): Promise<boolean> {
    if (!this.track || !this.file) {
      return false;
    }
    this.write(movie(this.track, this.samples), this.offset);
    this.write(u64(this.offset - HEADER_SIZE + 16), HEADER_SIZE - 8);
    await this.writes;
    await (await this.file).close();
    if (this.failed) {
      throw this.failed;
    }
    return true;
  }
}
