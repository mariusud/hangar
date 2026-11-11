// Checks that this Mac's Xcode works with Hangar, and writes the result to hosts/versions.json
// (or HANGAR_VERSIONS). It boots and clones real simulators. Run it on each new Xcode:
//   pnpm bench:smoke
// Set HANGAR_SMOKE_APP to a built examples/hello .app to also run its two Maestro flows.
// It names its simulators hangar-smoke-* (or HANGAR_SIM_PREFIX), makes its own golden, and deletes
// them all at the end, so it leaves the simulators of a running Hangar alone. HANGAR_SMOKE_LOG=1
// prints the agent's log.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runMaestro, type Lease } from 'hangar';
import { currentXcode, recordSmoke, versionsFile, type SmokeEntry, type SmokeStep } from '../packages/hangar/src/versions.ts';
import type { Harness } from '../e2e/harness.ts';

// The driver reads the prefix when it loads, so the harness is imported after this.
process.env.HANGAR_SIM_PREFIX ||= 'hangar-smoke-';
const prefix = process.env.HANGAR_SIM_PREFIX;
if (prefix === 'hangar-' || !prefix.startsWith('hangar-')) {
  console.error('Set HANGAR_SIM_PREFIX to a name that starts with hangar- and is longer, such as hangar-smoke-, so the smoke test only touches its own simulators.');
  process.exit(1);
}
const { start } = await import('../e2e/harness.ts');

const run = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const flowsDir = fileURLToPath(new URL('../examples/hello/.maestro', import.meta.url));

const xcode = await currentXcode();
if (!xcode) {
  console.error('xcodebuild -version failed. Install Xcode and select it with `sudo xcode-select -s /Applications/Xcode.app`.');
  process.exit(1);
}

const steps: SmokeStep[] = [];
let failed = false;

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  if (failed) {
    steps.push({ name, status: 'skipped', ms: 0, detail: 'an earlier step failed' });
    return null;
  }
  const t0 = performance.now();
  try {
    const value = await fn();
    steps.push({ name, status: 'passed', ms: Math.round(performance.now() - t0) });
    console.error(`[smoke] ${name}: passed`);
    return value;
  } catch (err) {
    failed = true;
    const detail = err instanceof Error ? err.message : String(err);
    steps.push({ name, status: 'failed', ms: Math.round(performance.now() - t0), detail });
    console.error(`[smoke] ${name}: failed: ${detail}`);
    return null;
  }
}

function check(ok: boolean, message: string): void {
  if (!ok) {
    throw new Error(message);
  }
}

async function ready(h: Harness, hangar: ReturnType<Harness['client']>['hangar']): Promise<void> {
  for (let i = 0; i < 1200; i++) {
    if ((await hangar.devices()).some((d) => d.state === 'ready')) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`no device was ready after 120 s (${h.agent.maxDevices} allowed)`);
}

let runtime = 'unknown';
const held: { harness: Harness | null } = { harness: null };
try {
  const h = await step('boot', async () => {
    const harness = await start(1, process.env.HANGAR_SMOKE_LOG ? (l) => console.error(`[agent] ${l}`) : () => {});
    held.harness = harness;
    await ready(harness, harness.client('boot').hangar);
    return harness;
  });
  if (h) {
    const { hangar, token } = h.client('smoke');
    const lease: Lease | null = await step('clone', () => hangar.lease({}, { autoRenew: true }));
    runtime = lease?.info.device?.os ?? runtime;
    if (lease) {
      await step('capture', async () => {
        const png = await lease.screenshot();
        check(png.subarray(1, 4).toString() === 'PNG', 'the screenshot is not a PNG');
      });
      await step('tree', async () => {
        await lease.launch('com.apple.Preferences');
        await sleep(2000);
        const ui = await lease.ui();
        check(ui.nodes.length > 5, `the tree has only ${ui.nodes.length} nodes`);
      });
      await step('tap', async () => {
        const before = await lease.ui();
        const target = before.nodes.find((n) => n.role.toLowerCase().includes('button') && n.enabled && n.label && n.normalized.y > 0.2 && n.normalized.y < 0.8);
        check(Boolean(target?.label), 'no button with a label in the middle of the Settings screen');
        await lease.tap({ label: target?.label ?? '', exact: true });
        await sleep(1500);
        const after = await lease.ui();
        const labels = (nodes: { label: string | null }[]): string => nodes.map((n) => n.label ?? '').join('\n');
        check(labels(after.nodes) !== labels(before.nodes), `tapping "${target?.label}" did not change the screen`);
      });
      // Records a few seconds of Settings opening, and checks the MP4 has a video track.
      const recorded = async (): Promise<void> => {
        const started = await lease.record();
        await sleep(1000);
        await lease.terminate('com.apple.Preferences');
        await sleep(1000);
        await lease.launch('com.apple.Preferences');
        await sleep(2000);
        await lease.stopRecording();
        let rec = await hangar.recording(started.id);
        for (let i = 0; i < 300 && rec.state !== 'ready' && rec.state !== 'failed'; i++) {
          await sleep(100);
          rec = await hangar.recording(started.id);
        }
        check(rec.state === 'ready', `the recording is ${rec.state}: ${rec.error ?? 'no error'}`);
        const res = await fetch(new URL(rec.files.video, h.broker.url), { headers: { authorization: `Bearer ${token}` } });
        check(res.ok, `the video download failed (${res.status})`);
        const types = mp4Boxes(Buffer.from(await res.arrayBuffer()));
        check(types[0] === 'ftyp' && types.includes('mdat') && types.includes('moov'), `the video is not a whole MP4 (boxes: ${types.join(', ') || 'none'})`);
      };
      await step('record', recorded);
      await step('record on idb', async () => {
        process.env.HANGAR_CAPTURE = 'idb';
        try {
          await recorded();
        } finally {
          delete process.env.HANGAR_CAPTURE;
        }
      });
      await step('wipe', async () => {
        await lease.release();
        await ready(h, hangar);
      });
    }

    const maestro = await run('maestro', ['--version']).then(() => true, () => false);
    const app = process.env.HANGAR_SMOKE_APP;
    if (!maestro || !app) {
      steps.push({ name: 'maestro', status: 'skipped', ms: 0, detail: maestro ? 'set HANGAR_SMOKE_APP to a built examples/hello .app' : 'maestro is not installed' });
    } else {
      await step('maestro', async () => {
        const result = await runMaestro(hangar, { app, flowsDir, retries: 0 });
        const passed = result.flows.filter((f) => f.status === 'passed').length;
        check(result.passed && passed === 2, `${passed} of ${result.flows.length} flows passed (${result.url})`);
      });
      await step('wipe after maestro', () => ready(h, hangar));
    }
  }
} finally {
  await held.harness?.stop();
  await removeOwn();
}

function mp4Boxes(data: Buffer): string[] {
  const types: string[] = [];
  let at = 0;
  while (at + 8 <= data.length) {
    const size = data.readUInt32BE(at) === 1 && at + 16 <= data.length ? Number(data.readBigUInt64BE(at + 8)) : data.readUInt32BE(at);
    if (size < 8) {
      break;
    }
    types.push(data.toString('latin1', at + 4, at + 8));
    at += size;
  }
  return types;
}

async function removeOwn(): Promise<void> {
  const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', '-j']).catch(() => ({ stdout: '{}' }));
  const parsed: unknown = JSON.parse(stdout);
  const groups = typeof parsed === 'object' && parsed !== null && 'devices' in parsed && typeof parsed.devices === 'object' && parsed.devices !== null ? Object.values(parsed.devices) : [];
  for (const d of groups.flat()) {
    if (typeof d === 'object' && d !== null && 'name' in d && 'udid' in d && typeof d.name === 'string' && typeof d.udid === 'string' && d.name.startsWith(prefix)) {
      await run('xcrun', ['simctl', 'shutdown', d.udid]).catch(() => {});
      await run('xcrun', ['simctl', 'delete', d.udid]).catch((err: Error) => console.error(`[smoke] could not delete ${d.name}: ${err.message}`));
    }
  }
}

const entry: SmokeEntry = {
  xcode: xcode.version,
  build: xcode.build,
  runtime,
  passed: !failed,
  date: new Date().toISOString().slice(0, 10),
  steps,
};
await recordSmoke(entry);
console.log(JSON.stringify(entry, null, 2));
console.error(`[smoke] Xcode ${xcode.version} (${xcode.build}) on ${runtime}: ${failed ? 'FAILED' : 'passed'}. Written to ${versionsFile()}`);
process.exitCode = failed ? 1 : 0;
