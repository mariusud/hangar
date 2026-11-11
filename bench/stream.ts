import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Lease } from 'hangar';
import { start } from '../e2e/harness.ts';

const TRIALS = Number(process.env.TRIALS ?? 15);
const BASELINE = new URL('./stream.baseline.json', import.meta.url);

type Frame = { at: number; capture: number | null; bytes: number };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function q(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]! * 10) / 10 : NaN;
}

function machine(): string {
  const chip = execFileSync('sysctl', ['-n', 'machdep.cpu.brand_string']).toString().trim();
  const xcode = execFileSync('xcodebuild', ['-version']).toString().split('\n')[0];
  return `${chip}, ${xcode}`;
}

async function viewer(url: string, leaseId: string, token: string, codec: 'h264' | 'jpeg'): Promise<{ frames: Frame[]; send: (m: unknown) => void; close: () => void }> {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/v1/leases/${leaseId}/stream?codec=${codec}&token=${token}`);
  ws.binaryType = 'arraybuffer';
  const frames: Frame[] = [];
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      return;
    }
    const b = Buffer.from(e.data as ArrayBuffer);
    frames.push({ at: Date.now(), capture: b[0] === 2 ? b.readDoubleBE(2) : null, bytes: b.length });
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return { frames, send: (m) => ws.send(JSON.stringify(m)), close: () => ws.close() };
}

async function quiet(frames: Frame[], ms: number, codec: 'h264' | 'jpeg'): Promise<void> {
  if (codec === 'jpeg') {
    await sleep(ms);
    return;
  }
  for (let i = 0; i < 100; i++) {
    const last = frames.at(-1)?.at ?? 0;
    if (Date.now() - last >= ms) {
      return;
    }
    await sleep(50);
  }
}

async function measure(url: string, lease: Lease, token: string, codec: 'h264' | 'jpeg') {
  const leaseId = lease.id;
  const v = await viewer(url, leaseId, token, codec);
  const input: number[] = [];
  const toCapture: number[] = [];
  const fps: number[] = [];
  const bytesPerSecond: number[] = [];
  await sleep(1500);
  for (let i = 0; i < TRIALS; i++) {
    process.stderr.write(`${codec} trial ${i + 1}/${TRIALS}\r`);
    const target = await settingsHome(lease);
    await quiet(v.frames, 500, codec);
    const before = v.frames.at(-1)?.bytes;
    const t0 = Date.now();
    const seen = v.frames.length;
    v.send({ type: 'swipe', from: target, to: [target[0], target[1] - 0.25], durationMs: 300 });
    let first: Frame | undefined;
    for (let k = 0; k < 400 && !first; k++) {
      await sleep(2);
      first = v.frames.slice(seen).find((f) => f.at >= t0 && (codec === 'h264' || f.bytes !== before));
    }
    if (!first) {
      continue;
    }
    input.push(first.at - t0);
    if (first.capture !== null) {
      toCapture.push(first.capture - t0);
    }
    // Motion lasts about half a second, hence the doubling below.
    await sleep(600);
    const motion = v.frames.filter((f) => f.at >= first.at && f.at < first.at + 500);
    fps.push(motion.length * 2);
    bytesPerSecond.push(motion.reduce((a, f) => a + f.bytes, 0) * 2);
  }
  v.close();
  const transit = v.frames.filter((f) => f.capture !== null).map((f) => f.at - f.capture!);
  return {
    trials: input.length,
    inputToFrame: { p50: q(input, 0.5), p95: q(input, 0.95) },
    inputToCapture: toCapture.length ? { p50: q(toCapture, 0.5), p95: q(toCapture, 0.95) } : null,
    captureToClient: transit.length ? { p50: q(transit, 0.5), p95: q(transit, 0.95) } : null,
    motionFps: q(fps, 0.5),
    motionKBps: Math.round(q(bytesPerSecond, 0.5) / 1024),
  };
}

async function settingsHome(lease: Lease): Promise<[number, number]> {
  await lease.terminate('com.apple.Preferences').catch(() => {});
  await lease.launch('com.apple.Preferences');
  await lease.waitFor({ label: 'General', role: 'button' }, 10_000);
  const { nodes } = await lease.ui();
  const n = nodes.find((x) => x.label === 'General' && /button/i.test(x.role));
  if (!n) {
    throw new Error('Settings shows no General row.');
  }
  await sleep(700);
  return [n.normalized.x + n.normalized.width / 2, n.normalized.y + n.normalized.height / 2];
}

// The capture path the leased device's H.264 stream used, as the broker reports it.
async function capture(url: string, token: string): Promise<string | null> {
  const res = await fetch(`${url}/v1/devices`, { headers: { authorization: `Bearer ${token}` } });
  const devices: { state: string; capture?: string | null }[] = await res.json();
  return devices.find((d) => d.state === 'leased')?.capture ?? null;
}

const h = await start(1, () => {});
try {
  const { hangar, token } = h.client('bench');
  const lease = await hangar.lease({}, { autoRenew: false });
  const results = {
    machine: machine(),
    date: new Date().toISOString().slice(0, 10),
    h264: await measure(h.broker.url, lease, token, 'h264'),
    capture: await capture(h.broker.url, token),
    jpeg: await measure(h.broker.url, lease, token, 'jpeg'),
  };
  if (results.capture !== 'iosurface') {
    console.error(`The H.264 numbers come from the ${results.capture ?? 'unknown'} capture path, not the IOSurface helper; do not compare them with the baseline.`);
  }
  await lease.release();
  console.log(JSON.stringify(results, null, 2));

  if (process.argv.includes('--save')) {
    writeFileSync(BASELINE, `${JSON.stringify(results, null, 2)}\n`);
  }
  if (process.argv.includes('--check')) {
    const base = JSON.parse(readFileSync(BASELINE, 'utf8')) as typeof results;
    const worse: string[] = [];
    for (const [name, now, then] of [
      ['h264 input to frame', results.h264.inputToFrame.p95, base.h264.inputToFrame.p95],
      ['h264 capture to client', results.h264.captureToClient?.p95 ?? NaN, base.h264.captureToClient?.p95 ?? NaN],
    ] as const) {
      if (now > then * 1.1) {
        worse.push(`${name}: p95 ${now} ms, baseline ${then} ms`);
      }
    }
    if (worse.length) {
      console.error(`Slower than the baseline:\n  ${worse.join('\n  ')}`);
      process.exitCode = 1;
    }
  }
} finally {
  await h.stop();
}
