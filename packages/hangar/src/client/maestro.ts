// Test suites as broker runs: Maestro flows, or XCUITest from build-for-testing. Uploads what
// the run needs, starts it and follows it until it ends. The broker leases one fresh device per
// shard, retries failures once recorded, and merges JUnit; see packages/broker/src/runs.ts.

import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { DeviceClass } from '@hangar/protocol';
import { Hangar, HangarError } from './index.ts';

const run = promisify(execFile);

export type FlowResult = {
  flow: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'flaky';
  shard: number;
  attempts: number;
  message?: string;
  recording?: string;
};

export type RunInfo = {
  id: string;
  state: 'running' | 'passed' | 'failed' | 'cancelled';
  flows: FlowResult[];
  error: string | null;
  durationMs: number;
  url: string;
};

export type MaestroRun = { passed: boolean; flows: FlowResult[]; junit: string; durationMs: number; url: string };

export type MaestroOptions = {
  // A built simulator .app, an archive of one, or a registered build name.
  app: string;
  // The folder with the flow files. config.yaml in it is Maestro's own settings, not a flow.
  flowsDir: string;
  shards?: number;
  retries?: number;
  env?: Record<string, string>;
  device?: DeviceClass;
  log?: (line: string) => void;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A path uploads the app as a build and returns its hash; anything else is a build name already.
export async function buildRef(hangar: Hangar, app: string): Promise<string> {
  const s = await stat(app).catch(() => null);
  if (!s) {
    return app;
  }
  const name = encodeURIComponent(basename(app));
  const body = s.isFile() ? createReadStream(app) : spawn('tar', ['-cf', '-', '-C', dirname(app), basename(app)], { stdio: ['ignore', 'pipe', 'inherit'] }).stdout;
  const res = await hangar.request('POST', `/v1/builds?name=${name}`, body, { 'content-type': s.isFile() ? 'application/octet-stream' : 'application/x-tar' });
  return ((await res.json()) as { sha256: string }).sha256;
}

export async function runMaestro(hangar: Hangar, opts: MaestroOptions): Promise<MaestroRun> {
  const log = opts.log ?? (() => {});
  const flows = (await readdir(opts.flowsDir)).filter((f) => /\.ya?ml$/.test(f) && !/^config\.ya?ml$/.test(f)).sort();
  if (!flows.length) {
    throw new HangarError(0, 'NO_FLOWS', `No flow files (.yaml) in ${opts.flowsDir}.`);
  }
  const archive = (await run('tar', ['-cf', '-', '-C', opts.flowsDir, '.'], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 })).stdout.toString('base64');
  const build = await buildRef(hangar, opts.app);
  return follow(hangar, log, {
    build,
    suite: { kind: 'maestro', archive, flows },
    class: opts.device ?? {},
    shards: opts.shards ?? 1,
    retries: opts.retries ?? 1,
    env: opts.env ?? {},
  });
}

export type XcuitestOptions = {
  // The Build/Products folder of `xcodebuild build-for-testing`, or a zip of it.
  products: string;
  // -only-testing names to shard over. Defaults to every test target in the .xctestrun.
  tests?: string[];
  shards?: number;
  retries?: number;
  device?: DeviceClass;
  log?: (line: string) => void;
};

// The test targets an .xctestrun names. Format 2 lists them per test plan configuration; format 1
// uses them as top-level keys.
export async function testTargets(xctestrun: string): Promise<string[]> {
  const { stdout } = await run('plutil', ['-convert', 'json', '-o', '-', xctestrun]);
  const plist: Record<string, unknown> & { TestConfigurations?: { TestTargets?: { BlueprintName?: string }[] }[] } = JSON.parse(stdout);
  const names = plist.TestConfigurations
    ? plist.TestConfigurations.flatMap((c) => (c.TestTargets ?? []).map((t) => t.BlueprintName ?? ''))
    : Object.keys(plist).filter((k) => !k.startsWith('__'));
  return [...new Set(names.filter(Boolean))].sort();
}

export async function runXcuitest(hangar: Hangar, opts: XcuitestOptions): Promise<MaestroRun> {
  const log = opts.log ?? (() => {});
  let tests = opts.tests ?? [];
  if (!tests.length) {
    const isDir = (await stat(opts.products)).isDirectory();
    const xctestrun = isDir ? (await readdir(opts.products)).find((f) => f.endsWith('.xctestrun')) : undefined;
    if (!xctestrun) {
      throw new HangarError(0, 'NO_TESTS', 'Name the tests with --tests, or pass the Build/Products folder, which has the .xctestrun.');
    }
    tests = await testTargets(join(opts.products, xctestrun));
  }
  log(`uploading ${basename(opts.products)}`);
  const build = await buildRef(hangar, opts.products);
  return follow(hangar, log, { build, suite: { kind: 'xcuitest', tests }, class: opts.device ?? {}, shards: opts.shards ?? 1, retries: opts.retries ?? 1 });
}

export type EspressoOptions = {
  // The app's .apk and its test .apk from ./gradlew assembleDebug assembleDebugAndroidTest.
  app: string;
  testApp: string;
  // Classes to shard over. Without them the whole suite runs on one device.
  tests?: string[];
  shards?: number;
  retries?: number;
  log?: (line: string) => void;
};

export async function runEspresso(hangar: Hangar, opts: EspressoOptions): Promise<MaestroRun> {
  const log = opts.log ?? (() => {});
  const build = await buildRef(hangar, opts.app);
  const testBuild = await buildRef(hangar, opts.testApp);
  const tests = opts.tests?.length ? opts.tests : ['all'];
  return follow(hangar, log, { build, suite: { kind: 'espresso', testBuild, tests }, shards: opts.shards ?? 1, retries: opts.retries ?? 1 });
}

async function follow(hangar: Hangar, log: (line: string) => void, request: unknown): Promise<MaestroRun> {
  let info = await hangar.json<RunInfo>('POST', '/v1/runs', request);
  log(`run ${info.url}`);

  // Ctrl-C cancels the run, which releases its devices.
  const cancel = (): void => void hangar.request('DELETE', `/v1/runs/${info.id}`).finally(() => process.exit(130));
  process.once('SIGINT', cancel);
  try {
    const seen = new Map<string, string>();
    while (true) {
      for (const f of info.flows) {
        const key = `${f.status}/${f.attempts}`;
        if (seen.get(f.flow) !== key && f.status !== 'queued') {
          log(`shard ${f.shard + 1}: ${f.flow} ${f.status}${f.attempts > 1 ? ` (attempt ${f.attempts})` : ''}`);
        }
        seen.set(f.flow, key);
      }
      if (info.state !== 'running') {
        break;
      }
      await sleep(2000);
      info = await hangar.json<RunInfo>('GET', `/v1/runs/${info.id}`);
    }
  } finally {
    process.off('SIGINT', cancel);
  }
  if (info.error) {
    log(`run failed: ${info.error}`);
  }
  const junit = await (await hangar.request('GET', `/v1/runs/${info.id}/junit.xml`)).text();
  return { passed: info.state === 'passed', flows: info.flows, junit, durationMs: info.durationMs, url: info.url };
}
