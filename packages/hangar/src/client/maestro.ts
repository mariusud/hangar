import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { DeviceClass } from '@hangar/protocol';
import { Hangar, HangarError } from './index.ts';

const run = promisify(execFile);

/** The result of one flow or test. */
export type FlowResult = {
  flow: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'flaky';
  shard: number;
  attempts: number;
  message?: string;
  recording?: string;
  /** The first attempt's failure, kept when a retry or rerun passes. */
  firstMessage?: string;
  firstRecording?: string;
  /** The device this flow failed on, kept as it was until `until` (runs started with a hold). */
  held?: { until: number };
};

/** The broker's record of a run. */
export type RunInfo = {
  id: string;
  kind?: 'maestro' | 'xcuitest' | 'espresso';
  state: 'running' | 'passed' | 'failed' | 'cancelled';
  flows: FlowResult[];
  error: string | null;
  durationMs: number;
  url: string;
};

/** The outcome of a finished run. */
export type MaestroRun = { id: string; kind?: RunInfo['kind']; passed: boolean; flows: FlowResult[]; junit: string; durationMs: number; url: string };

/** Options for a Maestro run. */
export type MaestroOptions = {
  app: string;
  flowsDir: string;
  shards?: number;
  retries?: number;
  env?: Record<string, string>;
  device?: DeviceClass;
  /** Keep a failed flow's device as it was for this many seconds, for people on your team. */
  holdSeconds?: number;
  log?: (line: string) => void;
};

/** Seconds from "30m", "2h", "90s" or a plain number of seconds; null when it is none of those. */
export function parseDuration(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/.exec(value.trim().toLowerCase());
  if (!m) {
    return null;
  }
  const n = Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] === 'm' || m[2] === 'h' ? m[2] : 's'];
  return n > 0 ? Math.round(n) : null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Uploads a path as a build and returns its hash; anything else is already a build name. */
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

/** Runs Maestro flows on leased devices and follows the run until it ends. */
export async function runMaestro(hangar: Hangar, opts: MaestroOptions): Promise<MaestroRun> {
  const log = opts.log ?? (() => {});
  const flows = (await readdir(opts.flowsDir)).filter((f) => /\.ya?ml$/.test(f) && !/^config\.ya?ml$/.test(f)).sort();
  if (!flows.length) {
    throw new HangarError(0, 'NO_FLOWS', `No flow files (.yaml) in ${opts.flowsDir}.`);
  }
  const archive = (await run('tar', ['-cf', '-', '-C', opts.flowsDir, '.'], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 })).stdout.toString('base64');
  const build = await buildRef(hangar, opts.app);
  return follow(hangar, log, '/v1/runs', {
    build,
    suite: { kind: 'maestro', archive, flows },
    class: opts.device ?? {},
    shards: opts.shards ?? 1,
    retries: opts.retries ?? 1,
    env: opts.env ?? {},
    ...(opts.holdSeconds ? { holdSeconds: opts.holdSeconds } : {}),
  });
}

/** Options for an XCUITest run. */
export type XcuitestOptions = {
  products: string;
  tests?: string[];
  shards?: number;
  retries?: number;
  device?: DeviceClass;
  log?: (line: string) => void;
};

/** Lists the test targets an .xctestrun names. */
export async function testTargets(xctestrun: string): Promise<string[]> {
  const { stdout } = await run('plutil', ['-convert', 'json', '-o', '-', xctestrun]);
  const plist: Record<string, unknown> & { TestConfigurations?: { TestTargets?: { BlueprintName?: string }[] }[] } = JSON.parse(stdout);
  const names = plist.TestConfigurations
    ? plist.TestConfigurations.flatMap((c) => (c.TestTargets ?? []).map((t) => t.BlueprintName ?? ''))
    : Object.keys(plist).filter((k) => !k.startsWith('__'));
  return [...new Set(names.filter(Boolean))].sort();
}

/** Runs XCUITest from build-for-testing on leased devices. */
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
  return follow(hangar, log, '/v1/runs', { build, suite: { kind: 'xcuitest', tests }, class: opts.device ?? {}, shards: opts.shards ?? 1, retries: opts.retries ?? 1 });
}

/** Options for an Espresso run. */
export type EspressoOptions = {
  app: string;
  testApp: string;
  tests?: string[];
  shards?: number;
  retries?: number;
  log?: (line: string) => void;
};

/** Runs an Espresso suite on leased emulators. */
export async function runEspresso(hangar: Hangar, opts: EspressoOptions): Promise<MaestroRun> {
  const log = opts.log ?? (() => {});
  const build = await buildRef(hangar, opts.app);
  const testBuild = await buildRef(hangar, opts.testApp);
  const tests = opts.tests?.length ? opts.tests : ['all'];
  return follow(hangar, log, '/v1/runs', { build, suite: { kind: 'espresso', testBuild, tests }, shards: opts.shards ?? 1, retries: opts.retries ?? 1 });
}

/** Runs one flow of a finished run again on a fresh device, recorded, and follows the run until it ends. */
export async function rerunFlow(hangar: Hangar, runId: string, flow: string, opts: { env?: Record<string, string>; log?: (line: string) => void } = {}): Promise<MaestroRun> {
  const path = `/v1/runs/${encodeURIComponent(runId)}/flows/${encodeURIComponent(flow)}/rerun`;
  return follow(hangar, opts.log ?? (() => {}), path, opts.env ? { env: opts.env } : {});
}

async function follow(hangar: Hangar, log: (line: string) => void, path: string, request: unknown): Promise<MaestroRun> {
  let info = await hangar.json<RunInfo>('POST', path, request);
  log(`run ${info.url}`);

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
  return { id: info.id, ...(info.kind ? { kind: info.kind } : {}), passed: info.state === 'passed', flows: info.flows, junit, durationMs: info.durationMs, url: info.url };
}
