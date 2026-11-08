// Ties the lease machine, the database and the hosts together. All clock reads happen here.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { DeviceClass, LeaseEndReason, Op, Platform } from '@hangar/protocol';
import type { Principal } from '../auth.ts';
import type { Db } from '../db.ts';
import type { Hosts } from '../hosts.ts';
import * as m from './machine.ts';

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
};

export class Leases {
  readonly events = new EventEmitter();
  private ticking = false;
  stopped = false;

  private db: Db;
  private hosts: Hosts;
  private now: () => number;

  constructor(db: Db, hosts: Hosts, now: () => number = Date.now) {
    this.db = db;
    this.hosts = hosts;
    this.now = now;
    this.events.setMaxListeners(0);
  }

  create(p: Principal, cls: DeviceClass, opts: { ttlSeconds?: number; maxSeconds?: number } = {}): m.Lease {
    const offers = this.hosts.offers();
    // A declared image is on offer from every iOS host at once; the lease queues while it builds.
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
        ...(opts.ttlSeconds ? { ttlMs: opts.ttlSeconds * 1000 } : {}),
        ...(opts.maxSeconds ? { maxMs: opts.maxSeconds * 1000 } : {}),
      },
      this.now(),
    );
    this.db.insertLease(lease);
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
    };
  }

  renew(p: Principal, id: string, ttlSeconds?: number): m.Lease {
    const lease = wrap(() => m.renew(this.get(p, id), this.now(), ttlSeconds ? ttlSeconds * 1000 : undefined));
    this.db.updateLease(lease);
    this.emit(lease);
    return lease;
  }

  release(p: Principal, id: string): m.Lease {
    return this.end(this.get(p, id), 'released', p.accountId);
  }

  // Runs one device op for the lease holder. The agent maps the lease to a device itself.
  async op(p: Principal, id: string, body: Op): Promise<{ result?: unknown; binary?: Buffer }> {
    const lease = wrap(() => m.touch(this.get(p, id), this.now()));
    this.db.updateLease(lease);
    const deviceId = lease.deviceId;
    if (!deviceId) {
      throw new ApiError(409, 'LEASE_NOT_ACTIVE', 'This lease has no device yet.');
    }
    const startedAt = this.now();
    // A recording's stop waits for the host to upload the video.
    const timeout = body.op === 'maestro' ? 31 * 60_000 : body.op === 'install' || body.op === 'recordStop' ? 300_000 : 60_000;
    const res = await this.hosts
      .request(deviceId, (rid) => ({ type: 'op', id: rid, leaseId: lease.id, body }), timeout)
      .catch((err: Error & { code?: string }) => {
        throw new ApiError(502, err.code ?? 'HOST_ERROR', err.message);
      });
    if (!res.ok) {
      throw new ApiError(422, res.error.code, res.error.message);
    }
    // Recordings keep a timeline of what was done.
    this.events.emit('op', lease.id, body, startedAt, res.result);
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
      this.hosts.notify(lease.deviceId, { type: 'lease.end', leaseId: lease.id });
    }
    this.emit(ended);
    void this.tick();
    return ended;
  }

  private emit(lease: m.Lease): void {
    this.events.emit(lease.id, lease);
    this.events.emit('any', lease);
  }

  // Ends what is due, then hands ready devices to queued leases. Safe to call often.
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

      const used = this.db.usedDeviceIds();
      const ready = this.hosts
        .devices()
        .filter((d) => d.connected && d.state === 'ready' && !used.has(d.deviceId))
        .map((d) => ({ deviceId: d.deviceId, model: d.model, os: d.os, build: null, platform: d.platform ?? 'ios-simulator', ...(d.image ? { image: d.image } : {}) }));
      const queued = this.db.leasesIn(['queued']);
      const active = this.db.leasesIn(['preparing', 'active']);
      const assignments = m.schedule({
        queued,
        ready,
        activeByTeam: countBy(active, (l) => l.teamId),
        activeByPrincipal: countBy(active, (l) => l.principalId),
        quotaByTeam: quotas(this.db),
      });
      for (const a of assignments) {
        const lease = queued.find((l) => l.id === a.leaseId);
        if (lease) {
          this.prepare(m.assign(lease, a.deviceId, now));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private prepare(lease: m.Lease): void {
    try {
      this.db.updateLease(lease);
    } catch {
      // The unique index refused it: the device is already held. Leave the lease queued.
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

function countBy<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    out.set(key(item), (out.get(key(item)) ?? 0) + 1);
  }
  return out;
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
