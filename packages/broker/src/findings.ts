import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FINDING_SEVERITIES, type Finding, type FindingSeverity, type LogLine, type NetworkEntry } from '@hangar/protocol';
import type { Principal } from './auth.ts';
import type { Db, FindingData, FindingRow } from './db.ts';
import { ApiError, type Leases } from './leases/service.ts';
import type { Recordings } from './recordings.ts';
import type { Store } from './store.ts';

// Reads the device tools for findings and recordings. As a non-holder it does not count as activity on the lease.
export const RECORDER: Principal = { accountId: 'hangar-recorder', name: 'Hangar', role: 'operator', scopes: [] };

export const FINDING_WINDOW_MS = 2 * 60_000;
export const LOG_TAIL = 100;
export const NETWORK_TAIL = 50;
const TITLE_LIMIT = 200;
const DESCRIPTION_LIMIT = 10_000;

export type FindingInput = { title: string; description: string; severity: FindingSeverity };

export const STARTED_WITH_FINDING =
  'The lease was not being recorded, so Hangar started a recording with this finding. The video shows what happens from the finding on, not what led up to it.';

export function parseFinding(body: unknown): FindingInput {
  const b = typeof body === 'object' && body !== null ? body : {};
  const title = 'title' in b && typeof b.title === 'string' ? b.title.trim() : '';
  const description = 'description' in b && typeof b.description === 'string' ? b.description.trim() : '';
  const severity = 'severity' in b ? b.severity : undefined;
  if (!title || title.length > TITLE_LIMIT) {
    throw new ApiError(400, 'BAD_TITLE', `Send \`title\`, one line of at most ${TITLE_LIMIT} characters.`);
  }
  if (description.length > DESCRIPTION_LIMIT) {
    throw new ApiError(400, 'BAD_DESCRIPTION', `\`description\` is at most ${DESCRIPTION_LIMIT} characters.`);
  }
  if (severity !== undefined && !isSeverity(severity)) {
    throw new ApiError(400, 'BAD_SEVERITY', `\`severity\` is one of ${FINDING_SEVERITIES.join(', ')}, or left out for medium.`);
  }
  return { title, description, severity: severity ?? 'medium' };
}

export function isSeverity(v: unknown): v is FindingSeverity {
  return FINDING_SEVERITIES.some((s) => s === v);
}

// The part of a recording a finding points at: the last `windowMs` before `now`, or all of it when shorter.
export function videoSpan(startedAt: number, now: number, windowMs = FINDING_WINDOW_MS): { fromMs: number; toMs: number } {
  const toMs = Math.max(0, now - startedAt);
  return { fromMs: Math.max(0, toMs - windowMs), toMs };
}

export class Findings {
  private db: Db;
  private leases: Leases;
  private recordings: Recordings;
  private store: Store;

  constructor(db: Db, leases: Leases, recordings: Recordings, store: Store) {
    this.db = db;
    this.leases = leases;
    this.recordings = recordings;
    this.store = store;
  }

  async report(p: Principal, leaseId: string, input: FindingInput, now = Date.now()): Promise<FindingRow> {
    const lease = this.leases.get(p, leaseId);
    if (lease.state !== 'active') {
      throw new ApiError(409, 'LEASE_NOT_ACTIVE', `Lease ${leaseId} is ${lease.state}. File a finding while the lease is active.`);
    }
    const notes: string[] = [];
    let startedWithFinding = false;
    if (!this.recordings.current(leaseId)) {
      try {
        await this.recordings.start(p, leaseId);
        startedWithFinding = true;
        notes.push(STARTED_WITH_FINDING);
      } catch (err) {
        notes.push(`Hangar could not start a recording, so this finding has no video: ${messageOf(err)}`);
      }
    }
    const current = this.recordings.current(leaseId);
    let video: FindingData['video'] = null;
    let steps: FindingData['steps'] = [];
    let log: LogLine[];
    let logError: string | null;
    let network: NetworkEntry[];
    if (current) {
      await this.recordings.collect(leaseId);
      const span = videoSpan(current.startedAt, now);
      video = { recordingId: current.recordingId, ...span, startedWithFinding };
      steps = this.recordings.stepsFrom(leaseId, span.fromMs).filter((s) => s.at <= span.toMs);
      const collected = this.recordings.appLog(leaseId);
      log = collected.lines.slice(-LOG_TAIL);
      logError = collected.error;
      network = this.recordings.networkLog(leaseId).requests.slice(-NETWORK_TAIL);
    } else {
      ({ log, logError } = await this.logTail(leaseId));
      network = await this.networkTail(leaseId);
    }
    const id = randomUUID();
    const screenshot = await this.screenshot(leaseId, id).catch((err: unknown) => {
      notes.push(`Hangar could not take a screenshot: ${messageOf(err)}`);
      return false;
    });
    const night = this.db.nights({ teamId: lease.teamId, state: 'open' }, 1)[0] ?? null;
    const row: FindingRow = {
      id,
      leaseId,
      accountId: p.accountId,
      teamId: lease.teamId,
      nightId: night?.id ?? null,
      createdAt: now,
      data: {
        title: input.title,
        description: input.description,
        severity: input.severity,
        device: this.db.getRecording(video?.recordingId ?? '')?.device ?? null,
        video,
        steps,
        log,
        logError,
        network,
        screenshot,
        notes,
        openAgainUrl: null,
      },
    };
    this.db.insertFinding(row);
    this.db.audit('finding.reported', p.accountId, leaseId);
    return row;
  }

  get(p: Principal, id: string): FindingRow {
    const row = this.db.getFinding(id);
    if (!row || (p.role !== 'operator' && row.teamId !== this.db.teamOf(p.accountId))) {
      throw new ApiError(404, 'FINDING_NOT_FOUND', `No finding ${id}.`);
    }
    return row;
  }

  screenshotKey(id: string): string {
    return `findings/${id}/screenshot.png`;
  }

  async sweep(before: number): Promise<void> {
    const old = this.db.findingsBefore(before).filter((f) => f.data.screenshot);
    await this.store.remove(old.flatMap((f) => [this.screenshotKey(f.id), `findings/${f.id}`]));
  }

  private async logTail(leaseId: string): Promise<{ log: LogLine[]; logError: string | null }> {
    try {
      const page = (await this.leases.op(RECORDER, leaseId, { op: 'appLog', limit: LOG_TAIL })).result;
      return { log: itemsOf(page).filter(isLine), logError: null };
    } catch (err) {
      return { log: [], logError: messageOf(err) };
    }
  }

  private async networkTail(leaseId: string): Promise<NetworkEntry[]> {
    try {
      return itemsOf((await this.leases.op(RECORDER, leaseId, { op: 'network', limit: NETWORK_TAIL })).result).filter(isRequest);
    } catch {
      return [];
    }
  }

  private async screenshot(leaseId: string, id: string): Promise<boolean> {
    const { binary } = await this.leases.op(RECORDER, leaseId, { op: 'screenshot', format: 'png' });
    if (!binary?.length) {
      throw new Error('The Mac sent no image.');
    }
    const key = this.screenshotKey(id);
    const path = this.store.local(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, binary);
    await this.store.saved(key);
    return true;
  }
}

export function findingView(db: Db, row: FindingRow, publicUrl: string): Finding {
  const d = row.data;
  const video = d.video;
  return {
    id: row.id,
    leaseId: row.leaseId,
    nightId: row.nightId,
    title: d.title,
    description: d.description,
    severity: d.severity,
    by: db.getAccount(row.accountId)?.name ?? 'unknown',
    createdAt: row.createdAt,
    device: d.device,
    video: video
      ? {
          ...video,
          url: `${publicUrl}/recordings/${video.recordingId}`,
          video: `${publicUrl}/v1/recordings/${video.recordingId}/video.mp4#t=${seconds(video.fromMs)},${seconds(video.toMs)}`,
        }
      : null,
    steps: d.steps,
    log: d.log,
    logError: d.logError,
    network: d.network,
    screenshot: d.screenshot ? `${publicUrl}/v1/findings/${row.id}/screenshot.png` : null,
    notes: d.notes,
    openAgainUrl: d.openAgainUrl,
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function seconds(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

function itemsOf(page: unknown): unknown[] {
  return typeof page === 'object' && page !== null && 'items' in page && Array.isArray(page.items) ? page.items : [];
}

function isLine(v: unknown): v is LogLine {
  return typeof v === 'object' && v !== null && 'time' in v && typeof v.time === 'number' && 'message' in v && typeof v.message === 'string' && 'level' in v && typeof v.level === 'string';
}

function isRequest(v: unknown): v is NetworkEntry {
  return typeof v === 'object' && v !== null && 'id' in v && typeof v.id === 'string' && 'url' in v && typeof v.url === 'string' && 'method' in v && typeof v.method === 'string' && 'startedAt' in v && typeof v.startedAt === 'number';
}
