// bench/compare: Hangar next to other open-source simulator tools, on one Mac, with the same
// simulator model and the same test for each.
//
// Stream: Settings is open, a 300 ms swipe scrolls the list, and the bench times the first video
// frame that reaches the client after the swipe starts, then the frame rate and bandwidth while
// the list moves. None of the other tools stamp frames with a capture time, so only the end to
// end number is compared. Lease: from asking for a device to holding one, from a warm pool.
//
// The bench downloads nothing. Install the other tools yourself, in a directory of their own,
// and point the bench at them; a tool that is not set is skipped.
//
//   SERVE_SIM=<dir>/node_modules/serve-sim  SIMLOCK=<dir>/node_modules/simlock  pnpm bench:compare
//
// serve-sim attaches to one booted simulator, so the bench creates one (and deletes it after).
// Simlock runs its own daemon in a temporary SIMLOCK_HOME, with its stream set to the device's
// full resolution at 60 fps like the others, and a warm pool of one.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { start } from '../e2e/harness.ts';

const run = promisify(execFile);
const TRIALS = Number(process.env.TRIALS ?? 10);
const MODEL = 'iPhone 17 Pro';
const SETTINGS = 'com.apple.Preferences';
const FROM: Point = [0.5, 0.6];
const TO: Point = [0.5, 0.35];

type Point = [number, number];
type Frame = { at: number; bytes: number };
type Tool = {
  name: string;
  frames: Frame[];
  openSettings: () => Promise<void>;
  swipe: (from: Point, to: Point) => void;
  close: () => Promise<void>;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function q(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]!) : NaN;
}

async function measureStream(tool: Tool) {
  const input: number[] = [];
  const fps: number[] = [];
  const bytesPerSecond: number[] = [];
  let missed = 0;
  // Settings opens once. Relaunching it per trial measured app launch under load, not the
  // stream; each trial scrolls the list back afterwards instead.
  await tool.openSettings();
  await sleep(3000);
  for (let i = 0; i < TRIALS; i++) {
    process.stderr.write(`${tool.name} stream ${i + 1}/${TRIALS}\r`);
    await quiet(tool.frames);
    const t0 = performance.now();
    const seen = tool.frames.length;
    tool.swipe(FROM, TO);
    let first: Frame | undefined;
    for (let k = 0; k < 1000 && !first; k++) {
      await sleep(2);
      first = tool.frames.slice(seen).find((f) => f.at >= t0);
    }
    if (!first) {
      missed += 1;
      continue;
    }
    await sleep(600);
    const motion = tool.frames.filter((f) => f.at >= first.at && f.at < first.at + 500);
    // A scroll is a run of frames. One or two frames are a repaint (the clock, a touch
    // highlight, an idle refresh), so the swipe did not land and the trial does not count.
    tool.swipe(TO, FROM);
    if (motion.length < 10) {
      missed += 1;
      continue;
    }
    input.push(first.at - t0);
    fps.push(motion.length * 2);
    bytesPerSecond.push(motion.reduce((a, f) => a + f.bytes, 0) * 2);
  }
  return {
    trials: input.length,
    missed,
    inputToFrame: { p50: q(input, 0.5), p95: q(input, 0.95) },
    motionFps: q(fps, 0.5),
    motionKBps: Math.round(q(bytesPerSecond, 0.5) / 1024),
  };
}

// Waits until no frame has arrived for half a second, so the next swipe starts from a still screen.
async function quiet(frames: Frame[]): Promise<void> {
  for (let i = 0; i < 100 && performance.now() - (frames.at(-1)?.at ?? 0) < 500; i++) {
    await sleep(50);
  }
}

// serve-sim and Simlock share one framing: [u32 length][tag][payload], where the length covers
// the tag. Tags 2 and 3 are H.264 key and delta frames; the rest are config, seed and keep-alive.
async function readEnvelopes(body: ReadableStream<Uint8Array>, frames: Frame[]): Promise<void> {
  let buf = Buffer.alloc(0);
  const reader = body.getReader();
  for (let r = await reader.read(); !r.done; r = await reader.read()) {
    buf = Buffer.concat([buf, r.value]);
    while (buf.length >= 5) {
      const total = 4 + buf.readUInt32BE(0);
      if (buf.length < total) {
        break;
      }
      if (buf[4] === 2 || buf[4] === 3) {
        frames.push({ at: performance.now(), bytes: total });
      }
      buf = buf.subarray(total);
    }
  }
}

// Both also take serve-sim's touch messages: tag 0x03 and {type, x, y} with x and y from 0 to 1.
// The swipe is sent the way their browser clients send a drag: a move every 16 ms.
function drag(ws: WebSocket, from: Point, to: Point): void {
  const send = (type: string, [x, y]: Point): void => ws.send(Buffer.concat([Buffer.from([0x03]), Buffer.from(JSON.stringify({ type, x, y }))]));
  const steps = 18;
  send('begin', from);
  let i = 0;
  const timer = setInterval(() => {
    i += 1;
    const t = i / steps;
    const p: Point = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
    send(i < steps ? 'move' : 'end', p);
    if (i === steps) {
      clearInterval(timer);
    }
  }, 16);
}

async function openSocket(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  // Node's WebSocket (undici) takes headers as a second argument; browsers don't.
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  ws.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`Could not open ${url}`));
  });
  return ws;
}

async function hangarTool(): Promise<Tool & { leases: () => Promise<{ p50: number; p95: number }> }> {
  const h = await start(1, () => {});
  const { hangar, token } = h.client('bench');
  const ready = async (): Promise<void> => {
    while (!(await hangar.devices()).some((d) => d.state === 'ready')) {
      await sleep(100);
    }
  };
  const lease = await hangar.lease({}, { autoRenew: false });
  const frames: Frame[] = [];
  const ws = await openSocket(`${h.broker.url.replace('http', 'ws')}/v1/leases/${lease.id}/stream?codec=h264&token=${token}`);
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') {
      frames.push({ at: performance.now(), bytes: (e.data as ArrayBuffer).byteLength });
    }
  };
  return {
    name: 'Hangar',
    frames,
    openSettings: async () => {
      await lease.terminate(SETTINGS).catch(() => {});
      await lease.launch(SETTINGS);
    },
    swipe: (from, to) => ws.send(JSON.stringify({ type: 'swipe', from, to, durationMs: 300 })),
    leases: async () => {
      ws.close();
      await lease.release();
      const times: number[] = [];
      for (let i = 0; i < Math.min(TRIALS, 5); i++) {
        process.stderr.write(`Hangar lease ${i + 1}\r`);
        await ready();
        const t0 = performance.now();
        const l = await hangar.lease({}, { autoRenew: false });
        times.push(performance.now() - t0);
        await l.release();
      }
      return { p50: q(times, 0.5), p95: q(times, 0.95) };
    },
    close: () => h.stop(),
  };
}

async function serveSimTool(pkg: string): Promise<Tool> {
  const { stdout } = await run('xcrun', ['simctl', 'create', 'hangar-compare', MODEL]);
  const udid = stdout.trim();
  await run('xcrun', ['simctl', 'bootstatus', udid, '-b']);
  const cli = join(pkg, 'dist/serve-sim.js');
  const out = await run('node', [cli, '--detach', '-q', '-p', '3150', udid]);
  const { url } = JSON.parse(out.stdout.trim().split('\n').at(-1)!) as { url: string };
  const base = `${url}/helper/${udid}`;
  const frames: Frame[] = [];
  const res = await fetch(`${base}/stream.avcc`);
  void readEnvelopes(res.body!, frames).catch(() => {});
  const ws = await openSocket(`${base.replace('http', 'ws')}/ws`);
  return {
    name: 'serve-sim',
    frames,
    openSettings: async () => {
      await run('xcrun', ['simctl', 'terminate', udid, SETTINGS]).catch(() => {});
      await run('xcrun', ['simctl', 'launch', udid, SETTINGS]);
    },
    swipe: (from, to) => drag(ws, from, to),
    close: async () => {
      ws.close();
      await res.body?.cancel().catch(() => {});
      await run('node', [cli, '--kill', udid]).catch(() => {});
      await run('xcrun', ['simctl', 'delete', udid]).catch(() => {});
    },
  };
}

async function simlockTool(pkg: string): Promise<Tool & { leases: () => Promise<{ p50: number; p95: number }> }> {
  // daemon.sock has to fit in a unix socket path, so the home stays short.
  const home = await mkdtemp('/tmp/slk-');
  const port = 4801;
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      http: { port },
      capabilities: { input: { enabled: true }, stream: { enabled: true, fps: 60, maxDimension: 2622, bitrateKbps: 8000 } },
      warmPool: { targets: [{ platform: 'ios', model: MODEL, count: 1 }] },
    }),
  );
  const env = { ...process.env, SIMLOCK_HOME: home };
  const daemon: ChildProcess = spawn('node', [join(pkg, 'dist/daemon/main.js')], { env, stdio: 'ignore' });
  process.on('exit', () => daemon.kill());
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) {
    if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) {
      break;
    }
    await sleep(100);
  }
  const cli = (args: string[]) => run('node', [join(pkg, 'dist/cli/main.js'), ...args], { env });
  const token = /slk_[\w-]+/.exec((await cli(['token', 'create', '--role', 'operator'])).stdout)?.[0];
  if (!token) {
    throw new Error('Simlock gave no token.');
  }
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const json = async <T>(r: Response): Promise<T> => {
    if (!r.ok) {
      throw new Error(`Simlock ${r.status}: ${await r.text()}`);
    }
    return (await r.json()) as T;
  };
  type Request = { id: string; state: string; lease?: { id: string; udid: string } };
  const lease = async (): Promise<{ id: string; udid: string }> => {
    let { request } = await json<{ request: Request }>(
      await fetch(`${base}/v1/lease-requests`, { method: 'POST', headers, body: JSON.stringify({ platform: 'ios', device: MODEL, timeoutMs: 600_000 }) }),
    );
    while (request.state !== 'granted') {
      if (request.state === 'failed' || request.state === 'cancelled') {
        throw new Error(`Simlock lease ${request.state}.`);
      }
      ({ request } = await json<{ request: Request }>(await fetch(`${base}/v1/lease-requests/${request.id}?wait=30`, { headers })));
    }
    return request.lease!;
  };
  const release = (id: string) => fetch(`${base}/v1/leases/${id}`, { method: 'DELETE', headers });

  const held = await lease();
  const frames: Frame[] = [];
  const res = await fetch(`${base}/v1/leases/${held.id}/stream`, { headers });
  void readEnvelopes(res.body!, frames).catch(() => {});
  const ws = await openSocket(`${base.replace('http', 'ws')}/v1/leases/${held.id}/input`, headers);
  return {
    name: 'Simlock',
    frames,
    openSettings: async () => {
      await cli(['simctl', 'terminate', held.udid, SETTINGS]).catch(() => {});
      await cli(['simctl', 'launch', held.udid, SETTINGS]);
    },
    swipe: (from, to) => drag(ws, from, to),
    leases: async () => {
      ws.close();
      await res.body?.cancel().catch(() => {});
      await release(held.id);
      const times: number[] = [];
      for (let i = 0; i < Math.min(TRIALS, 5); i++) {
        process.stderr.write(`Simlock lease ${i + 1}\r`);
        // Simlock has no ready count to wait on; give a released device time to settle.
        await sleep(15_000);
        const t0 = performance.now();
        const l = await lease();
        times.push(performance.now() - t0);
        await release(l.id);
      }
      return { p50: q(times, 0.5), p95: q(times, 0.95) };
    },
    close: async () => {
      await cli(['nuke', '--delete-devices', '--yes']).catch(() => {});
      daemon.kill();
      await rm(home, { recursive: true, force: true });
    },
  };
}

const results: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), trials: TRIALS };
const makers: [string, () => Promise<Tool & { leases?: () => Promise<{ p50: number; p95: number }> }>][] = [['Hangar', hangarTool]];
if (process.env.SERVE_SIM) {
  makers.push(['serve-sim', () => serveSimTool(process.env.SERVE_SIM!)]);
}
if (process.env.SIMLOCK) {
  makers.push(['Simlock', () => simlockTool(process.env.SIMLOCK!)]);
}
for (const [name, make] of makers) {
  let tool: Awaited<ReturnType<typeof make>> | undefined;
  try {
    tool = await make();
    const stream = await measureStream(tool);
    results[name] = { stream, lease: tool.leases ? await tool.leases() : 'no leases' };
  } catch (err) {
    results[name] = { error: (err as Error).message };
  } finally {
    await tool?.close();
  }
  console.error(`\n${name}: ${JSON.stringify(results[name])}`);
}
console.log(JSON.stringify(results, null, 2));
