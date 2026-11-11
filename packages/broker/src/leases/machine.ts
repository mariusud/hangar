
import type { DeviceClass, LeaseEndReason, LeaseEnding, LeaseState, Platform, Priority } from '@hangar/protocol';

export type Lease = {
  id: string;
  principalId: string;
  teamId: string;
  class: DeviceClass;
  state: LeaseState;
  reason: LeaseEndReason | null;
  deviceId: string | null;
  createdAt: number;
  preparedAt: number | null;
  activatedAt: number | null;
  lastRenewAt: number | null;
  lastActivityAt: number | null;
  endedAt: number | null;
  ttlMs: number;
  maxMs: number;
  idleMs: number;
  graceMs: number;
  detachedAt: number | null;
  tokenHash: string | null;
  queueTimeoutMs: number;
  prepareTimeoutMs: number;
  attempts: number;
  // Fields below came with bookings and priority; leases stored before them have none.
  priority?: Priority;
  bookingId?: string | null;
  // A lease a run made for one of its shards, which goes before agent leases inside a booking.
  shard?: boolean;
  // Set when the lease was told it ends early: preempted, or its booking's window closes.
  ending?: LeaseEnding | null;
  // A booked lease ends here at the latest, when its booking's window closes.
  windowEndsAt?: number | null;
  // The lease id the host knows the device by, when that is an earlier lease's (a held device).
  hostLeaseId?: string | null;
  // When this queued request last made another lease end early, so it waits for that device.
  preemptedAt?: number | null;
};

export type PoolDevice = {
  deviceId: string;
  model: string;
  os: string;
  build: string | null;
  platform?: Platform;
  image?: string;
};

export const DEFAULTS = {
  ttlMs: 10 * 60_000,
  maxMs: 4 * 60 * 60_000,
  idleMs: 5 * 60_000,
  graceMs: 60_000,
  queueTimeoutMs: 10 * 60_000,
  prepareTimeoutMs: 5 * 60_000,
  maxAttempts: 3,
} as const;

export class LeaseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function newLease(
  fields: Pick<Lease, 'id' | 'principalId' | 'teamId' | 'class'> & Partial<Lease>,
  now: number,
): Lease {
  return {
    state: 'queued',
    reason: null,
    deviceId: null,
    createdAt: now,
    preparedAt: null,
    activatedAt: null,
    lastRenewAt: null,
    lastActivityAt: null,
    endedAt: null,
    ttlMs: DEFAULTS.ttlMs,
    maxMs: DEFAULTS.maxMs,
    idleMs: DEFAULTS.idleMs,
    graceMs: DEFAULTS.graceMs,
    detachedAt: null,
    tokenHash: null,
    queueTimeoutMs: DEFAULTS.queueTimeoutMs,
    prepareTimeoutMs: DEFAULTS.prepareTimeoutMs,
    attempts: 0,
    ...fields,
  };
}

export function deadline(lease: Lease): { at: number; reason: LeaseEndReason } | null {
  if (lease.state !== 'active' || lease.activatedAt === null) {
    return null;
  }
  const renewed = lease.lastRenewAt ?? lease.activatedAt;
  const used = lease.lastActivityAt ?? lease.activatedAt;
  // A lease that lost its client is not idle until the grace period after the disconnect runs out.
  const detachedAt = lease.detachedAt ?? null;
  const graceEnd = detachedAt === null ? -Infinity : detachedAt + (lease.graceMs ?? DEFAULTS.graceMs);
  const candidates: { at: number; reason: LeaseEndReason }[] = [
    { at: renewed + lease.ttlMs, reason: 'expired' },
    { at: lease.activatedAt + lease.maxMs, reason: 'expired' },
    { at: Math.max(used + lease.idleMs, graceEnd), reason: 'idle' },
  ];
  if (lease.windowEndsAt) {
    candidates.push({ at: lease.windowEndsAt, reason: 'window_closed' });
  }
  if (lease.ending) {
    candidates.push({ at: lease.ending.at, reason: lease.ending.reason });
  }
  return candidates.reduce((a, b) => (b.at < a.at ? b : a));
}

export function matches(cls: DeviceClass, device: PoolDevice): boolean {
  if (cls.platform && cls.platform !== (device.platform ?? 'ios-simulator')) {
    return false;
  }
  if (cls.model && !looseEquals(cls.model, device.model)) {
    return false;
  }
  if (cls.os && !device.os.startsWith(cls.os)) {
    return false;
  }
  if (cls.build && cls.build !== device.build) {
    return false;
  }
  // A plain request never gets a device with someone's image on it, and the reverse.
  if ((cls.image?.toLowerCase() ?? null) !== (device.image?.toLowerCase() ?? null)) {
    return false;
  }
  return true;
}

function looseEquals(a: string, b: string): boolean {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return norm(a) === norm(b);
}

export function assign(lease: Lease, deviceId: string, now: number): Lease {
  if (lease.state !== 'queued') {
    throw new LeaseError('LEASE_NOT_QUEUED', `Lease ${lease.id} is ${lease.state}, not queued.`);
  }
  return { ...lease, state: 'preparing', deviceId, preparedAt: now, attempts: lease.attempts + 1 };
}

export function activate(lease: Lease, now: number): Lease {
  if (lease.state !== 'preparing') {
    throw new LeaseError('LEASE_NOT_PREPARING', `Lease ${lease.id} is ${lease.state}, not preparing.`);
  }
  return { ...lease, state: 'active', activatedAt: now, lastRenewAt: now, lastActivityAt: now };
}

export function prepareFailed(lease: Lease, now: number): Lease {
  if (lease.state !== 'preparing') {
    return lease;
  }
  if (lease.attempts >= DEFAULTS.maxAttempts) {
    return end(lease, 'failed', now);
  }
  return { ...lease, state: 'queued', deviceId: null, preparedAt: null };
}

export function renew(lease: Lease, now: number, ttlMs?: number): Lease {
  if (lease.state !== 'active') {
    throw new LeaseError('LEASE_NOT_ACTIVE', `Lease ${lease.id} is ${lease.state}. Only active leases can be renewed.`);
  }
  return { ...lease, lastRenewAt: now, lastActivityAt: now, ttlMs: ttlMs ?? lease.ttlMs };
}

export function touch(lease: Lease, now: number): Lease {
  if (lease.state !== 'active') {
    throw new LeaseError('LEASE_NOT_ACTIVE', `Lease ${lease.id} is ${lease.state}. Device actions need an active lease.`);
  }
  return { ...lease, lastActivityAt: now };
}

// Activity that doesn't touch the device: renews the lease and marks its client present.
export function keepalive(lease: Lease, now: number): Lease {
  if (lease.state !== 'active') {
    throw new LeaseError('LEASE_NOT_ACTIVE', `Lease ${lease.id} is ${lease.state}. Only active leases can be kept alive.`);
  }
  return { ...lease, lastRenewAt: now, lastActivityAt: now, detachedAt: null };
}

// Tells an active lease it ends early. An earlier notice stands.
export function warn(lease: Lease, ending: LeaseEnding): Lease {
  if (lease.state !== 'active' || (lease.ending && lease.ending.at <= ending.at)) {
    return lease;
  }
  return { ...lease, ending };
}

export function detach(lease: Lease, now: number): Lease {
  if (lease.state !== 'active') {
    return lease;
  }
  return { ...lease, detachedAt: now };
}

// A client that comes back to its lease. A lease still waiting for a device carries on waiting.
export function reattach(lease: Lease, now: number): Lease {
  if (lease.state === 'ended') {
    throw new LeaseError('LEASE_ENDED', `Lease ${lease.id} ended (${lease.reason ?? 'unknown'}).`);
  }
  if (lease.state !== 'active') {
    return lease;
  }
  return keepalive(lease, now);
}

export function end(lease: Lease, reason: LeaseEndReason, now: number): Lease {
  if (lease.state === 'ended') {
    return lease;
  }
  return { ...lease, state: 'ended', reason, endedAt: now };
}

export function due(leases: Lease[], now: number): { id: string; reason: LeaseEndReason }[] {
  const out: { id: string; reason: LeaseEndReason }[] = [];
  for (const lease of leases) {
    if (lease.state === 'queued' && now >= lease.createdAt + lease.queueTimeoutMs) {
      out.push({ id: lease.id, reason: 'queue_timeout' });
    } else if (lease.state === 'preparing' && lease.preparedAt !== null && now >= lease.preparedAt + lease.prepareTimeoutMs) {
      out.push({ id: lease.id, reason: 'failed' });
    } else if (lease.state === 'active') {
      const d = deadline(lease);
      if (d && now >= d.at) {
        out.push({ id: lease.id, reason: d.reason });
      }
    }
  }
  return out;
}

export type ScheduleInput = {
  queued: Lease[];
  ready: PoolDevice[];
  activeByTeam: Map<string, number>;
  activeByPrincipal: Map<string, number>;
  quotaByTeam: Map<string, number>;
};

export function schedule(input: ScheduleInput): { leaseId: string; deviceId: string }[] {
  const byTeam = new Map(input.activeByTeam);
  const byPrincipal = new Map(input.activeByPrincipal);
  const free = [...input.ready];
  const waiting = input.queued.filter((l) => l.state === 'queued');
  const out: { leaseId: string; deviceId: string }[] = [];

  while (waiting.length > 0 && free.length > 0) {
    const eligible = waiting.filter((l) => {
      const quota = input.quotaByTeam.get(l.teamId) ?? Infinity;
      return (byTeam.get(l.teamId) ?? 0) < quota && free.some((d) => matches(l.class, d));
    });
    if (eligible.length === 0) {
      break;
    }
    eligible.sort((a, b) => {
      const qa = input.quotaByTeam.get(a.teamId) ?? Infinity;
      const qb = input.quotaByTeam.get(b.teamId) ?? Infinity;
      const ua = (byTeam.get(a.teamId) ?? 0) / qa;
      const ub = (byTeam.get(b.teamId) ?? 0) / qb;
      if (ua !== ub) {
        return ua - ub;
      }
      const pa = byPrincipal.get(a.principalId) ?? 0;
      const pb = byPrincipal.get(b.principalId) ?? 0;
      if (pa !== pb) {
        return pa - pb;
      }
      return a.createdAt - b.createdAt;
    });
    const pick = eligible[0];
    if (!pick) {
      break;
    }
    const deviceIndex = free.findIndex((d) => matches(pick.class, d));
    const device = free[deviceIndex];
    if (!device) {
      break;
    }
    free.splice(deviceIndex, 1);
    waiting.splice(waiting.indexOf(pick), 1);
    byTeam.set(pick.teamId, (byTeam.get(pick.teamId) ?? 0) + 1);
    byPrincipal.set(pick.principalId, (byPrincipal.get(pick.principalId) ?? 0) + 1);
    out.push({ leaseId: pick.id, deviceId: device.deviceId });
  }
  return out;
}
