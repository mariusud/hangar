import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { DeviceClass } from '@devicepool/protocol';
import { Devicepool, DevicepoolError } from './index.ts';
import { checkSimulatorBuild, missingFile } from './local.ts';

const run = promisify(execFile);

export type FlowResult = {
  flow: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'flaky';
  shard: number;
  attempts: number;
  message?: string;
  recording?: string;
  firstMessage?: string;
  firstRecording?: string;
  held?: { until: number };
};

export type RunInfo = {
  id: string;
  kind?: 'maestro' | 'xcuitest' | 'espresso';
  state: 'running' | 'passed' | 'failed' | 'cancelled';
  flows: FlowResult[];
  error: string | null;
  durationMs: number;
  url: string;
};

export type MaestroRun = { id: string; kind?: RunInfo['kind']; passed: boolean; flows: FlowResult[]; junit: string; durationMs: number; url: string };

export type MaestroOptions = {
  app: string;
  flowsDir: string;
  shards?: number;
  retries?: number;
  env?: Record<string, string>;
  device?: DeviceClass;
  holdSeconds?: number;
  booking?: string;
  buildName?: string;
  log?: (line: string) => void;
};

export function parseDuration(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h)?$/.exec(value.trim().toLowerCase());
  if (!m) {
    return null;
  }
  const n = Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] === 'm' || m[2] === 'h' ? m[2] : 's'];
  return n > 0 ? Math.round(n) : null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function buildRef(devicepool: Devicepool, app: string, buildName?: string): Promise<string> {
  const s = await stat(app).catch(() => null);
  if (!s) {
    const missing = missingFile(app);
    if (missing) {
      throw missing;
    }
    return app;
  }
  if (s.isDirectory()) {
    await checkSimulatorBuild(app);
  }
  const name = encodeURIComponent(buildName ?? basename(app));
  const tar = s.isFile() ? null : spawn('tar', ['-cf', '-', '-C', dirname(app), basename(app)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const body = tar ? tar.stdout : createReadStream(app);
  try {
    const res = await devicepool.request('POST', `/v1/builds?name=${name}`, body, { 'content-type': s.isFile() ? 'application/octet-stream' : 'application/x-tar' });
    const build: { sha256: string } = await res.json();
    return build.sha256;
  } finally {
    // A refused upload leaves tar blocked on a full pipe, which would keep the command from exiting.
    tar?.kill();
    body.destroy();
  }
}

export async function runMaestro(devicepool: Devicepool, opts: MaestroOptions): Promise<MaestroRun> {
  const log = opts.log ?? (() => {});
  const flows = (await readdir(opts.flowsDir)).filter((f) => /\.ya?ml$/.test(f) && !/^config\.ya?ml$/.test(f)).sort();
  if (!flows.length) {
    throw new DevicepoolError(0, 'NO_FLOWS', `No flow files (.yaml) in ${opts.flowsDir}.`);
  }
  const archive = (await run('tar', ['-cf', '-', '-C', opts.flowsDir, '.'], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 })).stdout.toString('base64');
  const build = await buildRef(devicepool, opts.app, opts.buildName);
  return follow(devicepool, log, '/v1/runs', {
    build,
    suite: { kind: 'maestro', archive, flows },
    class: opts.device ?? {},
    shards: opts.shards ?? 1,
    retries: opts.retries ?? 1,
    env: opts.env ?? {},
    ...(opts.holdSeconds ? { holdSeconds: opts.holdSeconds } : {}),
    ...(opts.booking ? { booking: opts.booking } : {}),
  });
}

export type XcuitestOptions = {
  products: string;
  tests?: string[];
  shards?: number;
  retries?: number;
  device?: DeviceClass;
  booking?: string;
  buildName?: string;
  log?: (line: string) => void;
};

export async function testTargets(xctestrun: string): Promise<string[]> {
  const { stdout } = await run('plutil', ['-convert', 'json', '-o', '-', xctestrun]);
  const plist: Record<string, unknown> & { TestConfigurations?: { TestTargets?: { BlueprintName?: string }[] }[] } = JSON.parse(stdout);
  const names = plist.TestConfigurations
    ? plist.TestConfigurations.flatMap((c) => (c.TestTargets ?? []).map((t) => t.BlueprintName ?? ''))
    : Object.keys(plist).filter((k) => !k.startsWith('__'));
  return [...new Set(names.filter(Boolean))].sort();
}

export async function runXcuitest(devicepool: Devicepool, opts: XcuitestOptions): Promise<MaestroRun> {
  const log = opts.log ?? (() => {});
  let tests = opts.tests ?? [];
  if (!tests.length) {
    const isDir = (await stat(opts.products)).isDirectory();
    const xctestrun = isDir ? (await readdir(opts.products)).find((f) => f.endsWith('.xctestrun')) : undefined;
    if (!xctestrun) {
      throw new DevicepoolError(0, 'NO_TESTS', 'Name the tests with --tests, or pass the Build/Products folder, which has the .xctestrun.');
    }
    tests = await testTargets(join(opts.products, xctestrun));
  }
  log(`uploading ${basename(opts.products)}`);
  const build = await buildRef(devicepool, opts.products, opts.buildName);
  return follow(devicepool, log, '/v1/runs', { build, suite: { kind: 'xcuitest', tests }, class: opts.device ?? {}, shards: opts.shards ?? 1, retries: opts.retries ?? 1, ...(opts.booking ? { booking: opts.booking } : {}) });
}

export type EspressoOptions = {
  app: string;
  testApp: string;
  tests?: string[];
  shards?: number;
  retries?: number;
  booking?: string;
  buildName?: string;
  log?: (line: string) => void;
};

export async function runEspresso(devicepool: Devicepool, opts: EspressoOptions): Promise<MaestroRun> {
  const log = opts.log ?? (() => {});
  const build = await buildRef(devicepool, opts.app, opts.buildName);
  const testBuild = await buildRef(devicepool, opts.testApp, opts.buildName ? `${opts.buildName}-test` : undefined);
  const tests = opts.tests?.length ? opts.tests : ['all'];
  return follow(devicepool, log, '/v1/runs', { build, suite: { kind: 'espresso', testBuild, tests }, shards: opts.shards ?? 1, retries: opts.retries ?? 1, ...(opts.booking ? { booking: opts.booking } : {}) });
}

export async function rerunFlow(devicepool: Devicepool, runId: string, flow: string, opts: { env?: Record<string, string>; log?: (line: string) => void } = {}): Promise<MaestroRun> {
  const path = `/v1/runs/${encodeURIComponent(runId)}/flows/${encodeURIComponent(flow)}/rerun`;
  return follow(devicepool, opts.log ?? (() => {}), path, opts.env ? { env: opts.env } : {});
}

async function follow(devicepool: Devicepool, log: (line: string) => void, path: string, request: unknown): Promise<MaestroRun> {
  let info = await devicepool.json<RunInfo>('POST', path, request);
  log(`run ${info.url}`);

  const cancel = (): void => void devicepool.request('DELETE', `/v1/runs/${info.id}`).finally(() => process.exit(130));
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
      info = await devicepool.json<RunInfo>('GET', `/v1/runs/${info.id}`);
    }
  } finally {
    process.off('SIGINT', cancel);
  }
  if (info.error) {
    log(`run failed: ${info.error}`);
  }
  const junit = await (await devicepool.request('GET', `/v1/runs/${info.id}/junit.xml`)).text();
  return { id: info.id, ...(info.kind ? { kind: info.kind } : {}), passed: info.state === 'passed', flows: info.flows, junit, durationMs: info.durationMs, url: info.url };
}
