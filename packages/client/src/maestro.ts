// Maestro suites sharded over leased devices: one fresh device per shard, failed flows retried
// once on the same device, results merged into one JUnit report.

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { promisify } from 'node:util';
import type { DeviceClass, MaestroResult } from '@hangar/protocol';
import { Hangar, HangarError, type Lease } from './index.ts';

const run = promisify(execFile);

export type FlowResult = { flow: string; status: 'passed' | 'failed' | 'flaky'; shard: number; attempts: number; message?: string };

export type MaestroRun = { passed: boolean; flows: FlowResult[]; junit: string; durationMs: number };

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

async function flowFiles(dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f) && !/^config\.ya?ml$/.test(f)).sort();
  if (!files.length) {
    throw new HangarError(0, 'NO_FLOWS', `No flow files (.yaml) in ${dir}.`);
  }
  return files;
}

// Maestro names a test case after the flow's `name:` or its file name; JUnit marks failures.
export function failedCases(junit: string): Set<string> {
  const failed = new Set<string>();
  for (const m of junit.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = /\bname="([^"]*)"/.exec(m[1] ?? '')?.[1];
    if (name && /<(failure|error)\b/.test(m[3] ?? '')) {
      failed.add(name);
    }
  }
  return failed;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
}

export async function runMaestro(hangar: Hangar, opts: MaestroOptions): Promise<MaestroRun> {
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const files = await flowFiles(opts.flowsDir);
  const archive = (await run('tar', ['-cf', '-', '-C', opts.flowsDir, '.'], { encoding: 'buffer', maxBuffer: 10 * 1024 * 1024 })).stdout.toString('base64');
  const shards = Math.max(1, Math.min(opts.shards ?? 1, files.length));
  const groups = Array.from({ length: shards }, (_, i) => files.filter((_, j) => j % shards === i));
  const retries = opts.retries ?? 1;

  const results = await Promise.all(
    groups.map(async (group, shard): Promise<FlowResult[]> => {
      const lease: Lease = await hangar.lease(opts.device ?? {});
      try {
        log(`shard ${shard + 1}: ${lease.info.device?.model ?? 'device'} leased, installing`);
        await lease.install(opts.app);
        const outcome = new Map<string, FlowResult>();
        let pending = group;
        for (let attempt = 1; attempt <= retries + 1 && pending.length; attempt++) {
          log(`shard ${shard + 1}: running ${pending.length} flow(s)${attempt > 1 ? `, retry ${attempt - 1}` : ''}`);
          const r = await hangar.json<MaestroResult>('POST', `/v1/leases/${encodeURIComponent(lease.id)}/maestro`, { archive, flows: pending, env: opts.env ?? {} });
          const failed = failedCases(r.junit);
          // Without a report Maestro failed before running flows; count them all as failed.
          const failedFiles = pending.filter((f) => (r.junit ? failed.has(basename(f, extname(f))) : !r.passed));
          for (const f of pending) {
            const ok = !failedFiles.includes(f);
            outcome.set(f, { flow: f, shard, attempts: attempt, status: ok ? (attempt > 1 ? 'flaky' : 'passed') : 'failed', ...(ok ? {} : { message: r.log.split('\n').filter(Boolean).slice(-3).join(' ') }) });
          }
          pending = failedFiles;
        }
        return [...outcome.values()];
      } finally {
        await lease.release().catch(() => {});
      }
    }),
  );

  const flows = results.flat().sort((a, b) => a.flow.localeCompare(b.flow));
  const failures = flows.filter((f) => f.status === 'failed').length;
  const cases = flows
    .map((f) => {
      const props = `<properties><property name="shard" value="${f.shard + 1}"/><property name="attempts" value="${f.attempts}"/>${f.status === 'flaky' ? '<property name="flaky" value="true"/>' : ''}</properties>`;
      const failure = f.status === 'failed' ? `<failure message="${escapeXml(f.message ?? 'failed')}"/>` : '';
      return `    <testcase classname="maestro" name="${escapeXml(basename(f.flow, extname(f.flow)))}">${props}${failure}</testcase>`;
    })
    .join('\n');
  const durationMs = Date.now() - started;
  const junit = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="maestro" tests="${flows.length}" failures="${failures}" time="${(durationMs / 1000).toFixed(1)}">\n${cases}\n  </testsuite>\n</testsuites>\n`;
  return { passed: failures === 0, flows, junit, durationMs };
}
