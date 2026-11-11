
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Booking, BookingWindow, DeviceClass, DeviceState, Hold, LeaseEndReason, LeaseEnding, LeaseLimits, Op, Platform, Priority } from '@hangar/protocol';
import type { Principal } from '../auth.ts';
import type { Db } from '../db.ts';
import type { Hosts } from '../hosts.ts';
import { brokerTimeZone, closedWindows, DEFAULT_CI_FLOOR, holdsDue, MAX_HOLD_MS, mayTakeHold, nextWindow, plan, windowClosed, type PlanDevice } from '../schedule.ts';
import { leaseLimits } from './limits.ts';
import * as m from './machine.ts';
import { limitsOf, priorityOf, seconds } from './tokens.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | undefined;
  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

const HOST_GRACE_MS = 60_000;

export type LeaseView = {
  id: string;
  state: m.Lease['state'];
  reason: LeaseEndReason | null;
  class: DeviceClass;
  device: { model: string; os: string; platform: Platform } | null;
  queuePosition: number | null;
  expiresAt: number | null;
  createdAt: number;
  owner: string;
  via: string | null;
  activity: string | null;
  activityAt: number | null;
  limits: LeaseLimits;
  detachedAt: number | null;
  priority: Priority;
  booking: string | null;
  // Set once the lease is told it ends early (preempted, or its booking's window closes).
  ending: LeaseEnding | null;
};

type Status = { via: string | null; activity: string | null; activityAt: number | null };

export function describeOp(o: Op): string | null {
  switch (o.op) {
    case 'actions': {
      const a = o.actions[o.actions.length - 1];
      if (!a) {
        return null;
      }
      if (a.type === 'tap' && 'element' in a) {
        const name = a.element.label ?? a.element.identifier ?? a.element.role;
        return name ? `Tapped “${name}”` : 'Tapped';
      }
      return { tap: 'Tapped', longPress: 'Long-pressed', swipe: 'Swiped', type: 'Typed text', key: 'Pressed a key', button: `Pressed ${'button' in a ? a.button : 'a button'}`, waitFor: 'Waited for the screen' }[a.type];
    }
    case 'install':
      return 'Installing an app';
    case 'launch':
      return `Opened ${o.bundleId}`;
    case 'openUrl':
      return `Opened ${o.url.slice(0, 60)}`;
    case 'maestro':
      return `Maestro: ${o.flows.map((f) => f.split('/').pop()).join(', ').slice(0, 60)}`;
    case 'xcuitest':
    case 'espresso':
      return `Running ${o.tests.length ? o.tests.join(', ').slice(0, 60) : 'tests'}`;
    case 'useMetro':
      return 'Connected to Metro';
    default:
      return null;
  }
}

export class Leases {
  readonly events = new EventEmitter();
  private ticking = false;
  stopped = false;

  private db: Db;
  private hosts: Hosts;
  private now: () => number;
  private status = new Map<string, Status>();
  private clients = new Map<string, number>();
  private openWindows: BookingWindow[] = [];
  readonly timeZone: string;

  constructor(db: Db, hosts: Hosts, now: () => number = Date.now, timeZone: string = brokerTimeZone(process.env)) {
    this.db = db;
    this.hosts = hosts;
    this.now = now;
    this.timeZone = timeZone;
    this.events.setMaxListeners(0);
  }

  create(p: Principal, asked: DeviceClass, opts: { ttlSeconds?: number | null; maxSeconds?: number; idleSeconds?: number; via?: string; shard?: boolean } = {}): m.Lease {
    const { priority, bookingId } = priorityOf(this.db, p);
    const booking = bookingId ? this.db.bookings().find((b) => b.id === bookingId) : undefined;
    if (bookingId && !booking) {
      throw new ApiError(410, 'BOOKING_GONE', 'The booking this token was made for no longer exists.', 'Make a new booking with `hangar book`, then a token for it with `hangar connect <booking>`.');
    }
    if (booking && asked.image && booking.class.image && asked.image.toLowerCase() !== booking.class.image.toLowerCase()) {
      throw new ApiError(400, 'NOT_IN_BOOKING', `This token leases from ${booking.name}, which holds image ${booking.class.image}, not ${asked.image}.`);
    }
    const cls: DeviceClass = booking ? { ...asked, ...booking.class } : asked;
    const idleMs = seconds(opts.idleSeconds, 'idleSeconds');
    const maxMs = seconds(opts.maxSeconds, 'maxSeconds');
    const ttlMs = opts.ttlSeconds === null ? null : seconds(opts.ttlSeconds, 'ttlSeconds');
    const resolved = leaseLimits(limitsOf(this.db, p), {
      ...(idleMs !== null ? { idleMs } : {}),
      ...(maxMs !== null ? { maxMs } : {}),
      ...(opts.ttlSeconds === null ? { ttlMs: null } : ttlMs !== null ? { ttlMs } : {}),
    });
    if (!resolved.ok) {
      const field = resolved.field === 'idle' ? 'idleSeconds' : 'maxSeconds';
      throw new ApiError(400, 'LEASE_LIMIT', `\`${field}\` is more than your token allows (${resolved.allowedMs / 1000} s).`, 'Ask for less, or ask an operator for a token with a longer limit.');
    }
    const offers = this.hosts.offers();
    const declared = this.db.images().find((i) => i.name.toLowerCase() === cls.image?.toLowerCase());
    if (declared) {
      for (const o of this.hosts.offers()) {
        if ((o.platform ?? 'ios-simulator') === 'ios-simulator' && !o.image) {
          offers.push({ ...o, image: declared.name });
        }
      }
    }
    if (offers.length === 0) {
      throw new ApiError(503, 'NO_DEVICES', 'No Mac with devices is connected.', 'Run `npx hangar up` on a Mac, or check `hangar status` on the Macs you have.');
    }
    if (!offers.some((o) => m.matches(cls, { deviceId: '', ...o, build: null }))) {
      const offered = [...new Set(offers.map((o) => `${o.model} (${o.platform === 'android-emulator' ? 'Android' : 'iOS'} ${o.os}${o.image ? `, image ${o.image}` : ''})`))].join(', ');
      throw new ApiError(404, 'NO_MATCHING_DEVICE', `No device matches ${describeClass(cls)}.`, `Devices on offer: ${offered}.`);
    }
    const lease = m.newLease(
      {
        id: randomUUID(),
        principalId: p.accountId,
        teamId: this.db.teamOf(p.accountId),
        class: cls,
        ttlMs: resolved.limits.ttlMs,
        maxMs: resolved.limits.maxMs,
        idleMs: resolved.limits.idleMs,
        graceMs: resolved.limits.graceMs,
        tokenHash: p.token?.hash ?? null,
        priority,
        bookingId: booking?.id ?? null,
        shard: opts.shard ?? false,
        queueTimeoutMs: this.queueTimeout(booking),
      },
      this.now(),
    );
    this.db.insertLease(lease);
    this.status.set(lease.id, { via: opts.via?.trim().slice(0, 80) || null, activity: null, activityAt: null });
    this.db.audit('lease.requested', p.accountId, lease.id);
    this.emit(lease);
    void this.tick();
    return lease;
  }

  get(p: Principal, id: string): m.Lease {
    const lease = this.db.getLease(id);
    // Someone else's lease looks the same as a missing one, so ids do not leak.
    if (!lease || (lease.principalId !== p.accountId && p.role !== 'operator')) {
      throw new ApiError(404, 'LEASE_NOT_FOUND', `No lease ${id}.`);
    }
    return lease;
  }

  view(lease: m.Lease): LeaseView {
    const device = lease.deviceId ? this.hosts.devices().find((d) => d.deviceId === lease.deviceId) : undefined;
    const queued = lease.state === 'queued' ? this.db.leasesIn(['queued']).sort((a, b) => a.createdAt - b.createdAt) : [];
    const owner = this.db.getAccount(lease.principalId)?.name ?? 'unknown';
    return {
      id: lease.id,
      state: lease.state,
      reason: lease.reason,
      class: lease.class,
      device: device ? { model: device.model, os: device.os, platform: device.platform ?? 'ios-simulator' } : null,
      queuePosition: lease.state === 'queued' ? queued.findIndex((l) => l.id === lease.id) + 1 : null,
      expiresAt: m.deadline(lease)?.at ?? null,
      createdAt: lease.createdAt,
      owner,
      limits: { idleMs: lease.idleMs, maxMs: lease.maxMs, ttlMs: lease.ttlMs, graceMs: lease.graceMs ?? m.DEFAULTS.graceMs },
      detachedAt: lease.detachedAt ?? null,
      priority: lease.priority ?? 'interactive',
      booking: lease.bookingId ? (this.db.bookings().find((b) => b.id === lease.bookingId)?.name ?? null) : null,
      ending: lease.state === 'active' ? (lease.ending ?? null) : null,
      ...(this.status.get(lease.id) ?? { via: null, activity: null, activityAt: null }),
    };
  }

  // A booked request that comes early waits for its window, and then as long as any other request.
  private queueTimeout(booking: Booking | undefined): number {
    const now = this.now();
    const next = booking ? nextWindow(booking, now, this.timeZone) : null;
    return next ? Math.max(m.DEFAULTS.queueTimeoutMs, next.from - now + m.DEFAULTS.queueTimeoutMs) : m.DEFAULTS.queueTimeoutMs;
  }

  /** The lease id the host knows a lease's device by. A lease on a held device uses the run lease's id. */
  hostLeaseId(lease: m.Lease): string {
    return lease.hostLeaseId ?? lease.id;
  }

  /** The device's state as the broker sees it: `held` while a failed run flow keeps it. */
  deviceState(deviceId: string, reported: DeviceState): DeviceState {
    return this.db.holds().some((h) => h.deviceId === deviceId) ? 'held' : reported;
  }

  holds(): Hold[] {
    return this.db.holds();
  }

  /** Ends a run's lease into a hold: the device keeps its state for `ms`, for people on the lease's team. */
  hold(p: Principal, id: string, info: { runId: string; flow: string; ms: number }): Hold {
    const lease = this.holder(p, id);
    if (lease.state !== 'active' || !lease.deviceId) {
      throw new ApiError(409, 'LEASE_NOT_ACTIVE', `Lease ${id} is ${lease.state}.`);
    }
    const now = this.now();
    const hold: Hold = {
      deviceId: lease.deviceId,
      hostLeaseId: this.hostLeaseId(lease),
      runId: info.runId,
      flow: info.flow,
      teamId: lease.teamId,
      until: now + Math.max(1000, Math.min(info.ms, MAX_HOLD_MS)),
      leaseId: null,
    };
    this.db.saveHold(hold);
    const ended = m.end(lease, 'released', now);
    this.db.updateLease(ended);
    this.db.audit('lease.ended.released.held', p.accountId, lease.id);
    this.emit(ended);
    return hold;
  }

  /** Leases the device a run flow left held, for a person on the run's team. */
  leaseHeld(p: Principal, runId: string, flow: string): m.Lease {
    const hold = this.db.holds().find((h) => h.runId === runId && h.flow === flow);
    if (!hold) {
      throw new ApiError(404, 'NOT_HELD', `No device is held for ${flow}.`, 'A run keeps the device of a failed flow when it was started with --hold.');
    }
    const person = !p.token || (!p.token.agent && priorityOf(this.db, p).priority !== 'booked');
    if (!mayTakeHold(hold, { teamId: this.db.teamOf(p.accountId), person })) {
      throw new ApiError(403, 'HOLD_FOR_TEAM', person ? 'Only people on the run’s team can lease its held device.' : 'A held device is for people, not agent or booking tokens.');
    }
    const current = hold.leaseId ? this.db.getLease(hold.leaseId) : null;
    if (current && current.state !== 'ended') {
      if (current.principalId === p.accountId) {
        return current;
      }
      throw new ApiError(409, 'HOLD_IN_USE', `${this.db.getAccount(current.principalId)?.name ?? 'Someone'} is on the held device.`);
    }
    const host = this.hosts.hostOf(hold.deviceId);
    if (!host?.connected) {
      throw new ApiError(503, 'HOST_DISCONNECTED', 'The Mac that holds this device is not connected right now.');
    }
    const resolved = leaseLimits(limitsOf(this.db, p), {});
    if (!resolved.ok) {
      throw new ApiError(400, 'LEASE_LIMIT', 'Your token allows no lease.');
    }
    const now = this.now();
    const maxMs = Math.max(1000, Math.min(resolved.limits.maxMs, hold.until - now));
    const run = this.db.getLease(hold.hostLeaseId);
    const fresh = m.newLease(
      {
        id: randomUUID(),
        principalId: p.accountId,
        teamId: hold.teamId,
        class: run?.class ?? {},
        ttlMs: Math.min(resolved.limits.ttlMs, maxMs),
        maxMs,
        idleMs: resolved.limits.idleMs,
        graceMs: resolved.limits.graceMs,
        tokenHash: p.token?.hash ?? null,
        hostLeaseId: hold.hostLeaseId,
      },
      now,
    );
    const lease = m.activate(m.assign(fresh, hold.deviceId, now), now);
    this.db.insertLease(lease);
    this.db.saveHold({ ...hold, leaseId: lease.id });
    this.status.set(lease.id, { via: `Held device of ${flow}`, activity: null, activityAt: null });
    this.db.audit('lease.held', p.accountId, lease.id);
    this.emit(lease);
    return lease;
  }

  /** Lets a held device go now: it is wiped and goes back to the pool. */
  releaseHold(p: Principal, runId: string, flow: string): void {
    const hold = this.db.holds().find((h) => h.runId === runId && h.flow === flow);
    if (!hold) {
      return;
    }
    if (p.role !== 'operator' && this.db.teamOf(p.accountId) !== hold.teamId) {
      throw new ApiError(403, 'HOLD_FOR_TEAM', 'Only people on the run’s team can let its held device go.');
    }
    this.wipeHold(hold, 'released', p.accountId);
  }

  private wipeHold(hold: Hold, reason: LeaseEndReason, by: string | null): void {
    const lease = hold.leaseId ? this.db.getLease(hold.leaseId) : null;
    if (lease && lease.state !== 'ended') {
      this.end(lease, reason, by);
      return;
    }
    this.db.removeHold(hold.deviceId);
    this.db.audit('hold.wiped', by, hold.hostLeaseId);
    this.hosts.notify(hold.deviceId, { type: 'lease.end', leaseId: hold.hostLeaseId });
  }

  renew(p: Principal, id: string, ttlSeconds?: number): m.Lease {
    const lease = wrap(() => m.renew(this.get(p, id), this.now(), ttlSeconds ? ttlSeconds * 1000 : undefined));
    this.db.updateLease(lease);
    this.emit(lease);
    return lease;
  }

  keepalive(p: Principal, id: string): m.Lease {
    const lease = this.holder(p, id);
    const next = wrap(() => m.keepalive(lease, this.now()));
    this.db.updateLease(next);
    this.emit(next);
    return next;
  }

  // The same token that made the lease picks it up again after its client restarted or lost the connection.
  reattach(p: Principal, id: string): m.Lease {
    const lease = this.holder(p, id);
    if (lease.tokenHash && lease.tokenHash !== p.token?.hash) {
      throw new ApiError(403, 'WRONG_TOKEN', 'This lease was made with another token.', 'Reattach with the token that made the lease.');
    }
    const next = wrap(() => m.reattach(lease, this.now()));
    if (next !== lease) {
      this.db.updateLease(next);
      this.db.audit('lease.reattached', p.accountId, lease.id);
      this.emit(next);
    }
    return next;
  }

  // A client of the lease holder that stays connected, such as an event stream. When the last one goes, the
  // lease's grace period starts. Returns the function to call on disconnect.
  connected(p: Principal, id: string): () => void {
    const lease = this.db.getLease(id);
    if (!lease || lease.principalId !== p.accountId) {
      return () => {};
    }
    this.clients.set(id, (this.clients.get(id) ?? 0) + 1);
    let gone = false;
    return () => {
      if (gone) {
        return;
      }
      gone = true;
      const left = (this.clients.get(id) ?? 1) - 1;
      if (left > 0) {
        this.clients.set(id, left);
        return;
      }
      this.clients.delete(id);
      const current = this.db.getLease(id);
      if (current?.state === 'active') {
        const next = m.detach(current, this.now());
        this.db.updateLease(next);
        this.emit(next);
      }
    };
  }

  private holder(p: Principal, id: string): m.Lease {
    const lease = this.get(p, id);
    if (lease.principalId !== p.accountId) {
      throw new ApiError(403, 'NOT_HOLDER', 'Only the lease holder can do this.');
    }
    return lease;
  }

  release(p: Principal, id: string): m.Lease {
    return this.end(this.get(p, id), 'released', p.accountId);
  }

  async op(p: Principal, id: string, body: Op): Promise<{ result?: unknown; binary?: Buffer }> {
    const found = this.get(p, id);
    const isHolder = found.principalId === p.accountId;
    const lease = isHolder ? wrap(() => m.touch(found, this.now())) : found;
    if (isHolder) {
      this.db.updateLease(lease);
    }
    const deviceId = lease.deviceId;
    if (!deviceId) {
      throw new ApiError(409, 'LEASE_NOT_ACTIVE', 'This lease has no device yet.');
    }
    const startedAt = this.now();
    const activity = isHolder ? describeOp(body) : null;
    const status = this.status.get(lease.id);
    if (activity && status) {
      status.activity = activity;
      status.activityAt = startedAt;
    }
    const timeout = body.op === 'maestro' ? 31 * 60_000 : body.op === 'install' || body.op === 'recordStop' ? 300_000 : 60_000;
    const res = await this.hosts
      .request(deviceId, (rid) => ({ type: 'op', id: rid, leaseId: this.hostLeaseId(lease), body }), timeout)
      .catch((err: Error & { code?: string }) => {
        throw new ApiError(502, err.code ?? 'HOST_ERROR', err.message);
      });
    if (!res.ok) {
      throw new ApiError(422, res.error.code, res.error.message);
    }
    if (isHolder) {
      this.events.emit('op', lease.id, body, startedAt, res.result);
    }
    return { result: res.result, ...(res.binary ? { binary: Buffer.from(res.binary, 'base64') } : {}) };
  }

  deviceOf(p: Principal, id: string): string {
    const lease = this.get(p, id);
    if (lease.state !== 'active' || !lease.deviceId) {
      throw new ApiError(409, 'LEASE_NOT_ACTIVE', `Lease ${id} is ${lease.state}.`);
    }
    return lease.deviceId;
  }

  private end(lease: m.Lease, reason: LeaseEndReason, by: string | null): m.Lease {
    const ended = m.end(lease, reason, this.now());
    if (ended === lease) {
      return lease;
    }
    this.db.updateLease(ended);
    this.db.audit(`lease.ended.${reason}`, by, lease.id);
    if (lease.deviceId) {
      const hold = this.db.holds().find((h) => h.leaseId === lease.id);
      if (hold) {
        this.db.removeHold(hold.deviceId);
      }
      this.hosts.notify(lease.deviceId, { type: 'lease.end', leaseId: this.hostLeaseId(lease) });
    }
    this.emit(ended);
    void this.tick();
    return ended;
  }

  private emit(lease: m.Lease): void {
    if (lease.state === 'ended') {
      this.status.delete(lease.id);
      this.clients.delete(lease.id);
    }
    this.events.emit(lease.id, lease);
    this.events.emit('any', lease);
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) {
      return;
    }
    this.ticking = true;
    try {
      const now = this.now();
      const live = this.db.leasesIn(['queued', 'preparing', 'active']);
      for (const d of m.due(live, now)) {
        const lease = live.find((l) => l.id === d.id);
        if (lease) {
          this.end(lease, d.reason, null);
        }
      }
      for (const lease of this.db.leasesIn(['preparing', 'active'])) {
        const host = lease.deviceId ? this.hosts.hostOf(lease.deviceId) : null;
        if (!host || (!host.connected && host.lostAt !== null && now - host.lostAt > HOST_GRACE_MS)) {
          this.end(lease, 'device_lost', null);
        }
      }

      this.sweepHolds(now);

      const used = this.db.usedDeviceIds();
      const all = this.hosts.devices().filter((d) => d.connected);
      const asPool = (d: (typeof all)[number]): PlanDevice => ({ deviceId: d.deviceId, model: d.model, os: d.os, build: null, platform: d.platform ?? 'ios-simulator', hostId: d.hostId, ...(d.image ? { image: d.image } : {}) });
      const queued = this.db.leasesIn(['queued']);
      const current = this.db.leasesIn(['preparing', 'active']);
      const holds = this.db.holds();
      const liveDevices = new Set(current.map((l) => l.deviceId));
      const heldDevices = new Set(holds.map((h) => h.deviceId));
      const floors = this.db.ciFloors();
      const hostSizes = new Map<string, number>();
      for (const d of all) {
        if (d.state !== 'quarantined') {
          hostSizes.set(d.hostId, (hostSizes.get(d.hostId) ?? 0) + 1);
        }
      }
      const result = plan({
        now,
        timeZone: this.timeZone,
        queued,
        ready: all.filter((d) => d.state === 'ready' && !used.has(d.deviceId)).map(asPool),
        returning: all.filter((d) => (d.state === 'busy' || d.state === 'wiping') && !liveDevices.has(d.deviceId) && !heldDevices.has(d.deviceId)).map(asPool),
        live: current,
        devices: new Map(all.filter((d) => liveDevices.has(d.deviceId)).map((d) => [d.deviceId, asPool(d)])),
        hostSizes,
        floors: new Map([...this.hosts.hosts.values()].map((h) => [h.id, floors.get(h.name) ?? DEFAULT_CI_FLOOR])),
        bookings: this.db.bookings(),
        holds,
        quotaByTeam: quotas(this.db),
      });
      for (const e of result.endings) {
        const lease = current.find((l) => l.id === e.leaseId);
        const next = lease ? m.warn(lease, e.ending) : undefined;
        if (lease && next && next !== lease) {
          this.db.updateLease(next);
          this.db.audit(`lease.ending.${e.ending.reason}`, null, lease.id);
          this.emit(next);
          this.events.emit('ending', next);
        }
      }
      for (const id of result.preempting) {
        const lease = queued.find((l) => l.id === id);
        if (lease) {
          this.db.updateLease({ ...lease, preemptedAt: now });
        }
      }
      for (const a of result.assignments) {
        const lease = queued.find((l) => l.id === a.leaseId);
        if (lease) {
          this.prepare({ ...m.assign(lease, a.deviceId, now), windowEndsAt: a.windowEndsAt, preemptedAt: null });
        }
      }
      for (const w of closedWindows(this.openWindows, result.open)) {
        this.db.audit(`booking.window_closed ${w.name}`, null, null);
        windowClosed(w);
      }
      this.openWindows = result.open;
    } finally {
      this.ticking = false;
    }
  }

  // Wipes holds whose time is up, and forgets holds whose device its Mac no longer has.
  private sweepHolds(now: number): void {
    for (const hold of holdsDue(this.db.holds(), now)) {
      this.wipeHold(hold, 'expired', null);
    }
    for (const hold of this.db.holds()) {
      const host = this.hosts.hostOf(hold.deviceId);
      if (!host || (!host.connected && host.lostAt !== null && now - host.lostAt > HOST_GRACE_MS)) {
        const lease = hold.leaseId ? this.db.getLease(hold.leaseId) : null;
        if (lease && lease.state !== 'ended') {
          this.end(lease, 'device_lost', null);
        }
        this.db.removeHold(hold.deviceId);
      }
    }
  }

  private prepare(lease: m.Lease): void {
    try {
      this.db.updateLease(lease);
    } catch {
      return;
    }
    this.emit(lease);
    const deviceId = lease.deviceId;
    if (!deviceId) {
      return;
    }
    this.hosts
      .request(deviceId, (id) => ({ type: 'lease.prepare', id, leaseId: lease.id, deviceId, deadline: lease.createdAt + lease.maxMs }), lease.prepareTimeoutMs)
      .then((res) => {
        const current = this.db.getLease(lease.id);
        if (!current || current.state !== 'preparing') {
          return;
        }
        const next = res.ok ? m.activate(current, this.now()) : m.prepareFailed(current, this.now());
        this.db.updateLease(next);
        this.db.audit(res.ok ? 'lease.active' : 'lease.prepare_failed', null, lease.id);
        this.emit(next);
        if (!res.ok) {
          void this.tick();
        }
      })
      .catch(() => {
        const current = this.db.getLease(lease.id);
        if (current?.state === 'preparing') {
          const next = m.prepareFailed(current, this.now());
          this.db.updateLease(next);
          this.emit(next);
        }
      });
  }
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof m.LeaseError) {
      throw new ApiError(409, err.code, err.message);
    }
    throw err;
  }
}

function quotas(db: Db): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of db.teams()) {
    if (t.quota !== null) {
      out.set(t.id, t.quota);
    }
  }
  return out;
}

export function describeClass(cls: DeviceClass): string {
  const system = cls.platform === 'android-emulator' ? 'Android' : 'iOS';
  const kind = cls.platform && !cls.model && !cls.os ? (cls.platform === 'android-emulator' ? 'an Android emulator' : 'an iOS simulator') : null;
  const parts = [kind, cls.model, cls.os && `${system} ${cls.os}`, cls.build && `with ${cls.build}`, cls.image && `image ${cls.image}`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'any device';
}
