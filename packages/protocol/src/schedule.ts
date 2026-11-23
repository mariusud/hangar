import type { DeviceClass } from './index.ts';

export type Priority = 'ci' | 'interactive' | 'booked';
export const PRIORITIES: Priority[] = ['ci', 'interactive', 'booked'];

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

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

export type BookingWindow = { bookingId: string; name: string; from: number; to: number };

export type LeaseEnding = { reason: 'preempted' | 'window_closed'; at: number };

export type Hold = {
  deviceId: string;
  hostLeaseId: string;
  runId: string;
  flow: string;
  teamId: string;
  until: number;
  leaseId: string | null;
};
