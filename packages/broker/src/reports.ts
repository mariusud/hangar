import { randomUUID } from 'node:crypto';
import { FINDING_SEVERITIES, type Finding, type FindingSeverity, type Night, type NightLease, type NightReport, type NightRun } from '@hangar/protocol';
import type { Principal } from './auth.ts';
import type { Db, NightRow } from './db.ts';
import { findingView } from './findings.ts';
import { ApiError } from './leases/service.ts';
import type { Lease } from './leases/machine.ts';
import type { Run } from './runs.ts';
import type { WindowClosed } from './schedule.ts';

const BOOKING_LIMIT = 80;

export const OPEN_AGAIN_NOTE =
  'Open again is not available yet. Each finding keeps the steps taken before it, so a later version of Hangar can replay them on a fresh lease of the same image and fill in the link.';

export function parseBooking(v: unknown): string {
  const booking = typeof v === 'string' ? v.trim() : '';
  if (!booking || booking.length > BOOKING_LIMIT || !/^[\w .:-]+$/.test(booking)) {
    throw new ApiError(400, 'BAD_BOOKING', `Send \`booking\`, a name of at most ${BOOKING_LIMIT} letters, digits, spaces, dots, colons, dashes or underscores, such as "nightly".`);
  }
  return booking;
}

export function openNight(db: Db, p: Principal, booking: string, now = Date.now()): NightRow {
  const teamId = db.teamOf(p.accountId);
  if (db.nights({ teamId, booking, state: 'open' }, 1).length) {
    throw new ApiError(409, 'NIGHT_OPEN', `The booking "${booking}" already has an open night.`, 'Close it with POST /v1/nights/:id/close first.');
  }
  const night: NightRow = {
    id: randomUUID(),
    teamId,
    booking,
    state: 'open',
    openedAt: now,
    closedAt: null,
    data: { openedBy: p.accountId, closedBy: null, leaseIds: null, runIds: null },
  };
  db.insertNight(night);
  db.audit(`night.opened.${booking}`, p.accountId, null);
  return night;
}

// Ends a night and keeps its members. The booking window's end calls this with the booking's own leases and
// runs; without them the night holds every lease of its team that was active in the window.
export function closeNight(db: Db, nightId: string, opts: { by?: string | null; leaseIds?: string[]; runIds?: string[]; now?: number } = {}): NightRow {
  const night = db.getNight(nightId);
  if (!night) {
    throw new ApiError(404, 'NIGHT_NOT_FOUND', `No night ${nightId}.`);
  }
  if (night.state === 'closed') {
    return night;
  }
  const closedAt = opts.now ?? Date.now();
  const window: NightRow = { ...night, closedAt, data: { ...night.data, leaseIds: opts.leaseIds ?? null, runIds: opts.runIds ?? null } };
  const members = nightMembers(window, db.teamLeasesActiveBetween(night.teamId, night.openedAt, closedAt), db.recentRuns(500), closedAt);
  const closed: NightRow = { ...window, state: 'closed', data: { ...window.data, closedBy: opts.by ?? null, leaseIds: members.leaseIds, runIds: members.runIds } };
  db.updateNight(closed);
  db.audit(`night.closed.${night.booking}`, opts.by ?? null, null);
  return closed;
}

// Which leases and runs belong to a night. Leases given at close win; otherwise the team's leases that were
// active at some point between the night's opening and its close (or `now`). Runs given at close win;
// otherwise the runs that used one of those leases.
export function nightMembers(night: NightRow, leases: Lease[], runs: Run[], now: number): { leaseIds: string[]; runIds: string[] } {
  const end = night.closedAt ?? now;
  const leaseIds =
    night.data.leaseIds ??
    leases
      .filter((l) => l.teamId === night.teamId && l.activatedAt !== null && l.activatedAt <= end && (l.endedAt ?? Number.POSITIVE_INFINITY) >= night.openedAt)
      .map((l) => l.id);
  const members = new Set(leaseIds);
  const runIds = night.data.runIds ?? runs.filter((r) => r.leaseIds.some((id) => members.has(id))).map((r) => r.id);
  return { leaseIds, runIds };
}

export function nightView(db: Db, n: NightRow, publicUrl: string): Night {
  const name = (id: string | null): string | null => (id ? (db.getAccount(id)?.name ?? 'unknown') : null);
  return {
    id: n.id,
    booking: n.booking,
    team: db.teams().find((t) => t.id === n.teamId)?.name ?? n.teamId,
    state: n.state,
    openedAt: n.openedAt,
    closedAt: n.closedAt,
    openedBy: name(n.data.openedBy) ?? 'unknown',
    closedBy: name(n.data.closedBy),
    url: `${publicUrl}/v1/nights/${n.id}/report?format=md`,
  };
}

export function nightLease(db: Db, l: Lease, publicUrl: string): NightLease {
  const rec = db.recordingOf(l.id, ['recording', 'saving', 'ready']);
  return {
    id: l.id,
    owner: db.getAccount(l.principalId)?.name ?? 'unknown',
    image: l.class.image ?? null,
    device: rec?.device ?? null,
    activatedAt: l.activatedAt,
    endedAt: l.endedAt,
    reason: l.reason,
    recording: rec ? `${publicUrl}/recordings/${rec.id}` : null,
  };
}

export function nightRun(r: Run, publicUrl: string): NightRun {
  const failed = r.flows.filter((f) => f.status === 'failed');
  return {
    id: r.id,
    state: r.state,
    url: `${publicUrl}/runs/${r.id}`,
    passed: r.flows.filter((f) => f.status === 'passed').length,
    flaky: r.flows.filter((f) => f.status === 'flaky').length,
    failed: failed.length,
    failures: failed.map((f) => ({ flow: f.flow, message: f.message ?? null, recording: f.recording ?? null })),
  };
}

export function nightDetails(db: Db, n: NightRow, publicUrl: string, now = Date.now()): { night: Night; leases: NightLease[]; findings: Finding[]; runs: NightRun[] } {
  const end = n.closedAt ?? now;
  const members = nightMembers(n, db.teamLeasesActiveBetween(n.teamId, n.openedAt, end), db.recentRuns(500), now);
  const leases = members.leaseIds.map((id) => db.getLease(id)).filter((l): l is Lease => l !== null);
  const leaseSet = new Set(members.leaseIds);
  const findings = db
    .findingsOf({ nightId: n.id, leaseIds: members.leaseIds })
    .filter((f) => f.nightId === n.id || (leaseSet.has(f.leaseId) && f.createdAt >= n.openedAt && f.createdAt <= end))
    .map((f) => findingView(db, f, publicUrl));
  const runs = members.runIds.map((id) => db.getRun(id)).filter((r): r is Run => r !== null);
  return { night: nightView(db, n, publicUrl), leases: leases.map((l) => nightLease(db, l, publicUrl)), findings, runs: runs.map((r) => nightRun(r, publicUrl)) };
}

export function buildReport(parts: { night: Night; leases: NightLease[]; findings: Finding[]; runs: NightRun[] }, now: number): NightReport {
  const bySeverity: Record<FindingSeverity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const f of parts.findings) {
    bySeverity[f.severity] += 1;
  }
  const rank = (s: FindingSeverity): number => FINDING_SEVERITIES.indexOf(s);
  const findings = [...parts.findings].sort((a, b) => rank(b.severity) - rank(a.severity) || a.createdAt - b.createdAt);
  const notes: string[] = [];
  if (parts.night.state === 'open') {
    notes.push('The night is still open, so this report can change.');
  }
  if (findings.some((f) => f.openAgainUrl === null)) {
    notes.push(OPEN_AGAIN_NOTE);
  }
  return {
    night: parts.night,
    generatedAt: now,
    summary: {
      leases: parts.leases.length,
      findings: findings.length,
      bySeverity,
      runs: parts.runs.length,
      failedFlows: parts.runs.reduce((n, r) => n + r.failed, 0),
      flakyFlows: parts.runs.reduce((n, r) => n + r.flaky, 0),
    },
    findings,
    leases: parts.leases,
    runs: parts.runs,
    notes,
  };
}

const STEP_LINES = 10;
const LOG_LINES = 10;

export function reportMarkdown(r: NightReport): string {
  const out: string[] = [];
  const s = r.summary;
  const when = `${iso(r.night.openedAt)} to ${r.night.closedAt === null ? 'now (still open)' : iso(r.night.closedAt)}`;
  out.push(`# ${r.night.booking}: night report`, '', `Team ${r.night.team}, ${when}.`, '');
  const severities = FINDING_SEVERITIES.filter((sev) => s.bySeverity[sev] > 0)
    .reverse()
    .map((sev) => `${s.bySeverity[sev]} ${sev}`);
  out.push(
    `- ${plural(s.findings, 'finding')}${severities.length ? ` (${severities.join(', ')})` : ''}`,
    `- ${plural(s.leases, 'lease')}`,
    `- ${plural(s.runs, 'test run')}, ${plural(s.failedFlows, 'failed flow')}, ${plural(s.flakyFlows, 'flaky flow')}`,
    '',
  );
  if (r.findings.length) {
    out.push('## Findings', '');
  }
  for (const f of r.findings) {
    out.push(`### [${f.severity}] ${oneLine(f.title)}`, '');
    out.push(`Filed by ${f.by} at ${iso(f.createdAt)}${f.device ? ` on ${f.device}` : ''}, lease ${f.leaseId}.`, '');
    if (f.description) {
      out.push(f.description, '');
    }
    if (f.video) {
      out.push(`- Video: ${f.video.video} (${span(f.video.fromMs)} to ${span(f.video.toMs)} of ${f.video.url})`);
    }
    if (f.screenshot) {
      out.push(`- Screenshot: ${f.screenshot}`);
    }
    for (const note of f.notes) {
      out.push(`- ${note}`);
    }
    if (f.steps.length) {
      out.push('', 'Steps before the finding:', '');
      for (const step of f.steps.slice(-STEP_LINES)) {
        out.push(`1. ${span(step.at)} ${oneLine(step.what)}${step.failed ? ` (failed: ${oneLine(step.failed)})` : ''}`);
      }
    }
    if (f.log.length) {
      out.push('', 'App log, last lines:', '', '```');
      for (const line of f.log.slice(-LOG_LINES)) {
        out.push(`${iso(line.time)} ${line.level} ${oneLine(line.message).replaceAll('```', "'''")}`);
      }
      out.push('```');
    }
    out.push('');
  }
  if (r.runs.length) {
    out.push('## Test runs', '');
    for (const run of r.runs) {
      out.push(`- ${run.url}: ${run.state}, ${run.passed} passed, ${run.flaky} flaky, ${run.failed} failed`);
      for (const f of run.failures) {
        out.push(`  - ${f.flow} failed${f.message ? `: ${oneLine(f.message).slice(0, 300)}` : ''}${f.recording ? ` (${f.recording})` : ''}`);
      }
    }
    out.push('');
  }
  if (r.leases.length) {
    out.push('## Leases', '');
    for (const l of r.leases) {
      const length = l.activatedAt !== null && l.endedAt !== null ? `, ${Math.round((l.endedAt - l.activatedAt) / 60_000)} min` : '';
      out.push(`- ${l.owner}${l.image ? `, image ${l.image}` : ''}${l.device ? `, ${l.device}` : ''}${length}, ${l.reason ? `ended: ${l.reason}` : 'still active'}${l.recording ? `, ${l.recording}` : ''}`);
    }
    out.push('');
  }
  for (const note of r.notes) {
    out.push(`_${note}_`, '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

function span(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// A booking window ended: close the night someone opened for it, or record one for the window. Its members are
// the leases made from that booking, and the runs that used them.
export function closeWindowNight(db: Db, w: WindowClosed): NightRow | null {
  const booking = db.bookings().find((b) => b.id === w.bookingId);
  const open = db.nights({ booking: w.name, state: 'open', teamId: booking?.teamId }, 1)[0];
  const teamId = booking?.teamId ?? open?.teamId;
  if (!teamId) {
    return null;
  }
  const leaseIds = db
    .teamLeasesActiveBetween(teamId, w.from, w.to)
    .filter((l) => l.bookingId === w.bookingId)
    .map((l) => l.id);
  if (!open && !leaseIds.length) {
    return null;
  }
  const night: NightRow = open ?? {
    id: randomUUID(),
    teamId,
    booking: w.name,
    state: 'open',
    openedAt: w.from,
    closedAt: null,
    data: { openedBy: 'schedule', closedBy: null, leaseIds: null, runIds: null },
  };
  if (!open) {
    db.insertNight(night);
  }
  const members = new Set(leaseIds);
  const runIds = db.recentRuns(500).filter((r) => r.leaseIds.some((id) => members.has(id))).map((r) => r.id);
  return closeNight(db, night.id, { by: null, leaseIds, runIds, now: w.to });
}
