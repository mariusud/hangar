import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnnexBFrames, spsSize } from './annexb.ts';

class BitWriter {
  private bits: number[] = [];
  u(n: number, v: number): this {
    for (let i = n - 1; i >= 0; i--) {
      this.bits.push(Math.floor(v / 2 ** i) % 2);
    }
    return this;
  }
  ue(v: number): this {
    const len = Math.floor(Math.log2(v + 1));
    return this.u(len, 0).u(len + 1, v + 1);
  }
  bytes(): Buffer {
    const bits = [...this.bits, 1];
    while (bits.length % 8) {
      bits.push(0);
    }
    const out: number[] = [];
    for (let i = 0; i < bits.length; i += 8) {
      out.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0));
    }
    return Buffer.from(out);
  }
}

function escape(rbsp: Buffer): Buffer {
  const out: number[] = [];
  let zeros = 0;
  for (const b of rbsp) {
    if (zeros >= 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

// 1180 x 2556 needs cropping from 1184 x 2560 macroblocks.
function sps(profile: number): Buffer {
  const w = new BitWriter().u(8, profile).u(8, 0).u(8, 51).ue(0);
  if (profile === 100) {
    w.ue(1).ue(0).ue(0).u(1, 0).u(1, 0);
  }
  w.ue(0).ue(2).ue(1).u(1, 0).ue(1184 / 16 - 1).ue(2560 / 16 - 1).u(1, 1).u(1, 1);
  w.u(1, 1).ue(0).ue(2).ue(0).ue(2);
  w.u(1, 0);
  return Buffer.concat([Buffer.from([0x67]), escape(w.bytes())]);
}

test('spsSize reads the cropped picture size from baseline and high profile SPS', () => {
  assert.deepEqual(spsSize(sps(66)), { width: 1184 - 4, height: 2560 - 4 });
  assert.deepEqual(spsSize(sps(100)), { width: 1184 - 4, height: 2560 - 4 });
  assert.equal(spsSize(Buffer.from([0x68, 0xce])), null);
  assert.equal(spsSize(Buffer.from([0x67, 0x42])), null);
});

const SC = Buffer.from([0, 0, 0, 1]);
const pps = Buffer.from([0x68, 0xce, 0x3c, 0x80]);
const idr = Buffer.from([0x65, 0x88, 0x84, 0x21]);
const slice = (n: number): Buffer => Buffer.from([0x41, 0x9a, n, 0x7f]);

function stream(): Buffer {
  return Buffer.concat([SC, sps(66), SC, pps, SC, idr, SC, slice(1), SC, slice(2)]);
}

test('frames come out with the screen helper record layout whatever the chunking', () => {
  for (const size of [1, 3, 7, 1000]) {
    const records: Buffer[] = [];
    const t = 1000;
    const frames = new AnnexBFrames((r) => records.push(r), () => t);
    const all = stream();
    for (let i = 0; i < all.length; i += size) {
      frames.push(all.subarray(i, i + size));
    }
    assert.equal(records.length, 2, `chunk ${size}`);
    frames.flush();
    assert.equal(records.length, 3);
    const [key, second, third] = records;
    assert.ok(key && second && third);
    assert.equal(key[0], 1);
    assert.equal(second[0], 0);
    assert.equal(key.readDoubleBE(1), 1000);
    assert.equal(second.readDoubleBE(1), 1001, 'timestamps keep increasing on the same clock reading');
    assert.equal(key.readUInt16BE(9), 1180);
    assert.equal(key.readUInt16BE(11), 2556);
    assert.deepEqual(key.subarray(13), Buffer.concat([SC, sps(66), SC, pps, SC, idr]));
    assert.deepEqual(third.subarray(13), Buffer.concat([SC, slice(2)]));
  }
});

test('a slice that continues a picture stays in the same frame', () => {
  const records: Buffer[] = [];
  const frames = new AnnexBFrames((r) => records.push(r));
  const second = Buffer.from([0x65, 0x10, 0x20]);
  frames.push(Buffer.concat([SC, idr, Buffer.from([0, 0, 1]), second]));
  frames.flush();
  assert.equal(records.length, 1);
  assert.deepEqual(records[0]?.subarray(13), Buffer.concat([SC, idr, SC, second]));
});

test('flush without a picture emits nothing and parameter sets wait for their frame', () => {
  const records: Buffer[] = [];
  const frames = new AnnexBFrames((r) => records.push(r));
  frames.push(Buffer.concat([SC, sps(66), SC, pps]));
  frames.flush();
  assert.equal(records.length, 0);
  frames.push(Buffer.concat([SC, idr]));
  frames.flush();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.[0], 1);
});
