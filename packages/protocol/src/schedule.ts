import type { DeviceClass } from './index.ts';

/** Which leases go first: `ci` above `interactive` above `booked`. A lease takes its priority from its token. */
export type Priority = 'ci' | 'interactive' | 'booked';
export const PRIORITIES: Priority[] = ['ci', 'interactive', 'booked'];

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Devices of one class held for a team on given days, from `from` to `to` (HH:MM in the broker's time zone). */
export type Booking = {
  id: string;
  name: string;
  teamId: string;
  devices: number;
  class: DeviceClass;
  days: Weekday[];
  from: string;
  to: string;
  createdBy: string;
  createdAt: number;
};

/** One open window of a booking, in epoch milliseconds. */
export type BookingWindow = { bookingId: string; name: string; from: number; to: number };

/** Why and when a lease that was told it ends will end. */
export type LeaseEnding = { reason: 'preempted' | 'window_closed'; at: number };

/** A device a failed run flow left as it was, kept for people on the run's team until `until`. */
export type Hold = {
  deviceId: string;
  // The lease id the host knows the device by; the host wipes the device when that lease ends.
  hostLeaseId: string;
  runId: string;
  flow: string;
  teamId: string;
  until: number;
  leaseId: string | null;
};
