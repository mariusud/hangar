// bench/metro: Fast Refresh on a leased simulator, from saving a file to the change on screen.
//
// It starts Metro for examples/hello on this machine, leases a device through the real broker
// and agent, installs the Debug build (HELLO_APP, or the one in Xcode's DerivedData), connects it
// through the Metro tunnel, then edits App.tsx TRIALS times. The time is from the write to the
// first H.264 frame captured after it; the app is otherwise still, so that frame is the refresh.
// Each trial also checks the new text in the accessibility tree.
//
//   pnpm bench:metro

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { start } from '../e2e/harness.ts';

const TRIALS = Number(process.env.TRIALS ?? 10);
const HELLO = new URL('../examples/hello/', import.meta.url).pathname;
const APP_FILE = join(HELLO, 'App.tsx');
const PORT = 8090;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function q(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]!) : NaN;
}

function debugApp(): string {
  if (process.env.HELLO_APP) {
    return process.env.HELLO_APP;
  }
  const out = execFileSync('find', [join(process.env.HOME!, 'Library/Developer/Xcode/DerivedData'), '-maxdepth', '5', '-path', '*Debug-iphonesimulator/HangarHello.app']).toString().trim().split('\n')[0];
  if (!out) {
    throw new Error('No Debug build of examples/hello. Build it (see examples/hello/README.md) or set HELLO_APP.');
  }
  return out;
}

async function metroUp(): Promise<boolean> {
  try {
    return (await (await fetch(`http://localhost:${PORT}/status`)).text()).includes('running');
  } catch {
    return false;
  }
}

const original = readFileSync(APP_FILE, 'utf8');
const metro = spawn('npx', ['expo', 'start', '--localhost', '--port', String(PORT)], { cwd: HELLO, stdio: 'ignore', detached: true });
const h = await start(1, () => {});
try {
  for (let i = 0; i < 240 && !(await metroUp()); i++) {
    await sleep(500);
  }
  const { hangar, token } = h.client('bench');
  const lease = await hangar.lease({}, { autoRenew: false });
  const tunnel = await lease.metroTunnel(PORT);
  await lease.install(debugApp());
  await lease.useMetro('dev.hangar.hello');
  await lease.launch('dev.hangar.hello');
  await lease.waitFor({ label: 'Hello from Hangar' }, 120_000);

  const frames: number[] = [];
  const ws = new WebSocket(`${h.broker.url.replace('http', 'ws')}/v1/leases/${lease.id}/stream?codec=h264&token=${token}`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') {
      frames.push(Buffer.from(e.data as ArrayBuffer).readDoubleBE(2));
    }
  };
  await sleep(3000);

  const times: number[] = [];
  for (let i = 0; i < TRIALS; i++) {
    const label = `Hello ${i + 1}`;
    const t0 = Date.now();
    writeFileSync(APP_FILE, original.replace('Hello from Hangar', label));
    let shown = false;
    for (let k = 0; k < 60 && !shown; k++) {
      shown = (await lease.ui()).nodes.some((n) => n.label === label);
    }
    const first = frames.find((t) => t >= t0);
    if (shown && first !== undefined) {
      times.push(first - t0);
    }
    await sleep(1500);
  }
  ws.close();
  tunnel.close();
  await lease.release();
  console.log(JSON.stringify({ date: new Date().toISOString().slice(0, 10), trials: times.length, saveToFrame: { p50: q(times, 0.5), p95: q(times, 0.95), max: q(times, 1) } }, null, 2));
} finally {
  writeFileSync(APP_FILE, original);
  try {
    process.kill(-metro.pid!, 'SIGTERM');
  } catch {
    metro.kill();
  }
  await h.stop();
}
