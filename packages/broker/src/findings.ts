import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  FINDING_SEVERITIES,
  type Action,
  type ElementSelector,
  type Finding,
  type FindingSeverity,
  type LogLine,
  type NetworkEntry,
  type Op,
  type OpenAgain,
  type OpenAgainBy,
  type OpenAgainStep,
  type Point,
  type UiNode,
} from '@hangar/protocol';
import * as auth from './auth.ts';
import type { Principal } from './auth.ts';
import type { Db, FindingData, FindingRow } from './db.ts';
import { ApiError, type Leases } from './leases/service.ts';
import { describeOp, type Recordings } from './recordings.ts';
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

  private internalUrl: () => string;

  constructor(db: Db, leases: Leases, recordings: Recordings, store: Store, internalUrl: () => string) {
    this.db = db;
    this.leases = leases;
    this.recordings = recordings;
    this.store = store;
    this.internalUrl = internalUrl;
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
    const taken = this.recordings.actionsOf(leaseId, now);
    const data: StoredFindingData = {
      actions: taken.actions,
      actionsTruncated: taken.truncated,
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
    };
    const row: FindingRow = { id, leaseId, accountId: p.accountId, teamId: lease.teamId, nightId: night?.id ?? null, createdAt: now, data };
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

  // Leases a fresh device like the finding's for the caller, records it and replays the actions taken before the finding.
  async openAgain(p: Principal, id: string, publicUrl: string, opts: { waitMs?: number } = {}): Promise<OpenAgain> {
    const finding = this.get(p, id);
    const original = this.db.getLease(finding.leaseId);
    if (!original) {
      throw new ApiError(404, 'LEASE_NOT_FOUND', `The lease of finding ${id} is gone, so Hangar does not know which device to lease.`);
    }
    const { actions, truncated } = storedActions(finding.data);
    const lease = this.leases.create(p, original.class, { via: `Open again: ${finding.data.title}` });
    try {
      await this.untilActive(lease.id, opts.waitMs ?? OPEN_AGAIN_WAIT_MS);
    } catch (err) {
      try {
        this.leases.release(p, lease.id);
      } catch {
      }
      throw err;
    }
    const notes: string[] = [];
    if (truncated) {
      notes.push(`The original lease took more than ${ACTION_LIMIT} actions. Hangar kept the last ${ACTION_LIMIT}, so the replay does not start where the lease started.`);
    }
    let recording: string | null = null;
    try {
      recording = `${publicUrl}/recordings/${(await this.recordings.start(p, lease.id)).id}`;
    } catch (err) {
      notes.push(`Hangar could not record the replay: ${messageOf(err)}`);
    }
    const steps = await this.replay(p, lease.id, planReplay(actions));
    try {
      this.leases.renew(p, lease.id);
    } catch {
    }
    this.db.audit('finding.opened_again', p.accountId, lease.id);
    return { finding: finding.id, leaseId: lease.id, url: `${publicUrl}/leases/${lease.id}`, recording, steps, notes };
  }

  private untilActive(leaseId: string, ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (err?: ApiError): void => {
        clearTimeout(timer);
        this.leases.events.off(leaseId, check);
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };
      const check = (l: { state: string; reason?: string | null }): void => {
        if (l.state === 'active') {
          done();
        } else if (l.state === 'ended') {
          done(new ApiError(409, 'LEASE_ENDED', `The new lease ended before it got a device (${l.reason ?? 'ended'}).`));
        }
      };
      const timer = setTimeout(() => {
        done(new ApiError(504, 'STILL_QUEUED', `No device like the finding's came free within ${Math.round(ms / 1000)} s, so Hangar withdrew the request.`, 'Try again later, or pass a longer `waitSeconds`.'));
      }, ms);
      this.leases.events.on(leaseId, check);
      const current = this.db.getLease(leaseId);
      if (current) {
        check(current);
      }
    });
  }

  private async replay(p: Principal, leaseId: string, plan: PlannedStep[]): Promise<OpenAgainStep[]> {
    const out: OpenAgainStep[] = [];
    for (const step of plan) {
      if (this.db.getLease(leaseId)?.state !== 'active') {
        out.push({ what: step.what, status: 'skipped', by: null, note: 'The lease ended before this step.' });
        continue;
      }
      if (step.skip !== null) {
        out.push({ what: step.what, status: 'skipped', by: null, note: step.skip });
        continue;
      }
      if (step.waitMs > 0) {
        await sleep(step.waitMs);
      }
      try {
        out.push({ what: step.what, ...(await this.runStep(p, leaseId, step)) });
      } catch (err) {
        out.push({ what: step.what, status: 'failed', by: step.by, note: messageOf(err) });
      }
    }
    return out;
  }

  private async runStep(p: Principal, leaseId: string, step: PlannedStep): Promise<Omit<OpenAgainStep, 'what'>> {
    const a = step.action;
    if (a.kind === 'install') {
      const code = auth.mintToken(this.db, 'artifact', { expiresAt: Date.now() + 10 * 60_000 });
      await this.leases.op(p, leaseId, { op: 'install', artifactUrl: `${this.internalUrl()}/v1/artifacts/${a.sha256}?t=${code}`, sha256: a.sha256 });
      return { status: 'ok', by: null, note: null };
    }
    if (a.kind === 'op') {
      await this.leases.op(p, leaseId, a.op);
      return { status: 'ok', by: step.by, note: null };
    }
    if (a.kind === 'skip') {
      return { status: 'skipped', by: null, note: a.reason };
    }
    const action = a.action;
    if (action.type === 'tap' || action.type === 'longPress') {
      const selector = 'element' in action ? action.element : a.target;
      const recorded = 'point' in action ? action.point : null;
      if (selector) {
        const found = await this.locate(p, leaseId, selector, recorded);
        if (found) {
          await this.act(p, leaseId, withPoint(action, found));
          return { status: 'ok', by: 'label', note: null };
        }
        if (!recorded) {
          return { status: 'failed', by: 'label', note: `No element "${selectorName(selector)}" on the screen.` };
        }
        await this.act(p, leaseId, withPoint(action, recorded));
        return { status: 'ok', by: 'coordinates', note: `No element "${selectorName(selector)}" on the screen, so Hangar used the recorded point.` };
      }
    }
    await this.act(p, leaseId, action);
    return { status: 'ok', by: step.by, note: null };
  }

  private async locate(p: Principal, leaseId: string, selector: ElementSelector, near: Point | null): Promise<Point | null> {
    for (let i = 0; i < LOCATE_TRIES; i++) {
      if (i > 0) {
        await sleep(LOCATE_DELAY_MS);
      }
      const node = findNode(nodesOf((await this.leases.op(p, leaseId, { op: 'describe' })).result), selector, near);
      if (node) {
        return center(node);
      }
    }
    return null;
  }

  private async act(p: Principal, leaseId: string, action: Action): Promise<void> {
    const { result } = await this.leases.op(p, leaseId, { op: 'actions', actions: [action] });
    const failed = actionFailure(result);
    if (failed !== null) {
      throw new Error(failed);
    }
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
    openAgainUrl: `${publicUrl}/v1/findings/${row.id}/open-again`,
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

export const ACTION_LIMIT = 1000;
const OPEN_AGAIN_WAIT_MS = 5 * 60_000;
// The longest pause kept between two replayed actions, so animations settle without replaying idle time.
export const REPLAY_PAUSE_MS = 2000;
const LOCATE_TRIES = 3;
const LOCATE_DELAY_MS = 500;
const TYPE_LIMIT = 2000;

type ReplayableOp = Extract<Op, { op: 'launch' | 'terminate' | 'openUrl' | 'permission' | 'location' | 'clearLocation' | 'appearance' | 'locale' | 'orientation' | 'gesture' }>;
const REPLAYABLE_OPS: ReplayableOp['op'][] = ['launch', 'terminate', 'openUrl', 'permission', 'location', 'clearLocation', 'appearance', 'locale', 'orientation', 'gesture'];

const NOT_REPLAYED: Partial<Record<Op['op'], string>> = {
  uninstall: 'Hangar does not uninstall apps again.',
  push: 'Hangar does not send push notifications again.',
  useMetro: 'Metro runs on your machine, so connect it again yourself.',
  jsEvaluate: 'Hangar does not run JavaScript again.',
  maestro: 'Hangar does not run tests again. Start a run for that.',
  xcuitest: 'Hangar does not run tests again. Start a run for that.',
  espresso: 'Hangar does not run tests again. Start a run for that.',
};

// One action a lease took, kept so a finding can replay it. `at` is when it started, in epoch milliseconds.
export type RecordedAction = { at: number; failed: string | null } & (
  | { kind: 'action'; action: Action; target: ElementSelector | null }
  | { kind: 'op'; op: ReplayableOp }
  | { kind: 'install'; sha256: string }
  | { kind: 'skip'; what: string; reason: string }
);

type StoredFindingData = FindingData & { actions: RecordedAction[]; actionsTruncated: boolean };

export type PlannedStep = { what: string; waitMs: number; by: OpenAgainBy | null; skip: string | null; action: RecordedAction };

function isReplayable(body: Op): body is ReplayableOp {
  return REPLAYABLE_OPS.some((op) => op === body.op);
}

// The actions one op took. `screen` is the screen the caller described just before, which names the element under a tapped point.
export function recordOp(body: Op, at: number, result: unknown, screen: UiNode[] | null): RecordedAction[] {
  if (body.op === 'actions') {
    const results = Array.isArray(result) ? result : [];
    return body.actions.map((action, i): RecordedAction => {
      const failed = failureOf(results[i]);
      if (action.type === 'type' && action.text.length > TYPE_LIMIT) {
        return { at, failed, kind: 'skip', what: `Type ${action.text.length} characters`, reason: `Hangar keeps typed text up to ${TYPE_LIMIT} characters.` };
      }
      const target = (action.type === 'tap' || action.type === 'longPress') && 'point' in action && screen ? targetAt(screen, action.point) : null;
      return { at, failed, kind: 'action', action, target };
    });
  }
  if (isReplayable(body)) {
    return [{ at, failed: null, kind: 'op', op: body }];
  }
  if (body.op === 'install') {
    return [{ at, failed: null, kind: 'install', sha256: body.sha256 }];
  }
  const reason = NOT_REPLAYED[body.op];
  return reason ? [{ at, failed: null, kind: 'skip', what: describeOp(body) ?? body.op, reason }] : [];
}

// What a replay does with each recorded action, and how long it waits before it.
export function planReplay(actions: RecordedAction[]): PlannedStep[] {
  return actions.map((action, i) => {
    const prev = actions[i - 1];
    const waitMs = prev ? Math.min(REPLAY_PAUSE_MS, Math.max(0, action.at - prev.at)) : 0;
    let skip: string | null = null;
    if (action.kind === 'skip') {
      skip = action.reason;
    } else if (action.failed !== null) {
      skip = `It failed on the original lease: ${action.failed}`;
    }
    return { what: describeRecorded(action), waitMs, by: plannedBy(action), skip, action };
  });
}

function plannedBy(a: RecordedAction): OpenAgainBy | null {
  if (a.kind === 'op') {
    return a.op.op === 'gesture' ? 'coordinates' : null;
  }
  if (a.kind !== 'action') {
    return null;
  }
  switch (a.action.type) {
    case 'tap':
    case 'longPress':
      return 'element' in a.action || a.target ? 'label' : 'coordinates';
    case 'swipe':
      return 'coordinates';
    default:
      return null;
  }
}

export function describeRecorded(a: RecordedAction): string {
  switch (a.kind) {
    case 'skip':
      return a.what;
    case 'install':
      return `Install the build ${a.sha256.slice(0, 12)}`;
    case 'op':
      return describeOp(a.op) ?? a.op.op;
    case 'action': {
      const name = a.target ? selectorName(a.target) : null;
      if (name && a.action.type === 'tap') {
        return `Tap "${name}"`;
      }
      if (name && a.action.type === 'longPress') {
        return `Long press "${name}"`;
      }
      if (a.action.type === 'waitFor') {
        return `Wait for "${selectorName(a.action.element)}"${a.action.gone ? ' to go' : ''}`;
      }
      return describeOp({ op: 'actions', actions: [a.action] }) ?? a.action.type;
    }
  }
}

export function selectorName(s: ElementSelector): string {
  return s.label ?? s.identifier ?? s.role ?? 'element';
}

function contains(n: UiNode, p: Point): boolean {
  const f = n.normalized;
  return p[0] >= f.x && p[0] <= f.x + f.width && p[1] >= f.y && p[1] <= f.y + f.height;
}

// The smallest named element under a point, as a selector, or null.
export function targetAt(nodes: UiNode[], p: Point): ElementSelector | null {
  let best: UiNode | null = null;
  for (const n of nodes) {
    if (n.role === 'application' || !(n.label || n.identifier) || !contains(n, p)) {
      continue;
    }
    if (!best || n.normalized.width * n.normalized.height < best.normalized.width * best.normalized.height) {
      best = n;
    }
  }
  if (!best) {
    return null;
  }
  const s: ElementSelector = {};
  if (best.label) {
    s.label = best.label;
  }
  if (best.identifier) {
    s.identifier = best.identifier;
  }
  return s;
}

// The element a selector names: exact matches first, then labels that contain it unless `exact`. The one nearest `near` wins a tie.
export function findNode(nodes: UiNode[], s: ElementSelector, near: Point | null): UiNode | null {
  const same = (a: string | null, b: string | undefined): boolean => b === undefined || a === b;
  const named = nodes.filter((n) => n.role !== 'application' && n.enabled !== false);
  let found = named.filter((n) => same(n.label, s.label) && same(n.identifier, s.identifier) && (s.role === undefined || n.role.toLowerCase().includes(s.role.toLowerCase())));
  const label = s.label?.toLowerCase();
  if (!found.length && !s.exact && label) {
    found = named.filter((n) => (n.label ?? '').toLowerCase().includes(label));
  }
  if (!near || found.length < 2) {
    return found[0] ?? null;
  }
  const distance = (n: UiNode): number => {
    const [x, y] = center(n);
    return (x - near[0]) ** 2 + (y - near[1]) ** 2;
  };
  return found.reduce((a, b) => (distance(b) < distance(a) ? b : a));
}

function center(n: UiNode): Point {
  return [n.normalized.x + n.normalized.width / 2, n.normalized.y + n.normalized.height / 2];
}

function withPoint(a: Extract<Action, { type: 'tap' | 'longPress' }>, point: Point): Action {
  return a.type === 'longPress' ? { type: 'longPress', point, ...(a.durationMs ? { durationMs: a.durationMs } : {}) } : { type: 'tap', point };
}

function failureOf(r: unknown): string | null {
  if (typeof r !== 'object' || r === null || !('ok' in r) || r.ok !== false) {
    return null;
  }
  const e = 'error' in r ? r.error : null;
  return typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string' ? e.message : 'failed';
}

function actionFailure(result: unknown): string | null {
  return Array.isArray(result) ? (result.map(failureOf).find((f) => f !== null) ?? null) : null;
}

// The elements in a describe result. Anything else gives none.
export function nodesOf(result: unknown): UiNode[] {
  const nodes = typeof result === 'object' && result !== null && 'nodes' in result && Array.isArray(result.nodes) ? result.nodes : [];
  return nodes.filter(isNode);
}

function isNode(v: unknown): v is UiNode {
  if (typeof v !== 'object' || v === null || !('role' in v) || typeof v.role !== 'string' || !('normalized' in v)) {
    return false;
  }
  const f = v.normalized;
  return typeof f === 'object' && f !== null && 'x' in f && typeof f.x === 'number' && 'y' in f && typeof f.y === 'number' && 'width' in f && typeof f.width === 'number' && 'height' in f && typeof f.height === 'number';
}

const KINDS = ['action', 'op', 'install', 'skip'];

function isRecordedAction(v: unknown): v is RecordedAction {
  return typeof v === 'object' && v !== null && 'at' in v && typeof v.at === 'number' && 'kind' in v && KINDS.some((k) => k === v.kind);
}

// The actions a finding kept. Findings filed before Hangar kept them have none.
export function storedActions(d: FindingData): { actions: RecordedAction[]; truncated: boolean } {
  const actions = 'actions' in d && Array.isArray(d.actions) ? d.actions.filter(isRecordedAction) : [];
  return { actions, truncated: 'actionsTruncated' in d && d.actionsTruncated === true };
}
