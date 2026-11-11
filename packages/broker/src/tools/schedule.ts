import { bookingView } from '../leases/bookings.ts';
import { priorityOf } from '../leases/tokens.ts';
import type { ToolDeps } from './util.ts';

export function registerScheduleTools({ server, p, db, leases, safe, text }: ToolDeps): void {
  server.registerTool(
    'bookings',
    {
      description:
        'The device bookings: how many devices each holds, on which days and hours (in the broker time zone), and whether its window is open. A token made for a booking leases only from it, only while the window is open; a lease_device call before then waits. Booked leases are told 10 minutes before the window closes (the lease shows `ending`).',
      inputSchema: {},
    },
    () =>
      safe(async () => {
        const now = Date.now();
        const mine = priorityOf(db, p);
        return text({
          timeZone: leases.timeZone,
          yourPriority: mine.priority,
          yourBooking: mine.bookingId ? (db.bookings().find((b) => b.id === mine.bookingId)?.name ?? null) : null,
          bookings: db.bookings().map((b) => bookingView(db, b, leases.timeZone, now)),
        });
      }),
  );
}
