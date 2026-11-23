import { WEEKDAYS, type Booking, type BookingWindow, type DeviceClass, type Hold, type LeaseEnding, type Priority, type Weekday } from '@devicepool/protocol';
import { matches, type Lease, type PoolDevice } from './leases/machine.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const WEEK_MINUTES = 7 * 24 * 60;

export const PREEMPT_NOTICE_MS = 2 * MINUTE;
export const WINDOW_NOTICE_MS = 10 * MINUTE;
export const REPLACE_MS = MINUTE;
export const DEFAULT_CI_FLOOR = 1;
export const MAX_HOLD_MS = 4 * 60 * MINUTE;

const RANK: Record<Priority, number> = { ci: 0, interactive: 1, booked: 2 };

export function priorityOf(lease: Pick<Lease, 'priority'>): Priority {
  return lease.priority ?? 'interactive';
}

export function brokerTimeZone(env: Record<string, string | undefined>): string {
  const zone = env.DEVICEPOOL_TIME_ZONE?.trim();
  if (zone && validTimeZone(zone)) {
    return zone;
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function validTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const SHORT_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function localTime(now: number, timeZone: string): { day: number; minute: number } {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, f);
  }
  const parts = f.formatToParts(new Date(now));
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return { day: Math.max(0, SHORT_DAYS.indexOf(part('weekday'))), minute: Number(part('hour')) * 60 + Number(part('minute')) };
}

export function parseClock(value: string): number | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function parseDays(value: string | string[]): Weekday[] | null {
  const parts = (Array.isArray(value) ? value : value.split(',')).map((p) => String(p).trim().toLowerCase()).filter(Boolean);
  const out = new Set<Weekday>();
  for (const part of parts) {
    if (part === 'daily' || part === 'every day') {
      WEEKDAYS.forEach((d) => out.add(d));
      continue;
    }
    if (part === 'weekdays') {
      WEEKDAYS.slice(0, 5).forEach((d) => out.add(d));
      continue;
    }
    const [a, b] = part.split('-').map((s) => WEEKDAYS.findIndex((d) => d === s.trim().slice(0, 3)));
    if (a === undefined || a < 0 || (b !== undefined && b < 0)) {
      return null;
    }
    const last = b ?? a;
    for (let i = a; ; i = (i + 1) % 7) {
      out.add(weekday(i));
      if (i === last) {
        break;
      }
    }
  }
  return out.size ? WEEKDAYS.filter((d) => out.has(d)) : null;
}

function weekday(i: number): Weekday {
  return WEEKDAYS[((i % 7) + 7) % 7] ?? 'mon';
}

function span(b: Pick<Booking, 'from' | 'to'>): { from: number; minutes: number } {
  const from = parseClock(b.from) ?? 0;
  const to = parseClock(b.to) ?? 0;
  return { from, minutes: (to - from + 1440) % 1440 || 1440 };
}

export function windowAt(b: Booking, now: number, timeZone: string): BookingWindow | null {
  const { day, minute } = localTime(now, timeZone);
  const { from, minutes } = span(b);
  for (const back of [0, 1]) {
    if (!b.days.includes(weekday(day - back))) {
      continue;
    }
    const since = (minute + back * 1440 - from) * MINUTE + (now % MINUTE);
    if (since >= 0 && since < minutes * MINUTE) {
      const start = now - since;
      return { bookingId: b.id, name: b.name, from: start, to: start + minutes * MINUTE };
    }
  }
  return null;
}

export function nextWindow(b: Booking, now: number, timeZone: string): BookingWindow | null {
  const open = windowAt(b, now, timeZone);
  if (open) {
    return open;
  }
  const { day, minute } = localTime(now, timeZone);
  const { from, minutes } = span(b);
  const midnight = now - minute * MINUTE - (now % MINUTE);
  for (let d = 0; d <= 7; d++) {
    if (!b.days.includes(weekday(day + d))) {
      continue;
    }
    const start = midnight + d * DAY + from * MINUTE;
    if (start > now) {
      return { bookingId: b.id, name: b.name, from: start, to: start + minutes * MINUTE };
    }
  }
  return null;
}

function weekSpans(b: Booking): [number, number][] {
  const { from, minutes } = span(b);
  const out: [number, number][] = [];
  for (const d of b.days) {
    const start = WEEKDAYS.indexOf(d) * 1440 + from;
    const end = start + minutes;
    if (end <= WEEK_MINUTES) {
      out.push([start, end]);
    } else {
      out.push([start, WEEK_MINUTES], [0, end - WEEK_MINUTES]);
    }
  }
  return out;
}

export type HostCapacity = { name: string; devices: PoolDevice[]; floor: number };

function base(cls: DeviceClass): DeviceClass {
  const { image: _image, build: _build, ...rest } = cls;
  return cls.image && !rest.platform ? { ...rest, platform: 'ios-simulator' } : rest;
}

function plain(d: PoolDevice): PoolDevice {
  const { image: _image, ...rest } = d;
  return { ...rest, build: null };
}

export function bookable(cls: DeviceClass, hosts: HostCapacity[]): number {
  return hosts.reduce((sum, h) => sum + Math.max(0, h.devices.filter((d) => matches(base(cls), plain(d))).length - h.floor), 0);
}

export type BookingCheck = { ok: true } | { ok: false; message: string; hint: string };

export function checkBooking(b: Booking, others: Booking[], hosts: HostCapacity[]): BookingCheck {
  const capacity = bookable(b.class, hosts);
  const floor = hosts.reduce((s, h) => s + h.floor, 0);
  const hint = `The Macs have ${capacity} device${capacity === 1 ? '' : 's'} of that kind bookings may use, after the CI floor of ${floor}. Ask for fewer devices, another time, or ask an operator to lower the floor.`;
  if (b.devices > capacity) {
    return { ok: false, message: `${b.name} asks for ${b.devices} device${b.devices === 1 ? '' : 's'}; there ${capacity === 1 ? 'is' : 'are'} ${capacity}.`, hint };
  }
  const devices = hosts.flatMap((h) => h.devices.map(plain));
  const competing = others.filter((o) => o.id !== b.id && devices.some((d) => matches(base(o.class), d) && matches(base(b.class), d)));
  const spans = competing.map((o) => ({ o, spans: weekSpans(o) }));
  for (const [start, end] of weekSpans(b)) {
    const cuts = new Set([start, end]);
    for (const { spans: s } of spans) {
      for (const [a, z] of s) {
        if (a > start && a < end) {
          cuts.add(a);
        }
        if (z > start && z < end) {
          cuts.add(z);
        }
      }
    }
    const points = [...cuts].sort((x, y) => x - y);
    for (let i = 0; i + 1 < points.length; i++) {
      const mid = ((points[i] ?? 0) + (points[i + 1] ?? 0)) / 2;
      const open = spans.filter(({ spans: s }) => s.some(([a, z]) => a <= mid && mid < z)).map(({ o }) => o);
      const total = b.devices + open.reduce((sum, o) => sum + o.devices, 0);
      if (total > capacity) {
        return { ok: false, message: `${b.name} and ${open.map((o) => o.name).join(', ')} would need ${total} devices at the same time; there are ${capacity}.`, hint };
      }
    }
  }
  return { ok: true };
}

export type PlanDevice = PoolDevice & { hostId: string };

export type PlanInput = {
  now: number;
  timeZone: string;
  queued: Lease[];
  ready: PlanDevice[];
  returning: PlanDevice[];
  live: Lease[];
  devices: Map<string, PlanDevice>;
  hostSizes: Map<string, number>;
  floors: Map<string, number>;
  bookings: Booking[];
  holds: Hold[];
  quotaByTeam: Map<string, number>;
};

export type Assignment = { leaseId: string; deviceId: string; windowEndsAt: number | null };

export type Plan = {
  assignments: Assignment[];
  endings: { leaseId: string; ending: LeaseEnding }[];
  preempting: string[];
  open: BookingWindow[];
  reserved: Map<string, string>;
};

export function plan(input: PlanInput): Plan {
  const { now } = input;
  const open = new Map<string, BookingWindow>();
  for (const b of input.bookings) {
    const w = windowAt(b, now, input.timeZone);
    if (w) {
      open.set(b.id, w);
    }
  }

  const endings = new Map<string, LeaseEnding>();
  const tell = (leaseId: string, ending: LeaseEnding): void => {
    const before = endings.get(leaseId);
    if (!before || ending.at < before.at) {
      endings.set(leaseId, ending);
    }
  };
  for (const l of input.live) {
    if (!l.bookingId || l.state !== 'active') {
      continue;
    }
    const w = open.get(l.bookingId);
    const at = w ? w.to : now;
    if (now >= at - WINDOW_NOTICE_MS && !(l.ending && l.ending.at <= at)) {
      tell(l.id, { reason: 'window_closed', at });
    }
  }

  const perBooking = new Map<string, number>();
  const perHost = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, n = 1): void => void m.set(k, (m.get(k) ?? 0) + n);
  for (const l of input.live) {
    const host = l.deviceId ? input.devices.get(l.deviceId)?.hostId : undefined;
    if (l.bookingId && open.has(l.bookingId)) {
      add(perBooking, l.bookingId);
      if (host) {
        add(perHost, host);
      }
    }
  }
  const room = (hostId: string): number => (input.hostSizes.get(hostId) ?? 0) - (input.floors.get(hostId) ?? DEFAULT_CI_FLOOR) - (perHost.get(hostId) ?? 0);
  const reserved = new Map<string, string>();
  for (const b of [...input.bookings].filter((x) => open.has(x.id)).sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id))) {
    let need = b.devices - (perBooking.get(b.id) ?? 0);
    for (const d of input.ready) {
      if (need <= 0) {
        break;
      }
      if (!reserved.has(d.deviceId) && matches(b.class, d) && room(d.hostId) > 0) {
        reserved.set(d.deviceId, b.id);
        add(perHost, d.hostId);
        need -= 1;
      }
    }
  }

  const byTeam = new Map<string, number>();
  const byPrincipal = new Map<string, number>();
  for (const l of input.live) {
    add(byTeam, l.teamId);
    add(byPrincipal, l.principalId);
  }
  const liveIds = new Set(input.live.map((l) => l.id));
  for (const h of input.holds) {
    if (!h.leaseId || !liveIds.has(h.leaseId)) {
      add(byTeam, h.teamId);
    }
  }
  const quota = (teamId: string): number => input.quotaByTeam.get(teamId) ?? Infinity;
  const underQuota = (l: Lease): boolean => (byTeam.get(l.teamId) ?? 0) < quota(l.teamId);

  const free = [...input.ready];
  const deviceFor = (l: Lease): PlanDevice | undefined => {
    const p = priorityOf(l);
    if (p === 'booked') {
      const w = l.bookingId ? open.get(l.bookingId) : undefined;
      const b = input.bookings.find((x) => x.id === l.bookingId);
      if (!w || !b || now >= w.to || (perBooking.get(b.id) ?? 0) >= b.devices) {
        return undefined;
      }
      return free.find((d) => reserved.get(d.deviceId) === b.id && matches(l.class, d));
    }
    const unreserved = free.find((d) => !reserved.has(d.deviceId) && matches(l.class, d));
    if (unreserved || p !== 'ci') {
      return unreserved;
    }
    return free.find((d) => matches(l.class, d));
  };
  const before = (a: Lease, b: Lease): number => {
    const ra = RANK[priorityOf(a)];
    const rb = RANK[priorityOf(b)];
    if (ra !== rb) {
      return ra - rb;
    }
    if (priorityOf(a) === 'booked' && Boolean(a.shard) !== Boolean(b.shard)) {
      return a.shard ? -1 : 1;
    }
    const ua = (byTeam.get(a.teamId) ?? 0) / quota(a.teamId);
    const ub = (byTeam.get(b.teamId) ?? 0) / quota(b.teamId);
    if (ua !== ub) {
      return ua - ub;
    }
    const pa = byPrincipal.get(a.principalId) ?? 0;
    const pb = byPrincipal.get(b.principalId) ?? 0;
    if (pa !== pb) {
      return pa - pb;
    }
    return a.createdAt - b.createdAt;
  };

  const waiting = input.queued.filter((l) => l.state === 'queued');
  const assignments: Assignment[] = [];
  while (waiting.length > 0 && free.length > 0) {
    const eligible = waiting.filter((l) => underQuota(l) && deviceFor(l));
    if (eligible.length === 0) {
      break;
    }
    eligible.sort(before);
    const pick = eligible[0];
    const device = pick ? deviceFor(pick) : undefined;
    if (!pick || !device) {
      break;
    }
    free.splice(free.indexOf(device), 1);
    waiting.splice(waiting.indexOf(pick), 1);
    reserved.delete(device.deviceId);
    add(byTeam, pick.teamId);
    add(byPrincipal, pick.principalId);
    const w = pick.bookingId && priorityOf(pick) === 'booked' ? open.get(pick.bookingId) : undefined;
    if (w) {
      add(perBooking, w.bookingId);
    }
    assignments.push({ leaseId: pick.id, deviceId: device.deviceId, windowEndsAt: w ? w.to : null });
  }

  const claimed = new Set<string>();
  const preempting: string[] = [];
  const usable = (r: Lease, d: PlanDevice | undefined): boolean => Boolean(d && matches(r.class, d) && (priorityOf(r) === 'ci' || !reserved.has(d.deviceId)));
  for (const r of waiting.sort((a, b) => RANK[priorityOf(a)] - RANK[priorityOf(b)] || a.createdAt - b.createdAt)) {
    const p = priorityOf(r);
    if (p === 'booked' || !underQuota(r)) {
      continue;
    }
    const back = input.returning.find((d) => !claimed.has(`device:${d.deviceId}`) && usable(r, d));
    if (back) {
      claimed.add(`device:${back.deviceId}`);
      continue;
    }
    const soon = input.live.find((l) => {
      const at = endings.get(l.id)?.at ?? l.ending?.at;
      return at !== undefined && at <= now + PREEMPT_NOTICE_MS && !claimed.has(l.id) && usable(r, l.deviceId ? input.devices.get(l.deviceId) : undefined);
    });
    if (soon) {
      claimed.add(soon.id);
      continue;
    }
    if (r.preemptedAt && now < r.preemptedAt + PREEMPT_NOTICE_MS + REPLACE_MS) {
      continue;
    }
    const victims = input.live
      .filter((l) => l.state === 'active' && !claimed.has(l.id) && RANK[priorityOf(l)] > RANK[p] && (p === 'ci' || !l.bookingId))
      .filter((l) => usable(r, l.deviceId ? input.devices.get(l.deviceId) : undefined))
      .sort((a, b) => RANK[priorityOf(b)] - RANK[priorityOf(a)] || Number(Boolean(a.shard)) - Number(Boolean(b.shard)) || (b.activatedAt ?? b.createdAt) - (a.activatedAt ?? a.createdAt));
    const victim = victims[0];
    if (victim) {
      claimed.add(victim.id);
      tell(victim.id, { reason: 'preempted', at: now + PREEMPT_NOTICE_MS });
      preempting.push(r.id);
    }
  }

  return {
    assignments,
    endings: [...endings].map(([leaseId, ending]) => ({ leaseId, ending })),
    preempting,
    open: [...open.values()],
    reserved,
  };
}

export function holdsDue(holds: Hold[], now: number): Hold[] {
  return holds.filter((h) => now >= h.until);
}

export function mayTakeHold(hold: Hold, who: { teamId: string; person: boolean }): boolean {
  return who.person && who.teamId === hold.teamId;
}

export type WindowClosed = { bookingId: string; name: string; from: number; to: number };

export function closedWindows(before: BookingWindow[], open: BookingWindow[]): WindowClosed[] {
  return before.filter((w) => !open.some((o) => o.bookingId === w.bookingId && o.from === w.from)).map((w) => ({ bookingId: w.bookingId, name: w.name, from: w.from, to: w.to }));
}

const closedListeners = new Set<(w: WindowClosed) => void>();

export function onWindowClosed(cb: (w: WindowClosed) => void): () => void {
  closedListeners.add(cb);
  return () => void closedListeners.delete(cb);
}

export function windowClosed(w: WindowClosed): void {
  for (const cb of closedListeners) {
    try {
      cb(w);
    } catch (err) {
      console.error(`A window-closed listener failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
