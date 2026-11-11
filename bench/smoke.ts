// Checks that this Mac's Xcode works with Hangar, and writes the result to hosts/versions.json
// (or HANGAR_VERSIONS). It boots and clones real simulators. Run it on each new Xcode:
//   pnpm bench:smoke
// Set HANGAR_SMOKE_APP to a built examples/hello .app to also run its two Maestro flows.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runMaestro, type Lease } from 'hangar';
import { currentXcode, recordSmoke, versionsFile, type SmokeEntry, type SmokeStep } from '../packages/hangar/src/versions.ts';
import { start, type Harness } from '../e2e/harness.ts';

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
    const harness = await start(1, () => {});
    held.harness = harness;
    await ready(harness, harness.client('boot').hangar);
    return harness;
  });
  if (h) {
    const { hangar } = h.client('smoke');
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
