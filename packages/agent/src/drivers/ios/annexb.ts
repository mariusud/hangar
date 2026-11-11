// Turns an H.264 Annex B byte stream that arrives in arbitrary chunks into the frame records the
// screen helper writes: u8 flags (1 = keyframe), f64 capture ms since epoch, u16 width, u16 height,
// then the frame's NAL units with 4-byte start codes.

const START = Buffer.from([0, 0, 1]);
const START4 = Buffer.from([0, 0, 0, 1]);

const nalType = (nal: Buffer): number => (nal[0] ?? 0) & 0x1f;
const isVcl = (type: number): boolean => type >= 1 && type <= 5;

// SEI, SPS, PPS and delimiters open a new access unit, and so does a slice with first_mb_in_slice
// 0, whose ue(v) code is then a single 1 bit.
function startsAccessUnit(nal: Buffer): boolean {
  const type = nalType(nal);
  return isVcl(type) ? ((nal[1] ?? 0) & 0x80) !== 0 : type === 6 || type === 7 || type === 8 || type === 9;
}

export type Size = { width: number; height: number };

class Bits {
  private data: Buffer;
  private pos = 0;
  constructor(data: Buffer) {
    this.data = data;
  }
  bit(): number {
    const byte = this.data[this.pos >> 3];
    if (byte === undefined) {
      throw new RangeError('SPS ended early');
    }
    const v = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos += 1;
    return v;
  }
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = v * 2 + this.bit();
    }
    return v;
  }
  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros += 1;
      if (zeros > 31) {
        throw new RangeError('Bad exp-Golomb code');
      }
    }
    return 2 ** zeros - 1 + this.bits(zeros);
  }
  se(): number {
    const v = this.ue();
    return v % 2 ? (v + 1) / 2 : -v / 2;
  }
}

function unescape(nal: Buffer): Buffer {
  const out: number[] = [];
  let zeros = 0;
  for (const b of nal) {
    if (zeros >= 2 && b === 3) {
      zeros = 0;
      continue;
    }
    zeros = b === 0 ? zeros + 1 : 0;
    out.push(b);
  }
  return Buffer.from(out);
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/** The picture size an H.264 sequence parameter set describes, after cropping, or null if it cannot be read. */
export function spsSize(nal: Buffer): Size | null {
  if (nalType(nal) !== 7) {
    return null;
  }
  try {
    const r = new Bits(unescape(nal.subarray(1)));
    const profile = r.bits(8);
    r.bits(16);
    r.ue();
    let chroma = 1;
    let separatePlanes = 0;
    if (HIGH_PROFILES.has(profile)) {
      chroma = r.ue();
      if (chroma === 3) {
        separatePlanes = r.bit();
      }
      r.ue();
      r.ue();
      r.bit();
      if (r.bit()) {
        for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
          if (r.bit()) {
            let last = 8;
            let next = 8;
            for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
              if (next !== 0) {
                next = (last + r.se() + 256) % 256;
              }
              last = next === 0 ? last : next;
            }
          }
        }
      }
    }
    r.ue();
    const pocType = r.ue();
    if (pocType === 0) {
      r.ue();
    } else if (pocType === 1) {
      r.bit();
      r.se();
      r.se();
      const n = r.ue();
      for (let i = 0; i < n; i++) {
        r.se();
      }
    }
    r.ue();
    r.bit();
    const widthMbs = r.ue() + 1;
    const heightUnits = r.ue() + 1;
    const frameMbsOnly = r.bit();
    if (!frameMbsOnly) {
      r.bit();
    }
    r.bit();
    let crop = { left: 0, right: 0, top: 0, bottom: 0 };
    if (r.bit()) {
      crop = { left: r.ue(), right: r.ue(), top: r.ue(), bottom: r.ue() };
    }
    const mono = chroma === 0 || separatePlanes === 1;
    const unitX = mono ? 1 : chroma === 3 ? 1 : 2;
    const unitY = (mono ? 1 : chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
    const width = widthMbs * 16 - (crop.left + crop.right) * unitX;
    const height = (2 - frameMbsOnly) * heightUnits * 16 - (crop.top + crop.bottom) * unitY;
    return width > 0 && height > 0 ? { width, height } : null;
  } catch {
    return null;
  }
}

export type Clock = () => number;

export class AnnexBFrames {
  private pending: Buffer = Buffer.alloc(0);
  private nals: Buffer[] = [];
  private size: Size = { width: 0, height: 0 };
  private lastMs = 0;
  private onFrame: (record: Buffer) => void;
  private now: Clock;

  constructor(onFrame: (record: Buffer) => void, now: Clock = Date.now) {
    this.onFrame = onFrame;
    this.now = now;
  }

  /** Adds bytes. Emits every frame that a later NAL unit proves complete. */
  push(chunk: Buffer): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let start = this.pending.indexOf(START);
    if (start < 0) {
      return;
    }
    for (;;) {
      const next = this.pending.indexOf(START, start + 3);
      if (next < 0) {
        break;
      }
      this.add(trimZeros(this.pending.subarray(start + 3, next)));
      start = next;
    }
    this.pending = this.pending.subarray(start);
    // The first two bytes of the next NAL unit already tell whether the held frame is finished.
    const head = this.pending.subarray(3, 5);
    if (head.length === 2 && startsAccessUnit(head) && this.nals.some((n) => isVcl(nalType(n)))) {
      this.emit();
    }
  }

  /** Treats the bytes held so far as a whole NAL unit and emits the frame they finish. */
  flush(): void {
    if (this.pending.length > 3 && this.pending.subarray(0, 3).equals(START)) {
      this.add(trimZeros(this.pending.subarray(3)));
      this.pending = Buffer.alloc(0);
    }
    if (this.nals.some((n) => isVcl(nalType(n)))) {
      this.emit();
    }
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
    this.nals = [];
  }

  private add(nal: Buffer): void {
    if (!nal.length) {
      return;
    }
    const type = nalType(nal);
    if (startsAccessUnit(nal) && this.nals.some((n) => isVcl(nalType(n)))) {
      this.emit();
    }
    if (type === 7) {
      this.size = spsSize(nal) ?? this.size;
    }
    this.nals.push(Buffer.from(nal));
  }

  private emit(): void {
    const nals = this.nals;
    this.nals = [];
    const keyframe = nals.some((n) => nalType(n) === 5);
    const ms = Math.max(this.now(), this.lastMs + 1);
    this.lastMs = ms;
    const head = Buffer.alloc(13);
    head.writeUInt8(keyframe ? 1 : 0, 0);
    head.writeDoubleBE(ms, 1);
    head.writeUInt16BE(Math.min(this.size.width, 0xffff), 9);
    head.writeUInt16BE(Math.min(this.size.height, 0xffff), 11);
    this.onFrame(Buffer.concat([head, ...nals.flatMap((n) => [START4, n])]));
  }
}

function trimZeros(nal: Buffer): Buffer {
  let end = nal.length;
  while (end > 0 && nal[end - 1] === 0) {
    end -= 1;
  }
  return nal.subarray(0, end);
}
