// Maestro runs: a suite sharded over fresh devices, coordinated here so a run outlives the client
// that started it and shows in the console.
//
// Each shard leases a device, installs the build and runs its flows in one Maestro call. A failed
// flow is retried on its own on the same device, recorded, so failed and flaky flows have a video
// and flows that pass the first time cost no recording. A run holds its leases like any client,
// so the queue and quotas apply.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { DeviceClass, MaestroResult, TestCase, TestResult } from '@hangar/protocol';
import * as auth from './auth.ts';
import type { Db } from './db.ts';
import { ApiError, type Leases } from './leases/service.ts';
import type { Recordings } from './recordings.ts';

// One shardable unit of a suite: a Maestro flow file, or an XCUITest target, class or method.
export type FlowResult = {
  flow: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'flaky';
  shard: number;
  attempts: number;
  // How long its first attempt took, when the runner reports it. Used to balance later runs.
  seconds?: number;
  message?: string;
  // The recording of the retry. For a flaky flow it shows the run that passed; the first,
  // failed run is in the Maestro log.
  recording?: string;
};

export type Run = {
  id: string;
  accountId: string;
  state: 'running' | 'passed' | 'failed' | 'cancelled';
  build: string;
  // Runs saved before XCUITest have none; they were Maestro.
  kind?: 'maestro' | 'xcuitest' | 'espresso';
  shards: number;
  retries: number;
  class: DeviceClass;
  flows: FlowResult[];
  leaseIds: string[];
  error: string | null;
  createdAt: number;
  endedAt: number | null;
};

export type RunRequest = {
  build?: string;
  // maestro: `archive` (a base64 tar of the flows folder) and `flows` in it; the app is `build`.
  // xcuitest: `build` is the archived products of build-for-testing, which hold the app too,
  // and `tests` are -only-testing names (Target, Target/Class).
  // espresso: `build` is the app's .apk, `testBuild` its test .apk, and `tests` are class names,
  // or ["all"] for the whole suite on one device.
  suite?: { kind?: string; archive?: string; flows?: string[]; tests?: string[]; testBuild?: string };
  class?: DeviceClass;
  shards?: number;
  retries?: number;
  env?: Record<string, string>;
};

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

// Seconds per Maestro test case, by name, from the JUnit report.
export function caseSeconds(junit: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of junit.matchAll(/<testcase\b([^>]*?)\/?>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[1] ?? '')?.[1];
    const time = Number(/\btime="([^"]*)"/.exec(m[1] ?? '')?.[1]);
    if (name && Number.isFinite(time)) {
      out.set(name, time);
    }
  }
  return out;
}

// Longest first, each to the shard with the least work so far. An item never timed counts as
// the average of those that were, so a new test does not all land on one shard.
export function assignShards(items: string[], shards: number, past: Map<string, number>): number[] {
  const known = items.map((i) => past.get(i)).filter((t): t is number => t !== undefined);
  const guess = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const cost = (i: string): number => past.get(i) ?? guess;
  const load = Array.from({ length: shards }, () => 0);
  const out = items.map(() => 0);
  const order = items.map((item, index) => ({ item, index })).sort((a, b) => cost(b.item) - cost(a.item) || a.index - b.index);
  for (const { item, index } of order) {
    const shard = load.indexOf(Math.min(...load));
    out[index] = shard;
    load[shard] = (load[shard] ?? 0) + cost(item);
  }
  return out;
}

export type TestHistory = { test: string; kind: string; runs: number; passed: number; flaky: number; failed: number; lastStatus: string; lastRunAt: number };

// Per test, over the runs given (newest first): how often it passed, failed, or passed only when
// retried. Sorted by flaky plus failed, most first, so the tests to look at come first.
export function testHistory(runs: Run[]): TestHistory[] {
  const rows = new Map<string, TestHistory>();
  for (const run of runs) {
    if (run.state === 'running') {
      continue;
    }
    for (const f of run.flows) {
      if (f.status !== 'passed' && f.status !== 'failed' && f.status !== 'flaky') {
        continue;
      }
      const kind = run.kind ?? 'maestro';
      const key = `${kind}:${f.flow}`;
      const row = rows.get(key) ?? { test: f.flow, kind, runs: 0, passed: 0, flaky: 0, failed: 0, lastStatus: f.status, lastRunAt: run.createdAt };
      row.runs += 1;
      row[f.status] += 1;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.flaky + b.failed - (a.flaky + a.failed) || a.test.localeCompare(b.test));
}

// Seconds per item, adding up the cases each item covers.
function sumSeconds(items: string[], cases: TestCase[], of: (item: string, c: TestCase) => boolean): Map<string, number> {
  return new Map(items.flatMap((item) => {
    const mine = cases.filter((c) => of(item, c));
    return mine.length ? [[item, mine.reduce((sum, c) => sum + c.seconds, 0)]] : [];
  }));
}

const flowName = (f: string): string => f.replace(/^.*\//, '').replace(/\.ya?ml$/, '');

function escapeXml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
}

export function junit(run: Run): string {
  const failures = run.flows.filter((f) => f.status === 'failed').length;
  const time = (((run.endedAt ?? Date.now()) - run.createdAt) / 1000).toFixed(1);
  const cases = run.flows
    .map((f) => {
      const props = `<properties><property name="shard" value="${f.shard + 1}"/><property name="attempts" value="${f.attempts}"/>${f.status === 'flaky' ? '<property name="flaky" value="true"/>' : ''}${f.recording ? `<property name="recording" value="${escapeXml(f.recording)}"/>` : ''}</properties>`;
      const failure = f.status === 'failed' ? `<failure message="${escapeXml(f.message ?? 'failed')}"/>` : '';
      const name = run.kind === 'xcuitest' || run.kind === 'espresso' ? f.flow : flowName(f.flow);
      return `    <testcase classname="${run.kind ?? 'maestro'}" name="${escapeXml(name)}">${props}${failure}</testcase>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="${run.kind ?? 'maestro'}" tests="${run.flows.length}" failures="${failures}" time="${time}">\n${cases}\n  </testsuite>\n</testsuites>\n`;
}

type Suite = { sha256: string; testSha256: string; archive: string; env: Record<string, string> };

export class Runs {
  // Emits the run id with the run after every change.
  readonly events = new EventEmitter();
  private db: Db;
  private leases: Leases;
  private recordings: Recordings;
  private internalUrl: () => string;
  private publicUrl: () => string;

  constructor(db: Db, leases: Leases, recordings: Recordings, internalUrl: () => string, publicUrl: () => string) {
    this.db = db;
    this.leases = leases;
    this.recordings = recordings;
    this.internalUrl = internalUrl;
    this.publicUrl = publicUrl;
    this.events.setMaxListeners(0);
    // A run's coordinator lives in this process, so a run that was going when Hangar stopped
    // cannot finish. Its leases end on their own when they expire.
    for (const run of db.recentRuns(1000).filter((r) => r.state === 'running')) {
      this.save({ ...run, state: 'failed', error: 'Hangar restarted during the run.', endedAt: Date.now() });
    }
  }

  start(p: auth.Principal, req: RunRequest): Run {
    const kind = req.suite?.kind;
    if (kind !== 'maestro' && kind !== 'xcuitest' && kind !== 'espresso') {
      throw new ApiError(400, 'BAD_SUITE', 'Send `suite.kind`: "maestro" with `archive` and `flows`, "xcuitest" with `tests`, or "espresso" with `testBuild` and `tests`.');
    }
    const flows = kind === 'maestro' ? (req.suite?.flows ?? []).map(String).filter((f) => /\.ya?ml$/.test(f)).sort() : (req.suite?.tests ?? []).map(String).sort();
    if (kind === 'maestro' && (!req.suite?.archive || flows.length === 0)) {
      throw new ApiError(400, 'BAD_FLOWS', 'Send `suite.archive` (a base64 tar of the flows folder) and `suite.flows` (the flow files inside it).');
    }
    if (kind === 'xcuitest' && (flows.length === 0 || flows.some((t) => !/^\w+(\/\w+){0,2}$/.test(t)))) {
      throw new ApiError(400, 'BAD_TESTS', 'Send `suite.tests`: test targets or classes as -only-testing names, such as AppUITests/LoginTests.');
    }
    if (kind === 'espresso' && (flows.length === 0 || flows.some((t) => t !== 'all' && !/^[A-Za-z_][\w$]*(\.[A-Za-z_][\w$]*)+(#\w+)?$/.test(t)))) {
      throw new ApiError(400, 'BAD_TESTS', 'Send `suite.tests`: test classes such as com.example.LoginTest, or ["all"].');
    }
    const build = req.build ? this.db.getBuild(req.build) : null;
    if (!build) {
      throw new ApiError(404, 'BUILD_NOT_FOUND', `No build called ${req.build ?? '(none)'}.`, 'Upload one with POST /v1/builds, or list them at GET /v1/builds.');
    }
    const testBuild = kind === 'espresso' ? this.db.getBuild(req.suite?.testBuild ?? '') : null;
    if (kind === 'espresso' && !testBuild) {
      throw new ApiError(404, 'BUILD_NOT_FOUND', `No test build called ${req.suite?.testBuild ?? '(none)'}.`, 'Upload the test .apk with POST /v1/builds and name it in `suite.testBuild`.');
    }
    const shards = Math.max(1, Math.min(Math.floor(Number(req.shards ?? 1)) || 1, flows.length));
    const assigned = assignShards(flows, shards, this.pastSeconds(kind));
    const run: Run = {
      id: randomUUID(),
      accountId: p.accountId,
      state: 'running',
      build: build.name,
      kind,
      shards,
      retries: Math.max(0, Math.min(Math.floor(Number(req.retries ?? 1)) || 0, 3)),
      // XCUITest needs a simulator and Espresso an emulator, whatever else the class says.
      class: { ...req.class, ...(kind === 'xcuitest' ? { platform: 'ios-simulator' } : kind === 'espresso' ? { platform: 'android-emulator' } : {}) },
      flows: flows.map((flow, i): FlowResult => ({ flow, status: 'queued', shard: assigned[i] ?? 0, attempts: 0 })),
      leaseIds: [],
      error: null,
      createdAt: Date.now(),
      endedAt: null,
    };
    this.save(run);
    this.db.audit('run.start', p.accountId, null);
    void this.coordinate(p, run.id, { sha256: build.sha256, testSha256: testBuild?.sha256 ?? '', archive: req.suite?.archive ?? '', env: req.env ?? {} });
    return run;
  }

  // Runs are the team's, like recordings: a failing run is for everyone to look at.
  get(id: string): Run {
    const run = this.db.getRun(id);
    if (!run) {
      throw new ApiError(404, 'RUN_NOT_FOUND', `No run ${id}.`);
    }
    return run;
  }

  list(): Run[] {
    return this.db.recentRuns();
  }

  // The latest timing of each test in the last 50 runs of this kind.
  private pastSeconds(kind: Run['kind']): Map<string, number> {
    const out = new Map<string, number>();
    for (const run of this.db.recentRuns(50)) {
      if ((run.kind ?? 'maestro') !== kind) {
        continue;
      }
      for (const f of run.flows) {
        if (f.seconds !== undefined && !out.has(f.flow)) {
          out.set(f.flow, f.seconds);
        }
      }
    }
    return out;
  }

  cancel(p: auth.Principal, id: string): Run {
    const run = this.get(id);
    if (run.accountId !== p.accountId && p.role !== 'operator') {
      throw new ApiError(403, 'FORBIDDEN', 'Only the person who started a run, or an operator, can cancel it.');
    }
    if (run.state !== 'running') {
      return run;
    }
    const cancelled = this.save({ ...run, state: 'cancelled', endedAt: Date.now() });
    for (const leaseId of run.leaseIds) {
      try {
        this.leases.release(p.role === 'operator' ? p : this.owner(run), leaseId);
      } catch {
        // Already ended.
      }
    }
    return cancelled;
  }

  view(run: Run): unknown {
    const count = (s: FlowResult['status']): number => run.flows.filter((f) => f.status === s).length;
    return {
      ...run,
      owner: this.db.getAccount(run.accountId)?.name ?? 'unknown',
      counts: { passed: count('passed'), flaky: count('flaky'), failed: count('failed'), pending: count('queued') + count('running') },
      durationMs: (run.endedAt ?? Date.now()) - run.createdAt,
      url: `${this.publicUrl()}/runs/${run.id}`,
      junit: `/v1/runs/${run.id}/junit.xml`,
    };
  }

  private owner(run: Run): auth.Principal {
    return { accountId: run.accountId, name: '', role: 'member', scopes: [] };
  }

  private save(run: Run): Run {
    this.db.saveRun(run);
    this.events.emit(run.id, run);
    this.events.emit('any', run);
    return run;
  }

  // Changes one run in place. The coordinator's shards update the same run concurrently, so each
  // change reads the latest copy first.
  private update(id: string, change: (run: Run) => Partial<Run>): Run {
    const run = this.db.getRun(id)!;
    return this.save({ ...run, ...change(run) });
  }

  private setFlow(id: string, flow: string, fields: Partial<FlowResult>): void {
    this.update(id, (run) => ({ flows: run.flows.map((f) => (f.flow === flow ? { ...f, ...fields } : f)) }));
  }

  private cancelled(id: string): boolean {
    return this.db.getRun(id)?.state !== 'running';
  }

  private async coordinate(p: auth.Principal, id: string, suite: Suite): Promise<void> {
    const run = this.db.getRun(id)!;
    const shards = Array.from({ length: run.shards }, (_, s) => run.flows.filter((f) => f.shard === s).map((f) => f.flow));
    try {
      await Promise.all(shards.map((flows, shard) => this.shard(p, id, shard, flows, suite)));
      this.update(id, (r) => (r.state === 'running' ? { state: r.flows.some((f) => f.status === 'failed') ? 'failed' : 'passed', endedAt: Date.now() } : {}));
    } catch (err) {
      this.update(id, (r) => (r.state === 'running' ? { state: 'failed', error: (err as Error).message, endedAt: Date.now() } : {}));
    }
    this.db.audit('run.end', p.accountId, null);
  }

  private async shard(p: auth.Principal, id: string, shard: number, flows: string[], suite: Suite): Promise<void> {
    const { sha256, archive, env } = suite;
    const run = this.db.getRun(id)!;
    const lease = this.leases.create(p, run.class, { via: `${run.kind ?? 'maestro'} run ${id.slice(0, 6)}, shard ${shard + 1} of ${run.shards}` });
    this.update(id, (r) => ({ leaseIds: [...r.leaseIds, lease.id] }));
    // Maestro calls can take minutes; the run renews its leases like a client would.
    const renew = setInterval(() => {
      try {
        this.leases.renew(p, lease.id);
      } catch {
        // Ended; the next op fails and says why.
      }
    }, 60_000);
    try {
      await this.active(lease.id);
      if (this.cancelled(id)) {
        return;
      }
      const artifactUrl = (sha = sha256): string => `${this.internalUrl()}/v1/artifacts/${sha}?t=${auth.mintToken(this.db, 'artifact', { expiresAt: Date.now() + 10 * 60_000 })}`;
      const kind = this.db.getRun(id)!.kind ?? 'maestro';
      const lastLines = (log: string): string => log.split('\n').filter(Boolean).slice(-3).join(' ');
      // Runs some of the shard's items and says which failed, with a line to show for them.
      let exec: (only: string[]) => Promise<{ failed: string[]; message: string; seconds: Map<string, number> }>;
      if (kind === 'maestro') {
        await this.leases.op(p, lease.id, { op: 'install', artifactUrl: artifactUrl(), sha256 });
        exec = async (only) => {
          const r = (await this.leases.op(p, lease.id, { op: 'maestro', archive, flows: only, env })).result as MaestroResult;
          // Without a report Maestro failed before running flows; count them all as failed.
          const failed = failedCases(r.junit);
          const times = caseSeconds(r.junit);
          const seconds = new Map(only.flatMap((f) => (times.has(flowName(f)) ? [[f, times.get(flowName(f)) ?? 0]] : [])));
          return { failed: only.filter((f) => (r.junit ? failed.has(flowName(f)) : !r.passed)), message: lastLines(r.log), seconds };
        };
      } else if (kind === 'espresso') {
        // Installed with every call: a fresh device per shard, and the retry reuses it.
        exec = async (only) => {
          const tests = only.includes('all') ? [] : only;
          const r = (await this.leases.op(p, lease.id, { op: 'espresso', app: { url: artifactUrl(), sha256 }, testApp: { url: artifactUrl(suite.testSha256), sha256: suite.testSha256 }, tests })).result as TestResult;
          const bad = r.cases.filter((c) => c.status === 'failed');
          const of = (t: string, c: TestCase): boolean => t === 'all' || t === c.className || t === `${c.className}#${c.name}`;
          const failed = only.filter((t) => (r.cases.length ? bad.some((c) => of(t, c)) : !r.passed));
          return { failed, message: bad.map((c) => `${c.className.split('.').pop()}.${c.name}: ${c.message ?? 'failed'}`).join(' ') || lastLines(r.log), seconds: sumSeconds(only, r.cases, of) };
        };
      } else {
        // xcodebuild installs the app from the products itself.
        exec = async (only) => {
          const r = (await this.leases.op(p, lease.id, { op: 'xcuitest', artifactUrl: artifactUrl(), sha256, tests: only })).result as TestResult;
          const bad = r.cases.filter((c) => c.status === 'failed');
          const of = (t: string, c: TestCase): boolean => `${c.target}/${c.className}/${c.name}`.startsWith(t);
          const failed = only.filter((t) => (r.cases.length ? bad.some((c) => of(t, c)) : !r.passed));
          return { failed, message: bad.map((c) => `${c.className}.${c.name}: ${c.message ?? 'failed'}`).join(' ') || lastLines(r.log), seconds: sumSeconds(only, r.cases, of) };
        };
      }

      for (const f of flows) {
        this.setFlow(id, f, { status: 'running', attempts: 1 });
      }
      const first = await exec(flows);
      const failedFirst = first.failed;
      for (const f of flows) {
        const failed = failedFirst.includes(f);
        const seconds = first.seconds.get(f);
        this.setFlow(id, f, { status: failed ? 'failed' : 'passed', ...(failed ? { message: first.message } : {}), ...(seconds !== undefined ? { seconds } : {}) });
      }
      const retries = this.db.getRun(id)!.retries;
      for (const f of failedFirst) {
        for (let attempt = 2; attempt <= retries + 1 && !this.cancelled(id); attempt++) {
          this.setFlow(id, f, { status: 'running', attempts: attempt });
          const rec = await this.recordings.start(p, lease.id).catch(() => null);
          let r: { failed: string[]; message: string; seconds: Map<string, number> };
          let saved: string | undefined;
          try {
            r = await exec([f]);
          } finally {
            saved = rec ? await this.recordings.stop(p, lease.id).then((x) => `${this.publicUrl()}/recordings/${x.id}`, () => undefined) : undefined;
          }
          const ok = r.failed.length === 0;
          this.setFlow(id, f, { status: ok ? 'flaky' : 'failed', ...(ok ? { message: undefined } : { message: r.message }), ...(saved ? { recording: saved } : {}) });
          if (ok) {
            break;
          }
        }
      }
    } catch (err) {
      if (this.cancelled(id)) {
        return;
      }
      const message = (err as Error).message;
      for (const f of flows) {
        this.setFlow(id, f, { status: 'failed', message });
      }
    } finally {
      clearInterval(renew);
      try {
        this.leases.release(p, lease.id);
      } catch {
        // Already ended.
      }
    }
  }

  // Resolves when the lease is active, throws when it ends first.
  private active(leaseId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = (l: { state: string; reason?: string | null }): boolean => {
        if (l.state === 'active') {
          resolve();
        } else if (l.state === 'ended') {
          reject(new ApiError(409, 'LEASE_ENDED', `The run's lease ended before it started (${l.reason ?? 'ended'}).`));
        } else {
          return false;
        }
        this.leases.events.off(leaseId, check);
        return true;
      };
      this.leases.events.on(leaseId, check);
      const current = this.db.getLease(leaseId);
      if (current) {
        check(current);
      }
    });
  }
}
