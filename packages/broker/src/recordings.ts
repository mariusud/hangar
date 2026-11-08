// Recordings: the video of a lease, the device's app log, a last screenshot, and the actions that
// were taken, with when. A recording becomes a link a tester pastes into a bug report.
//
// The host writes the video (the stream's own H.264, in an MP4) and uploads the files when the
// recording stops, with one-use URLs. The broker keeps the action timeline itself, because every
// action passes through it. Files live in <dataDir>/recordings/<id>/ and expire after 14 days.

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Op } from '@hangar/protocol';
import * as auth from './auth.ts';
import type { Principal } from './auth.ts';
import type { Db, RecordingRow } from './db.ts';
import { ApiError, type Leases } from './leases/service.ts';
import type { Lease } from './leases/machine.ts';
import type { Store } from './store.ts';

export const RECORDING_PARTS = ['video', 'log', 'screenshot'] as const;
export type RecordingPart = (typeof RECORDING_PARTS)[number];
export const PART_FILES: Record<RecordingPart, { file: string; type: string; limit: number }> = {
  video: { file: 'video.mp4', type: 'video/mp4', limit: 2 * 1024 ** 3 },
  log: { file: 'log.ndjson', type: 'application/x-ndjson', limit: 32 * 1024 ** 2 },
  screenshot: { file: 'screenshot.png', type: 'image/png', limit: 32 * 1024 ** 2 },
};

const RETENTION_MS = 14 * 24 * 3600_000;
const SAVE_TIMEOUT_MS = 30 * 60_000;

// One step on the timeline, at ms since the recording started. Typed text is left out, since
// tests type passwords; screenshots and tree reads are left out as noise.
export type TimelineEvent = { at: number; what: string; failed?: string };

export class Recordings {
  private timelines = new Map<string, { recordingId: string; startedAt: number; events: TimelineEvent[] }>();

  private db: Db;
  private leases: Leases;
  private dir: string;
  private store: Store;
  private internalUrl: () => string;

  constructor(db: Db, leases: Leases, store: Store, internalUrl: () => string) {
    this.db = db;
    this.leases = leases;
    this.store = store;
    this.dir = store.local('recordings');
    this.internalUrl = internalUrl;
    leases.events.on('op', (leaseId: string, body: Op, at: number, result: unknown) => this.note(leaseId, body, at, result));
    leases.events.on('any', (lease: Lease) => {
      if (lease.state === 'active' && this.db.recordingOf(lease.id, ['waiting'])) {
        void this.begin(lease.id).catch(() => {});
      } else if (lease.state === 'ended') {
        void this.leaseEnded(lease.id).catch((err: Error) => console.error(`Could not save the timeline of lease ${lease.id}: ${err.message}`));
      }
    });
  }

  // `record: true` on a new lease: the recording starts as soon as the device is ready.
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
    this.db.updateRecording(rec.id, { state: 'saving', endedAt: Date.now() });
    // The host uploads the files before it answers.
    try {
      await this.saveTimeline(leaseId);
      await this.leases.op(p, leaseId, { op: 'recordStop' });
    } catch (err) {
      // If the lease ended meanwhile, the host is saving the files on its way out.
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

  // The store key of one part, such as recordings/<id>/video.mp4.
  key(id: string, part: RecordingPart | 'timeline'): string {
    return `recordings/${id}/${part === 'timeline' ? 'timeline.json' : PART_FILES[part].file}`;
  }

  path(id: string, part: RecordingPart | 'timeline'): string {
    return this.store.local(this.key(id, part));
  }

  private async removeFiles(id: string): Promise<void> {
    await this.store.remove([...RECORDING_PARTS.map((p) => this.key(id, p)), this.key(id, 'timeline'), `recordings/${id}`]);
  }

  async delete(p: Principal, id: string): Promise<void> {
    const rec = this.get(id);
    if (rec.accountId !== p.accountId && p.role !== 'operator') {
      throw new ApiError(403, 'FORBIDDEN', 'Only the person who recorded it or an operator can delete a recording.');
    }
    await this.removeFiles(id);
    this.db.updateRecording(id, { state: 'deleted' });
  }

  // PUT from the host, with the one-use token the broker gave it for this part.
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

  // Deletes what is past its retention, and fails recordings whose host never sent the files
  // (it went offline, or its upload failed). Runs at start and every hour.
  async sweep(now = Date.now()): Promise<void> {
    for (const rec of this.db.stuckRecordings(now - SAVE_TIMEOUT_MS)) {
      this.db.updateRecording(rec.id, { state: 'failed', error: 'The Mac did not send the files.' });
    }
    for (const rec of this.db.expiredRecordings(now - RETENTION_MS)) {
      await this.removeFiles(rec.id);
      this.db.updateRecording(rec.id, { state: 'deleted' });
    }
  }

  private async begin(leaseId: string, p?: Principal): Promise<RecordingRow> {
    const rec = this.db.recordingOf(leaseId, ['waiting']);
    const lease = this.db.getLease(leaseId);
    if (!rec || !lease) {
      throw new ApiError(404, 'LEASE_NOT_FOUND', `No lease ${leaseId}.`);
    }
    if (lease.state !== 'active') {
      // It starts when the lease becomes active.
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
    this.timelines.set(leaseId, { recordingId: rec.id, startedAt, events: [] });
    try {
      const { result } = await this.leases.op(holder, leaseId, { op: 'recordStart', uploads });
      this.db.updateRecording(rec.id, { device: (result as { device?: string } | undefined)?.device ?? null });
    } catch (err) {
      this.timelines.delete(leaseId);
      this.db.updateRecording(rec.id, { state: 'failed', error: (err as Error).message });
      throw err;
    }
    return this.get(rec.id);
  }

  // Releasing the lease ends its recording. The host uploads the files before it wipes the device.
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
    // A list of actions stops at the first that fails; the timeline says which and why.
    const failed = body.op === 'actions' && Array.isArray(result) ? (result as { ok: boolean; error?: { message: string } }[]).find((r) => !r.ok) : undefined;
    t.events.push({ at: Math.max(0, at - t.startedAt), what, ...(failed ? { failed: failed.error?.message ?? 'failed' } : {}) });
  }

  private async saveTimeline(leaseId: string): Promise<void> {
    const t = this.timelines.get(leaseId);
    if (!t) {
      return;
    }
    this.timelines.delete(leaseId);
    await mkdir(join(this.dir, t.recordingId), { recursive: true });
    await writeFile(this.path(t.recordingId, 'timeline'), JSON.stringify(t.events));
    await this.store.saved(this.key(t.recordingId, 'timeline'));
  }
}

// Points are fractions of the screen; the timeline shows them as percentages from the top left.
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
    default:
      return null;
  }
}
