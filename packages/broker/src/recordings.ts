
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { LogLine, NetworkEntry, Op, UiNode } from '@hangar/protocol';
import * as auth from './auth.ts';
import type { Principal } from './auth.ts';
import type { Db, RecordingRow } from './db.ts';
import { ApiError, type Leases } from './leases/service.ts';
import type { Lease } from './leases/machine.ts';
import type { Store } from './store.ts';
import { ACTION_LIMIT, Findings, nodesOf, RECORDER, recordOp, type RecordedAction } from './findings.ts';

export const RECORDING_PARTS = ['video', 'log', 'screenshot'] as const;
export type RecordingPart = (typeof RECORDING_PARTS)[number];
export const PART_FILES: Record<RecordingPart, { file: string; type: string; limit: number }> = {
  video: { file: 'video.mp4', type: 'video/mp4', limit: 2 * 1024 ** 3 },
  log: { file: 'log.ndjson', type: 'application/x-ndjson', limit: 32 * 1024 ** 2 },
  screenshot: { file: 'screenshot.png', type: 'image/png', limit: 32 * 1024 ** 2 },
};

const RETENTION_MS = 14 * 24 * 3600_000;
const SAVE_TIMEOUT_MS = 30 * 60_000;

export type TimelineEvent = { at: number; what: string; failed?: string };

// Files the broker writes for a recording itself, next to the ones the Mac uploads.
export const BROKER_PARTS = ['timeline', 'applog', 'network'] as const;
export type BrokerPart = (typeof BROKER_PARTS)[number];
const BROKER_FILES: Record<BrokerPart, string> = { timeline: 'timeline.json', applog: 'applog.json', network: 'network.json' };

export const LOG_LIMIT = 5000;
export const NETWORK_LIMIT = 2000;
const TEXT_LIMIT = 2000;
const COLLECT_EVERY_MS = 10_000;

type Source = { next: number | null; dropped: boolean; error: string | null };

export type Timeline = {
  recordingId: string;
  startedAt: number;
  events: TimelineEvent[];
  log: LogLine[];
  network: Map<string, NetworkEntry>;
  sources: { appLog: Source; network: Source };
  collecting: Promise<void> | null;
  timer: NodeJS.Timeout | null;
};

type ActionLog = { actions: RecordedAction[]; truncated: boolean; screen: UiNode[] | null };

export type CollectedLog ={ lines: LogLine[]; dropped: boolean; error: string | null };
export type CollectedNetwork = { requests: NetworkEntry[]; dropped: boolean; error: string | null };

export class Recordings {
  private timelines = new Map<string, Timeline>();
  private taken = new Map<string, ActionLog>();
  readonly findings: Findings;
  private collectEveryMs: number;

  private db: Db;
  private leases: Leases;
  private dir: string;
  private store: Store;
  private internalUrl: () => string;

  constructor(db: Db, leases: Leases, store: Store, internalUrl: () => string, opts: { collectEveryMs?: number } = {}) {
    this.db = db;
    this.collectEveryMs = opts.collectEveryMs ?? COLLECT_EVERY_MS;
    this.findings = new Findings(db, leases, this, store, internalUrl);
    this.leases = leases;
    this.store = store;
    this.dir = store.local('recordings');
    this.internalUrl = internalUrl;
    leases.events.on('op', (leaseId: string, body: Op, at: number, result: unknown) => {
      this.note(leaseId, body, at, result);
      this.keep(leaseId, body, at, result);
    });
    leases.events.on('any', (lease: Lease) => {
      if (lease.state === 'active' && this.db.recordingOf(lease.id, ['waiting'])) {
        void this.begin(lease.id).catch(() => {});
      } else if (lease.state === 'ended') {
        this.taken.delete(lease.id);
        void this.leaseEnded(lease.id).catch((err: Error) => console.error(`Could not save the timeline of lease ${lease.id}: ${err.message}`));
      }
    });
  }

  want(p: Principal, leaseId: string): void {
    this.db.insertRecording({ id: randomUUID(), leaseId, accountId: p.accountId, state: 'waiting', startedAt: null, endedAt: null, bytes: 0, error: null, device: null });
  }

  async start(p: Principal, leaseId: string): Promise<RecordingRow> {
    if (this.leases.get(p, leaseId).state !== 'active') {
      throw new ApiError(409, 'LEASE_NOT_ACTIVE', 'Only an active lease can be recorded.');
    }
    if (this.db.recordingOf(leaseId, ['waiting', 'recording'])) {
      throw new ApiError(409, 'ALREADY_RECORDING', 'This lease is already being recorded.');
    }
    this.want(p, leaseId);
    return this.begin(leaseId, p);
  }

  async stop(p: Principal, leaseId: string): Promise<RecordingRow> {
    this.leases.get(p, leaseId);
    const rec = this.db.recordingOf(leaseId, ['recording']);
    if (!rec) {
      throw new ApiError(409, 'NOT_RECORDING', 'This lease is not being recorded.');
    }
    await this.collect(leaseId);
    this.db.updateRecording(rec.id, { state: 'saving', endedAt: Date.now() });
    try {
      await this.saveTimeline(leaseId);
      await this.leases.op(p, leaseId, { op: 'recordStop' });
    } catch (err) {
      if (this.db.getLease(leaseId)?.state !== 'ended') {
        this.db.updateRecording(rec.id, { state: 'failed', error: (err as Error).message });
      }
      throw err;
    }
    return this.get(rec.id);
  }

  get(id: string): RecordingRow {
    const rec = this.db.getRecording(id);
    if (!rec || rec.state === 'deleted') {
      throw new ApiError(404, 'RECORDING_NOT_FOUND', `No recording ${id}.`);
    }
    return rec;
  }

  key(id: string, part: RecordingPart | BrokerPart): string {
    return `recordings/${id}/${isBrokerPart(part) ? BROKER_FILES[part] : PART_FILES[part].file}`;
  }

  path(id: string, part: RecordingPart | BrokerPart): string {
    return this.store.local(this.key(id, part));
  }

  // The recording a lease is making now and when its video started, or null.
  current(leaseId: string): { recordingId: string; startedAt: number } | null {
    const t = this.timelines.get(leaseId);
    return t ? { recordingId: t.recordingId, startedAt: t.startedAt } : null;
  }

  // The actions the lease's holder took up to `until`, recorded or not, for a finding to replay.
  actionsOf(leaseId: string, until: number): { actions: RecordedAction[]; truncated: boolean } {
    const log = this.taken.get(leaseId);
    return { actions: (log?.actions ?? []).filter((a) => a.at <= until), truncated: log?.truncated ?? false };
  }

  // A describe names the elements under the taps that follow it, until the next action changes the screen.
  private keep(leaseId: string, body: Op, at: number, result: unknown): void {
    if (this.db.getLease(leaseId)?.state !== 'active') {
      return;
    }
    const log = this.taken.get(leaseId) ?? { actions: [], truncated: false, screen: null };
    this.taken.set(leaseId, log);
    if (body.op === 'describe') {
      log.screen = nodesOf(result);
      return;
    }
    const actions = recordOp(body, at, result, log.screen);
    if (!actions.length) {
      return;
    }
    log.screen = null;
    log.actions.push(...actions);
    if (log.actions.length > ACTION_LIMIT) {
      log.actions.splice(0, log.actions.length - ACTION_LIMIT);
      log.truncated = true;
    }
  }

  // Steps taken from `fromMs` into the recording on.
  stepsFrom(leaseId: string, fromMs: number): TimelineEvent[] {
    return (this.timelines.get(leaseId)?.events ?? []).filter((e) => e.at >= fromMs);
  }

  appLog(leaseId: string): CollectedLog {
    const t = this.timelines.get(leaseId);
    return { lines: t?.log ?? [], dropped: t?.sources.appLog.dropped ?? false, error: t?.sources.appLog.error ?? null };
  }

  networkLog(leaseId: string): CollectedNetwork {
    const t = this.timelines.get(leaseId);
    return { requests: [...(t?.network.values() ?? [])], dropped: t?.sources.network.dropped ?? false, error: t?.sources.network.error ?? null };
  }

  // Reads the app log and network requests the Mac buffered since the last read. One read runs at a time.
  collect(leaseId: string): Promise<void> {
    const t = this.timelines.get(leaseId);
    if (!t) {
      return Promise.resolve();
    }
    t.collecting ??= (async () => {
      await this.collectSource(leaseId, t, 'appLog');
      await this.collectSource(leaseId, t, 'network');
    })().finally(() => {
      t.collecting = null;
    });
    return t.collecting;
  }

  private async collectSource(leaseId: string, t: Timeline, source: 'appLog' | 'network'): Promise<void> {
    const state = t.sources[source];
    let result: unknown;
    try {
      result = (await this.leases.op(RECORDER, leaseId, { op: source, limit: 1000, ...(state.next === null ? {} : { since: state.next }) })).result;
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      return;
    }
    if (!isPage(result)) {
      state.error = 'The Mac answered with something other than a page.';
      return;
    }
    state.error = null;
    state.dropped ||= result.dropped;
    state.next = result.next;
    if (source === 'appLog') {
      t.log.push(...result.items.filter(isLogLine).map(boundLine));
      if (t.log.length > LOG_LIMIT) {
        t.log.splice(0, t.log.length - LOG_LIMIT);
        state.dropped = true;
      }
      return;
    }
    for (const entry of result.items.filter(isNetworkEntry)) {
      t.network.delete(entry.id);
      t.network.set(entry.id, boundRequest(entry));
    }
    for (const id of t.network.keys()) {
      if (t.network.size <= NETWORK_LIMIT) {
        break;
      }
      t.network.delete(id);
      state.dropped = true;
    }
  }

  private async removeFiles(id: string): Promise<void> {
    await this.store.remove([...RECORDING_PARTS.map((p) => this.key(id, p)), ...BROKER_PARTS.map((p) => this.key(id, p)), `recordings/${id}`]);
  }

  async delete(p: Principal, id: string): Promise<void> {
    const rec = this.get(id);
    if (rec.accountId !== p.accountId && p.role !== 'operator') {
      throw new ApiError(403, 'FORBIDDEN', 'Only the person who recorded it or an operator can delete a recording.');
    }
    await this.removeFiles(id);
    this.db.updateRecording(id, { state: 'deleted' });
  }

  async upload(req: IncomingMessage, id: string, part: string, token: string): Promise<void> {
    const row = auth.lookupToken(this.db, token, Date.now());
    if (!row || row.kind !== 'upload' || row.label !== `${id}:${part}` || !this.db.useToken(row.hash, Date.now())) {
      throw new ApiError(403, 'FORBIDDEN', 'This upload link is not valid.');
    }
    const spec = PART_FILES[part as RecordingPart];
    if (this.db.getRecording(id)?.state !== 'saving') {
      throw new ApiError(409, 'NOT_SAVING', 'This recording is not waiting for files.');
    }
    await mkdir(join(this.dir, id), { recursive: true });
    const path = this.path(id, part as RecordingPart);
    let size = 0;
    await pipeline(
      req,
      async function* (source) {
        for await (const chunk of source) {
          size += (chunk as Buffer).length;
          if (size > spec.limit) {
            throw new ApiError(413, 'BODY_TOO_LARGE', `A recording's ${part} is limited to ${spec.limit} bytes.`);
          }
          yield chunk;
        }
      },
      createWriteStream(path),
    ).catch(async (err: unknown) => {
      await rm(path, { force: true });
      throw err;
    });
    await this.store.saved(this.key(id, part as RecordingPart));
    const rec = this.get(id);
    this.db.updateRecording(id, { bytes: rec.bytes + size });
    // The host sends the video last, so the recording is complete once it lands.
    if (part === 'video' && rec.state === 'saving') {
      this.db.updateRecording(id, { state: 'ready' });
    }
  }

  async sweep(now = Date.now()): Promise<void> {
    for (const rec of this.db.stuckRecordings(now - SAVE_TIMEOUT_MS)) {
      this.db.updateRecording(rec.id, { state: 'failed', error: 'The Mac did not send the files.' });
    }
    for (const rec of this.db.expiredRecordings(now - RETENTION_MS)) {
      await this.removeFiles(rec.id);
      this.db.updateRecording(rec.id, { state: 'deleted' });
    }
    await this.findings.sweep(now - RETENTION_MS);
  }

  private async begin(leaseId: string, p?: Principal): Promise<RecordingRow> {
    const rec = this.db.recordingOf(leaseId, ['waiting']);
    const lease = this.db.getLease(leaseId);
    if (!rec || !lease) {
      throw new ApiError(404, 'LEASE_NOT_FOUND', `No lease ${leaseId}.`);
    }
    if (lease.state !== 'active') {
      return rec;
    }
    const account = this.db.getAccount(lease.principalId);
    const holder: Principal = p ?? { accountId: lease.principalId, name: account?.name ?? 'unknown', role: account?.role ?? 'member', scopes: [] };
    const uploads = Object.fromEntries(
      RECORDING_PARTS.map((part) => {
        // Valid until well after the lease's longest possible life.
        const code = auth.mintToken(this.db, 'upload', { label: `${rec.id}:${part}`, expiresAt: lease.createdAt + lease.maxMs + 3600_000 });
        return [part, `${this.internalUrl()}/v1/uploads/recordings/${rec.id}/${part}?t=${code}`];
      }),
    ) as Record<RecordingPart, string>;
    const startedAt = Date.now();
    this.db.updateRecording(rec.id, { state: 'recording', startedAt });
    const t: Timeline = {
      recordingId: rec.id,
      startedAt,
      events: [],
      log: [],
      network: new Map(),
      sources: { appLog: { next: null, dropped: false, error: null }, network: { next: null, dropped: false, error: null } },
      collecting: null,
      timer: null,
    };
    this.timelines.set(leaseId, t);
    try {
      const { result } = await this.leases.op(holder, leaseId, { op: 'recordStart', uploads });
      this.db.updateRecording(rec.id, { device: (result as { device?: string } | undefined)?.device ?? null });
      if (this.collectEveryMs > 0 && this.timelines.get(leaseId) === t) {
        t.timer = setInterval(() => void this.collect(leaseId), this.collectEveryMs);
        t.timer.unref();
        void this.collect(leaseId);
      }
    } catch (err) {
      this.timelines.delete(leaseId);
      this.db.updateRecording(rec.id, { state: 'failed', error: (err as Error).message });
      throw err;
    }
    return this.get(rec.id);
  }

  private async leaseEnded(leaseId: string): Promise<void> {
    const waiting = this.db.recordingOf(leaseId, ['waiting']);
    if (waiting) {
      this.db.updateRecording(waiting.id, { state: 'failed', error: 'The lease ended before the device was ready.' });
    }
    const rec = this.db.recordingOf(leaseId, ['recording']);
    if (!rec) {
      return;
    }
    this.db.updateRecording(rec.id, { state: 'saving', endedAt: Date.now() });
    await this.saveTimeline(leaseId);
  }

  private note(leaseId: string, body: Op, at: number, result: unknown): void {
    const t = this.timelines.get(leaseId);
    const what = describeOp(body);
    if (!t || !what) {
      return;
    }
    const failed = body.op === 'actions' && Array.isArray(result) ? (result as { ok: boolean; error?: { message: string } }[]).find((r) => !r.ok) : undefined;
    t.events.push({ at: Math.max(0, at - t.startedAt), what, ...(failed ? { failed: failed.error?.message ?? 'failed' } : {}) });
  }

  private async saveTimeline(leaseId: string): Promise<void> {
    const t = this.timelines.get(leaseId);
    if (!t) {
      return;
    }
    if (t.timer) {
      clearInterval(t.timer);
    }
    // A read that is under way when the lease ends still lands in the files.
    await t.collecting?.catch(() => {});
    this.timelines.delete(leaseId);
    await mkdir(join(this.dir, t.recordingId), { recursive: true });
    const log: CollectedLog = { lines: t.log, dropped: t.sources.appLog.dropped, error: t.sources.appLog.error };
    const network: CollectedNetwork = { requests: [...t.network.values()], dropped: t.sources.network.dropped, error: t.sources.network.error };
    const files: [BrokerPart, string][] = [
      ['timeline', JSON.stringify(t.events)],
      ['applog', JSON.stringify(log)],
      ['network', JSON.stringify(network)],
    ];
    for (const [part, data] of files) {
      await writeFile(this.path(t.recordingId, part), data);
      await this.store.saved(this.key(t.recordingId, part));
    }
  }
}

export function isBrokerPart(part: string): part is BrokerPart {
  return BROKER_PARTS.some((p) => p === part);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPage(v: unknown): v is { items: unknown[]; next: number; dropped: boolean } {
  return isRecord(v) && Array.isArray(v.items) && typeof v.next === 'number' && typeof v.dropped === 'boolean';
}

function isLogLine(v: unknown): v is LogLine {
  return isRecord(v) && typeof v.time === 'number' && typeof v.level === 'string' && typeof v.message === 'string';
}

function isNetworkEntry(v: unknown): v is NetworkEntry {
  return isRecord(v) && typeof v.id === 'string' && typeof v.method === 'string' && typeof v.url === 'string' && typeof v.startedAt === 'number';
}

function clip(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}...` : text;
}

export function boundLine(l: LogLine): LogLine {
  return { time: l.time, level: l.level, message: clip(l.message), ...(typeof l.tag === 'string' ? { tag: l.tag.slice(0, 200) } : {}) };
}

export function boundRequest(e: NetworkEntry): NetworkEntry {
  const out: NetworkEntry = { id: e.id.slice(0, 200), method: e.method.slice(0, 20), url: clip(e.url), startedAt: e.startedAt };
  if (typeof e.status === 'number') {
    out.status = e.status;
  }
  if (typeof e.mimeType === 'string') {
    out.mimeType = e.mimeType.slice(0, 200);
  }
  if (typeof e.durationMs === 'number') {
    out.durationMs = e.durationMs;
  }
  if (typeof e.bytes === 'number') {
    out.bytes = e.bytes;
  }
  if (typeof e.error === 'string') {
    out.error = clip(e.error);
  }
  return out;
}

function point(p: [number, number]): string {
  return `(${Math.round(p[0] * 100)}%, ${Math.round(p[1] * 100)}%)`;
}

export function describeOp(body: Op): string | null {
  switch (body.op) {
    case 'actions':
      return body.actions
        .map((a) => {
          switch (a.type) {
            case 'tap':
              return 'element' in a ? `Tap "${a.element.label ?? a.element.identifier ?? a.element.role}"` : `Tap ${point(a.point)}`;
            case 'longPress':
              return `Long press ${point(a.point)}`;
            case 'swipe':
              return `Swipe ${point(a.from)} to ${point(a.to)}`;
            case 'type':
              return `Type ${a.text.length} characters`;
            case 'key':
              return `Key ${[...(a.modifiers ?? []), a.key].join('+')}`;
            case 'button':
              return `Press ${a.button}`;
            case 'waitFor':
              return null;
          }
        })
        .filter(Boolean)
        .join(', ') || null;
    case 'install':
      return 'Install a build';
    case 'launch':
      return `Launch ${body.bundleId}`;
    case 'terminate':
      return `Quit ${body.bundleId}`;
    case 'uninstall':
      return `Uninstall ${body.bundleId}`;
    case 'openUrl':
      return `Open ${body.url}`;
    case 'push':
      return `Push to ${body.bundleId}`;
    case 'permission':
      return `${body.action} ${body.service} for ${body.bundleId}`;
    case 'location':
      return `Location ${body.lat}, ${body.lon}`;
    case 'clearLocation':
      return 'Clear location';
    case 'appearance':
      return `${body.mode} mode`;
    case 'locale':
      return `${body.bundleId} in ${body.language}`;
    case 'useMetro':
      return `Connect ${body.bundleId} to Metro`;
    case 'maestro':
      return `Run Maestro: ${body.flows.join(', ')}`;
    case 'xcuitest':
    case 'espresso':
      return `Run ${body.op === 'xcuitest' ? 'XCUITest' : 'Espresso'}${body.tests.length ? `: ${body.tests.join(', ')}` : ''}`;
    case 'jsEvaluate':
      return 'Run JavaScript in the app';
    case 'orientation':
      return `Rotate to ${body.orientation}`;
    case 'gesture':
      return `${body.gesture === 'pinch' ? 'Pinch' : 'Rotate'} at ${point(body.center)}`;
    default:
      return null;
  }
}
