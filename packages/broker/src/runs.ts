
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Booking, DeviceClass, MaestroResult, TestCase, TestResult } from '@hangar/protocol';
import * as auth from './auth.ts';
import type { Db, RunSuite } from './db.ts';
import { ApiError, type Leases } from './leases/service.ts';
import { priorityOf } from './leases/tokens.ts';
import type { Recordings } from './recordings.ts';
import { findBooking } from './leases/bookings.ts';
import { MAX_HOLD_MS, nextWindow, windowAt } from './schedule.ts';

export type FlowResult = {
  flow: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'flaky';
  shard: number;
  attempts: number;
  seconds?: number;
  message?: string;
  recording?: string;
  // The first attempt's failure, kept when a retry or a rerun passes.
  firstMessage?: string;
  firstRecording?: string;
  // The device this flow failed on, kept as it was until `until` (a run started with a hold).
  held?: { until: number };
};

export type Run = {
  id: string;
  accountId: string;
  state: 'running' | 'passed' | 'failed' | 'cancelled';
  build: string;
  kind?: 'maestro' | 'xcuitest' | 'espresso';
  shards: number;
  retries: number;
  class: DeviceClass;
  flows: FlowResult[];
  leaseIds: string[];
  error: string | null;
  createdAt: number;
  endedAt: number | null;
  // How long a shard's device is held when one of its flows fails; none is wiped as usual.
  holdMs?: number;
  // The booking whose devices the shards lease, ahead of the booking's agents. Reruns lease as usual.
  booking?: { id: string; name: string };
};

export type RunRequest = {
  build?: string;
  suite?: { kind?: string; archive?: string; flows?: string[]; tests?: string[]; testBuild?: string };
  class?: DeviceClass;
  shards?: number;
  retries?: number;
  env?: Record<string, string>;
  holdSeconds?: number;
  booking?: string;
};

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

export type TestHistory = {
  test: string;
  kind: string;
  runs: number;
  passed: number;
  flaky: number;
  failed: number;
  flakeRate: number;
  failRate: number;
  lastStatus: string;
  lastRunAt: number;
};

const rate = (n: number, of: number): number => (of ? Math.round((n / of) * 1000) / 1000 : 0);

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
      const row = rows.get(key) ?? { test: f.flow, kind, runs: 0, passed: 0, flaky: 0, failed: 0, flakeRate: 0, failRate: 0, lastStatus: f.status, lastRunAt: run.createdAt };
      row.runs += 1;
      row[f.status] += 1;
      row.flakeRate = rate(row.flaky, row.runs);
      row.failRate = rate(row.failed, row.runs);
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.flaky + b.failed - (a.flaky + a.failed) || a.test.localeCompare(b.test));
}

export type FailureGroup = {
  message: string;
  example: string;
  count: number;
  tests: string[];
  lastRunId: string;
  lastAt: number;
  recording?: string;
};

// Two failures with the same message apart from numbers, ids and timings are one group.
export function normalizeMessage(message: string): string {
  return message
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\d+(\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function failureGroups(runs: Run[]): FailureGroup[] {
  const groups = new Map<string, FailureGroup>();
  for (const run of runs) {
    if (run.state === 'running') {
      continue;
    }
    for (const f of run.flows) {
      const raw = f.status === 'failed' ? (f.message ?? f.firstMessage) : f.status === 'flaky' ? (f.firstMessage ?? f.message) : undefined;
      if (raw === undefined) {
        continue;
      }
      const message = normalizeMessage(raw) || '(no message)';
      const recording = f.status === 'failed' ? (f.recording ?? f.firstRecording) : (f.firstRecording ?? f.recording);
      const group = groups.get(message) ?? { message, example: raw, count: 0, tests: [], lastRunId: run.id, lastAt: run.createdAt };
      group.count += 1;
      if (!group.tests.includes(f.flow)) {
        group.tests.push(f.flow);
      }
      if (run.createdAt >= group.lastAt) {
        group.lastAt = run.createdAt;
        group.lastRunId = run.id;
        group.example = raw;
        if (recording) {
          group.recording = recording;
        }
      } else if (!group.recording && recording) {
        group.recording = recording;
      }
      groups.set(message, group);
    }
  }
  return [...groups.values()].map((g) => ({ ...g, tests: g.tests.sort() })).sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

// Every attempt counts: a flow that passed once and failed once is flaky.
export function combineStatus(before: FlowResult['status'], passed: boolean): 'passed' | 'failed' | 'flaky' {
  if (before === 'flaky' || (before === 'passed' && !passed) || (before === 'failed' && passed)) {
    return 'flaky';
  }
  return passed ? 'passed' : 'failed';
}

export function settledState(flows: FlowResult[], before: Run['state']): Run['state'] {
  if (flows.some((f) => f.status === 'failed')) {
    return 'failed';
  }
  if (before === 'cancelled' && flows.some((f) => f.status === 'queued' || f.status === 'running')) {
    return 'cancelled';
  }
  return 'passed';
}

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
      const props = `<properties><property name="shard" value="${f.shard + 1}"/><property name="attempts" value="${f.attempts}"/>${f.status === 'flaky' ? '<property name="flaky" value="true"/>' : ''}${f.recording ? `<property name="recording" value="${escapeXml(f.recording)}"/>` : ''}${f.firstRecording && f.firstRecording !== f.recording ? `<property name="first-recording" value="${escapeXml(f.firstRecording)}"/>` : ''}</properties>`;
      const failure = f.status === 'failed' ? `<failure message="${escapeXml(f.message ?? 'failed')}"/>` : '';
      const name = run.kind === 'xcuitest' || run.kind === 'espresso' ? f.flow : flowName(f.flow);
      return `    <testcase classname="${run.kind ?? 'maestro'}" name="${escapeXml(name)}">${props}${failure}</testcase>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="${run.kind ?? 'maestro'}" tests="${run.flows.length}" failures="${failures}" time="${time}">\n${cases}\n  </testsuite>\n</testsuites>\n`;
}

type Suite = { sha256: string; testSha256: string; archive: string; env: Record<string, string> };
type Exec = (only: string[]) => Promise<{ failed: string[]; message: string; seconds: Map<string, number> }>;
type Recorded<T> = ({ ok: true; value: T } | { ok: false; error: Error }) & { recording?: { id: string; url: string } };

export type RerunRequest = { env?: Record<string, string> };

export class Runs {
  readonly events = new EventEmitter();
  private db: Db;
  private leases: Leases;
  private recordings: Recordings;
  private internalUrl: () => string;
  private publicUrl: () => string;
  // Environment values stay in memory only; the database keeps their names.
  private envs = new Map<string, Record<string, string>>();
  // Who holds each lease a run made, so a cancel can release a rerun started by someone else.
  private holders = new Map<string, auth.Principal>();

  constructor(db: Db, leases: Leases, recordings: Recordings, internalUrl: () => string, publicUrl: () => string) {
    this.db = db;
    this.leases = leases;
    this.recordings = recordings;
    this.internalUrl = internalUrl;
    this.publicUrl = publicUrl;
    this.events.setMaxListeners(0);
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
    const holdSeconds = req.holdSeconds === undefined || req.holdSeconds === null ? 0 : Number(req.holdSeconds);
    if (!Number.isFinite(holdSeconds) || holdSeconds < 0 || holdSeconds * 1000 > MAX_HOLD_MS) {
      throw new ApiError(400, 'BAD_HOLD', `\`holdSeconds\` is how long to keep a failed flow's device, up to ${MAX_HOLD_MS / 3_600_000} hours.`);
    }
    const booking = req.booking === undefined || req.booking === '' ? null : this.bookingFor(p, String(req.booking));
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
      ...(holdSeconds > 0 ? { holdMs: Math.round(holdSeconds * 1000) } : {}),
      ...(booking ? { booking: { id: booking.id, name: booking.name } } : {}),
    };
    const env = req.env ?? {};
    const stored: RunSuite = { sha256: build.sha256, testSha256: testBuild?.sha256 ?? '', archive: req.suite?.archive ?? '', envKeys: Object.keys(env).sort() };
    this.save(run);
    this.db.saveRunSuite(run.id, stored);
    this.envs.set(run.id, env);
    this.db.audit('run.start', p.accountId, null);
    // It rejects only when the broker closes during the run; the next start marks the run failed.
    this.coordinate(p, run.id, { ...stored, env }).catch(() => {});
    return run;
  }

  // Runs one flow of a finished run again on a fresh device, recorded, and folds the result into the run.
  rerun(p: auth.Principal, id: string, flow: string, req: RerunRequest = {}): Run {
    const run = this.get(id);
    if (run.state === 'running') {
      throw new ApiError(409, 'RUN_RUNNING', 'This run is still going.', 'Wait for it to end, or cancel it with DELETE /v1/runs/:id, then rerun the flow.');
    }
    const before = run.flows.find((f) => f.flow === flow);
    if (!before) {
      throw new ApiError(404, 'FLOW_NOT_FOUND', `Run ${id} has no flow called ${flow}.`, `Its flows are: ${run.flows.map((f) => f.flow).join(', ')}.`);
    }
    const stored = this.db.getRunSuite(id);
    if (!stored) {
      throw new ApiError(409, 'NO_SUITE', 'This run started before Hangar kept what it needs to rerun a flow.', 'Start a new run instead.');
    }
    if (req.env !== undefined && (typeof req.env !== 'object' || req.env === null || Object.values(req.env).some((v) => typeof v !== 'string'))) {
      throw new ApiError(400, 'BAD_ENV', 'Send `env` as an object of strings, such as {"USER": "test"}.');
    }
    const env = req.env ?? this.envs.get(id) ?? (stored.envKeys.length ? null : {});
    if (!env) {
      throw new ApiError(409, 'ENV_NEEDED', 'Hangar restarted since this run, and it keeps environment values in memory only.', `Send \`env\` with ${stored.envKeys.join(', ')} in the request body.`);
    }
    if (!this.db.getBuild(stored.sha256)) {
      throw new ApiError(404, 'BUILD_NOT_FOUND', `The build of this run (${run.build}) is no longer on Hangar.`, 'Upload it again and start a new run.');
    }
    this.envs.set(id, env);
    const next = this.save({
      ...run,
      state: 'running',
      error: null,
      endedAt: null,
      flows: run.flows.map((f) => (f.flow === flow ? { ...f, status: 'running' } : f)),
    });
    this.db.audit('run.rerun', p.accountId, null);
    this.rerunFlow(p, id, before, run.state, { ...stored, env }).catch(() => {});
    return next;
  }

  // A run inside a booking needs a caller on the booking's team and an open window.
  private bookingFor(p: auth.Principal, name: string): Booking {
    const booking = findBooking(this.db, name);
    if (this.db.teamOf(p.accountId) !== booking.teamId) {
      throw new ApiError(403, 'NOT_YOUR_BOOKING', `Booking ${booking.name} belongs to another team.`, 'Run without --booking, or ask someone on that team to start the run.');
    }
    const own = priorityOf(this.db, p);
    if (own.bookingId && own.bookingId !== booking.id) {
      throw new ApiError(403, 'NOT_YOUR_BOOKING', `This token leases from another booking, not ${booking.name}.`, 'Use a token made for this booking, or a CI token.');
    }
    const now = Date.now();
    if (!windowAt(booking, now, this.leases.timeZone)) {
      const next = nextWindow(booking, now, this.leases.timeZone);
      const when = next ? ` It opens at ${new Date(next.from).toISOString().replace('T', ' ').slice(0, 16)} UTC.` : '';
      throw new ApiError(409, 'BOOKING_CLOSED', `Booking ${booking.name} is not open now.${when}`, 'Start the run inside the window, or run without --booking.');
    }
    return booking;
  }

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
        this.leases.release(p.role === 'operator' ? p : (this.holders.get(leaseId) ?? this.owner(run)), leaseId);
      } catch {
      }
    }
    return cancelled;
  }

  view(run: Run): unknown {
    const count = (s: FlowResult['status']): number => run.flows.filter((f) => f.status === s).length;
    const holds = this.leases.holds().filter((h) => h.runId === run.id);
    return {
      ...run,
      // A hold shows only while the device is still held.
      flows: run.flows.map((f) => (f.held && !holds.some((h) => h.flow === f.flow) ? withoutHeld(f) : f)),
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

  // The shards update the same run concurrently, so each change reads the latest copy first.
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
      this.update(id, (r) => (r.state === 'running' ? { state: 'failed', error: errorOf(err).message, endedAt: Date.now() } : {}));
    }
    this.db.audit('run.end', p.accountId, null);
  }

  // Records what fn does on the lease. The recording is kept even when fn throws.
  private async recorded<T>(p: auth.Principal, leaseId: string, fn: () => Promise<T>): Promise<Recorded<T>> {
    const rec = await this.recordings.start(p, leaseId).catch(() => null);
    let out: { ok: true; value: T } | { ok: false; error: Error };
    try {
      out = { ok: true, value: await fn() };
    } catch (err) {
      out = { ok: false, error: errorOf(err) };
    }
    const recording = rec ? await this.recordings.stop(p, leaseId).then((x) => ({ id: x.id, url: `${this.publicUrl()}/recordings/${x.id}` }), () => undefined) : undefined;
    return recording ? { ...out, recording } : out;
  }

  // A shard whose lease was preempted runs its unfinished flows again on another lease, up to three times.
  private async shard(p: auth.Principal, id: string, shard: number, flows: string[], suite: Suite): Promise<void> {
    let pending = flows;
    for (let attempt = 1; pending.length > 0; attempt++) {
      const leaseId = await this.shardOnce(p, id, shard, pending, suite);
      if (!this.interrupted(leaseId) || this.cancelled(id)) {
        return;
      }
      const flowsNow = this.db.getRun(id)?.flows ?? [];
      pending = pending.filter((f) => ['running', 'queued'].includes(flowsNow.find((x) => x.flow === f)?.status ?? ''));
      const message = 'The device was taken for a higher-priority lease.';
      for (const f of pending) {
        this.setFlow(id, f, attempt >= 3 ? { status: 'failed', message: `${message} Gave up after ${attempt} tries.` } : { status: 'queued', message });
      }
      if (attempt >= 3) {
        return;
      }
    }
  }

  private interrupted(leaseId: string): boolean {
    return this.db.getLease(leaseId)?.reason === 'preempted';
  }

  private async shardOnce(p: auth.Principal, id: string, shard: number, flows: string[], suite: Suite): Promise<string> {
    const run = this.db.getRun(id)!;
    const via = `${kindName(run.kind)}, shard ${shard + 1} of ${run.shards}`;
    const failAll = (message: string): void => {
      for (const f of flows) {
        this.setFlow(id, f, { status: 'failed', message });
      }
    };
    // With a hold, the first flow that failed keeps the device.
    const keep = (): string | null => {
      const current = this.db.getRun(id);
      return current?.holdMs ? (flows.find((f) => current.flows.find((x) => x.flow === f)?.status === 'failed') ?? null) : null;
    };
    return this.withLease(p, id, via, suite, failAll, { keep, booked: true }, async (leaseId, exec) => {
      for (const f of flows) {
        this.setFlow(id, f, { status: 'running', attempts: 1 });
      }
      // The first pass is one recording for the shard, kept only when a flow in it fails.
      const first = await this.recorded(p, leaseId, () => exec(flows));
      const firstRecording = first.recording?.url;
      if (!first.ok) {
        if (this.cancelled(id) || this.interrupted(leaseId)) {
          return;
        }
        for (const f of flows) {
          this.setFlow(id, f, { status: 'failed', message: first.error.message, firstMessage: first.error.message, ...(firstRecording ? { firstRecording } : {}) });
        }
        return;
      }
      const failedFirst = first.value.failed;
      for (const f of flows) {
        const failed = failedFirst.includes(f);
        const seconds = first.value.seconds.get(f);
        this.setFlow(id, f, {
          status: failed ? 'failed' : 'passed',
          ...(failed ? { message: first.value.message, firstMessage: first.value.message, ...(firstRecording ? { firstRecording } : {}) } : {}),
          ...(seconds !== undefined ? { seconds } : {}),
        });
      }
      if (first.recording && failedFirst.length === 0) {
        await this.recordings.delete(p, first.recording.id).catch(() => {});
      }
      const retries = this.db.getRun(id)!.retries;
      for (const f of failedFirst) {
        for (let attempt = 2; attempt <= retries + 1 && !this.cancelled(id); attempt++) {
          this.setFlow(id, f, { status: 'running', attempts: attempt });
          const r = await this.recorded(p, leaseId, () => exec([f]));
          if (this.interrupted(leaseId)) {
            return;
          }
          const ok = r.ok && r.value.failed.length === 0;
          const message = r.ok ? r.value.message : r.error.message;
          this.setFlow(id, f, { status: ok ? 'flaky' : 'failed', message: ok ? undefined : message, ...(r.recording ? { recording: r.recording.url } : {}) });
          if (ok) {
            break;
          }
        }
      }
    });
  }

  private async rerunFlow(p: auth.Principal, id: string, before: FlowResult, previous: Run['state'], suite: Suite): Promise<void> {
    const flow = before.flow;
    const out: { result: { passed: boolean; message?: string; recording?: string } | null } = { result: null };
    try {
      await this.withLease(p, id, `${kindName(this.db.getRun(id)?.kind)}, rerun of ${flow}`, suite, (message) => (out.result = { passed: false, message }), {}, async (leaseId, exec) => {
        const r = await this.recorded(p, leaseId, () => exec([flow]));
        if (this.cancelled(id)) {
          return;
        }
        out.result = { passed: r.ok && r.value.failed.length === 0, message: r.ok ? r.value.message : r.error.message, ...(r.recording ? { recording: r.recording.url } : {}) };
      });
    } finally {
      const outcome = out.result;
      this.update(id, (r) => {
        // A rerun that ends without a result, such as a cancelled one, leaves the flow as it was.
        const flows = r.flows.map((f) => (f.flow === flow ? (outcome ? rerunResult(before, outcome) : before) : f));
        return r.state === 'running' ? { flows, state: settledState(flows, previous), endedAt: Date.now() } : { flows };
      });
      this.db.audit('run.end', p.accountId, null);
    }
  }

  // Runs fn on a fresh lease and returns the lease id. `keep` names a failed flow whose device stays held.
  private async withLease(p: auth.Principal, id: string, via: string, suite: Suite, fail: (message: string) => void, opts: { keep?: () => string | null; booked?: boolean }, fn: (leaseId: string, exec: Exec) => Promise<void>): Promise<string> {
    const run = this.db.getRun(id)!;
    // Only a run's own shards lease inside its booking; a rerun later leases like any other request.
    const bookingId = opts.booked && run.booking ? run.booking.id : undefined;
    const lease = this.leases.create(p, run.class, { via, shard: true, ...(bookingId ? { bookingId } : {}) });
    this.holders.set(lease.id, p);
    this.update(id, (r) => ({ leaseIds: [...r.leaseIds, lease.id] }));
    const renew = setInterval(() => {
      try {
        this.leases.renew(p, lease.id);
      } catch {
      }
    }, 60_000);
    try {
      await this.active(lease.id);
      if (this.cancelled(id)) {
        return lease.id;
      }
      await fn(lease.id, await this.executor(p, lease.id, run.kind ?? 'maestro', suite));
    } catch (err) {
      if (this.cancelled(id) || this.interrupted(lease.id)) {
        return lease.id;
      }
      fail(errorOf(err).message);
    } finally {
      clearInterval(renew);
      this.holders.delete(lease.id);
      if (!this.holdDevice(p, id, lease.id, opts.keep)) {
        try {
          this.leases.release(p, lease.id);
        } catch {
        }
      }
    }
    return lease.id;
  }

  private holdDevice(p: auth.Principal, id: string, leaseId: string, keep: (() => string | null) | undefined): boolean {
    const holdMs = this.db.getRun(id)?.holdMs;
    const flow = keep && holdMs && !this.cancelled(id) && this.db.getLease(leaseId)?.state === 'active' ? keep() : null;
    if (!flow || !holdMs) {
      return false;
    }
    try {
      const hold = this.leases.hold(p, leaseId, { runId: id, flow, ms: holdMs });
      this.setFlow(id, flow, { held: { until: hold.until } });
      return true;
    } catch {
      return false;
    }
  }

  /** Leases the device a failed flow left held, for a person on the run's team. */
  holdLease(p: auth.Principal, id: string, flow: string): ReturnType<Leases['leaseHeld']> {
    this.get(id);
    return this.leases.leaseHeld(p, id, flow);
  }

  /** Lets the held device of a flow go: it is wiped and goes back to the pool. */
  releaseHold(p: auth.Principal, id: string, flow: string): Run {
    this.leases.releaseHold(p, id, flow);
    return this.update(id, (r) => ({ flows: r.flows.map((f) => (f.flow === flow ? withoutHeld(f) : f)) }));
  }

  private async executor(p: auth.Principal, leaseId: string, kind: NonNullable<Run['kind']>, suite: Suite): Promise<Exec> {
    const { sha256, archive, env } = suite;
    const artifactUrl = (sha = sha256): string => `${this.internalUrl()}/v1/artifacts/${sha}?t=${auth.mintToken(this.db, 'artifact', { expiresAt: Date.now() + 10 * 60_000 })}`;
    const lastLines = (log: string): string => log.split('\n').filter(Boolean).slice(-3).join(' ');
    if (kind === 'maestro') {
      await this.leases.op(p, leaseId, { op: 'install', artifactUrl: artifactUrl(), sha256 });
      return async (only) => {
        const r = (await this.leases.op(p, leaseId, { op: 'maestro', archive, flows: only, env })).result as MaestroResult;
        // Without a report Maestro failed before running flows; count them all as failed.
        const failed = failedCases(r.junit);
        const times = caseSeconds(r.junit);
        const seconds = new Map(only.flatMap((f) => (times.has(flowName(f)) ? [[f, times.get(flowName(f)) ?? 0]] : [])));
        return { failed: only.filter((f) => (r.junit ? failed.has(flowName(f)) : !r.passed)), message: lastLines(r.log), seconds };
      };
    }
    if (kind === 'espresso') {
      return async (only) => {
        const tests = only.includes('all') ? [] : only;
        const r = (await this.leases.op(p, leaseId, { op: 'espresso', app: { url: artifactUrl(), sha256 }, testApp: { url: artifactUrl(suite.testSha256), sha256: suite.testSha256 }, tests })).result as TestResult;
        const bad = r.cases.filter((c) => c.status === 'failed');
        const of = (t: string, c: TestCase): boolean => t === 'all' || t === c.className || t === `${c.className}#${c.name}`;
        const failed = only.filter((t) => (r.cases.length ? bad.some((c) => of(t, c)) : !r.passed));
        return { failed, message: bad.map((c) => `${c.className.split('.').pop()}.${c.name}: ${c.message ?? 'failed'}`).join(' ') || lastLines(r.log), seconds: sumSeconds(only, r.cases, of) };
      };
    }
    return async (only) => {
      const r = (await this.leases.op(p, leaseId, { op: 'xcuitest', artifactUrl: artifactUrl(), sha256, tests: only })).result as TestResult;
      const bad = r.cases.filter((c) => c.status === 'failed');
      const of = (t: string, c: TestCase): boolean => `${c.target}/${c.className}/${c.name}`.startsWith(t);
      const failed = only.filter((t) => (r.cases.length ? bad.some((c) => of(t, c)) : !r.passed));
      return { failed, message: bad.map((c) => `${c.className}.${c.name}: ${c.message ?? 'failed'}`).join(' ') || lastLines(r.log), seconds: sumSeconds(only, r.cases, of) };
    };
  }

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

// The flow after a rerun: every attempt counts toward its status, and the first failure is kept.
export function rerunResult(before: FlowResult, outcome: { passed: boolean; message?: string; recording?: string }): FlowResult {
  const next: FlowResult = { ...before, status: combineStatus(before.status, outcome.passed), attempts: before.attempts + 1 };
  if (outcome.passed) {
    delete next.message;
  } else if (outcome.message !== undefined) {
    next.message = outcome.message;
    next.firstMessage ??= outcome.message;
  }
  if (outcome.recording) {
    next.recording = outcome.recording;
  }
  return next;
}

function withoutHeld(f: FlowResult): FlowResult {
  const { held: _held, ...rest } = f;
  return rest;
}

function kindName(kind: Run['kind']): string {
  return { maestro: 'Maestro', xcuitest: 'XCUITest', espresso: 'Espresso' }[kind ?? 'maestro'];
}

function errorOf(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
