import { randomUUID } from 'node:crypto';
import type { Booking, BookingWindow, DeviceClass, Platform } from '@hangar/protocol';
import type { Principal } from '../auth.ts';
import type { Db } from '../db.ts';
import type { Hosts } from '../hosts.ts';
import { checkBooking, DEFAULT_CI_FLOOR, nextWindow, parseClock, parseDays, windowAt, type HostCapacity } from '../schedule.ts';
import { ApiError } from './service.ts';

export type BookingRequest = { name?: unknown; team?: unknown; devices?: unknown; image?: unknown; platform?: unknown; model?: unknown; os?: unknown; days?: unknown; from?: unknown; to?: unknown };

export type BookingView = Booking & { team: string; timeZone: string; open: BookingWindow | null; next: BookingWindow | null; leases: number };

export type FloorView = { host: string; floor: number; devices: number; connected: boolean };

/** What each connected Mac has for bookings: its devices, less quarantined ones, and its CI floor. */
export function hostCapacity(db: Db, hosts: Hosts): HostCapacity[] {
  const floors = db.ciFloors();
  return [...hosts.hosts.values()]
    .filter((h) => h.connected)
    .map((h) => ({
      name: h.name,
      floor: floors.get(h.name) ?? DEFAULT_CI_FLOOR,
      devices: h.devices
        .filter((d) => d.state !== 'quarantined')
        .map((d) => ({ deviceId: d.deviceId, model: d.model, os: d.os, build: null, platform: d.platform ?? 'ios-simulator', ...(d.image ? { image: d.image } : {}) })),
    }));
}

export function createBooking(db: Db, hosts: Hosts, p: Principal, req: BookingRequest, now: number): Booking {
  const name = typeof req.name === 'string' ? req.name.trim() : '';
  if (!/^[A-Za-z0-9][\w.-]{0,39}$/.test(name)) {
    throw new ApiError(400, 'BAD_NAME', 'Give the booking a `name` of letters, digits, dots, dashes or underscores, such as nightly-qa.');
  }
  if (db.bookings().some((b) => b.name.toLowerCase() === name.toLowerCase())) {
    throw new ApiError(409, 'BOOKING_EXISTS', `There is already a booking called ${name}.`, 'Pick another name, or remove that one first.');
  }
  const devices = Number(req.devices);
  if (!Number.isInteger(devices) || devices < 1 || devices > 100) {
    throw new ApiError(400, 'BAD_DEVICES', '`devices` is how many devices to hold, a whole number from 1.');
  }
  const days = typeof req.days === 'string' || Array.isArray(req.days) ? parseDays(req.days) : null;
  if (!days) {
    throw new ApiError(400, 'BAD_DAYS', '`days` names the days, such as "mon-thu", "mon,wed,fri", "weekdays" or "daily".');
  }
  const from = typeof req.from === 'string' ? parseClock(req.from) : null;
  const to = typeof req.to === 'string' ? parseClock(req.to) : null;
  if (from === null || to === null || from === to) {
    throw new ApiError(400, 'BAD_WINDOW', '`from` and `to` are times as HH:MM in the broker’s time zone, such as 18:00 and 07:00. A window that ends before it starts runs past midnight.');
  }
  const teamId = teamFor(db, p, req.team);
  const cls: DeviceClass = {};
  if (req.platform === 'ios-simulator' || req.platform === 'android-emulator') {
    const platform: Platform = req.platform;
    cls.platform = platform;
  }
  const keys: ('model' | 'os' | 'image')[] = ['model', 'os', 'image'];
  for (const key of keys) {
    const value = req[key];
    if (typeof value === 'string' && value.trim()) {
      cls[key] = value.trim();
    }
  }
  if (cls.image && !db.images().some((i) => i.name.toLowerCase() === cls.image?.toLowerCase())) {
    throw new ApiError(404, 'NO_SUCH_IMAGE', `No image called ${cls.image}.`, 'List images with `hangar images`, or book without --image.');
  }
  const booking: Booking = { id: randomUUID(), name, teamId, devices, class: cls, days, from: clock(from), to: clock(to), createdBy: p.accountId, createdAt: now };
  const check = checkBooking(booking, db.bookings(), hostCapacity(db, hosts));
  if (!check.ok) {
    throw new ApiError(409, 'OVER_CAPACITY', check.message, check.hint);
  }
  db.saveBooking(booking);
  db.audit(`booking.created ${name}`, p.accountId, null);
  return booking;
}

export function findBooking(db: Db, ref: string): Booking {
  const b = db.bookings().find((x) => x.id === ref || x.name.toLowerCase() === ref.toLowerCase());
  if (!b) {
    throw new ApiError(404, 'BOOKING_NOT_FOUND', `No booking called ${ref}.`, 'List bookings with `hangar bookings`.');
  }
  return b;
}

export function mayManage(db: Db, p: Principal, b: Booking): boolean {
  return p.role === 'operator' || db.teamOf(p.accountId) === b.teamId;
}

export function removeBooking(db: Db, p: Principal, ref: string): Booking {
  const b = findBooking(db, ref);
  if (!mayManage(db, p, b)) {
    throw new ApiError(403, 'FORBIDDEN', 'Only people on the booking’s team, or an operator, can remove it.');
  }
  db.removeBooking(b.id);
  db.audit(`booking.removed ${b.name}`, p.accountId, null);
  return b;
}

export function bookingView(db: Db, b: Booking, timeZone: string, now: number): BookingView {
  const leases = db.leasesIn(['preparing', 'active']).filter((l) => l.bookingId === b.id).length;
  const team = db.teams().find((t) => t.id === b.teamId)?.name ?? b.teamId;
  return { ...b, team, timeZone, open: windowAt(b, now, timeZone), next: nextWindow(b, now, timeZone), leases };
}

export function floors(db: Db, hosts: Hosts): FloorView[] {
  const set = db.ciFloors();
  const out: FloorView[] = [...hosts.hosts.values()].map((h) => ({ host: h.name, floor: set.get(h.name) ?? DEFAULT_CI_FLOOR, devices: h.devices.length, connected: h.connected }));
  for (const [host, floor] of set) {
    if (!out.some((f) => f.host === host)) {
      out.push({ host, floor, devices: 0, connected: false });
    }
  }
  return out.sort((a, b) => a.host.localeCompare(b.host));
}

function teamFor(db: Db, p: Principal, ref: unknown): string {
  const own = db.teamOf(p.accountId);
  if (ref === undefined || ref === null || ref === '') {
    return own;
  }
  const team = db.teams().find((t) => t.id === ref || t.name.toLowerCase() === String(ref).toLowerCase());
  if (!team) {
    throw new ApiError(404, 'NO_SUCH_TEAM', `No team ${String(ref)}.`);
  }
  if (team.id !== own && p.role !== 'operator') {
    throw new ApiError(403, 'FORBIDDEN', 'You can book for your own team; an operator can book for any team.');
  }
  return team.id;
}

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
