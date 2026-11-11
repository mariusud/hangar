# 0012. Bookings, priority and held devices

- **Status:** Accepted
- **Date:** 2026-11-11
- **Replaces:** [0011](0011-agent-device-for-inspection.md)

## Context

Hangar's scheduler is fair between teams and then between principals, and every active lease
ends at `min(lastRenew + ttl, activatedAt + max, lastActivity + idle)` with a fixed 5 minute
idle timeout. That fits a CI shard and a person in the console. It doesn't fit three newer uses:

- An agent hosted in the cloud holds a device for hours, goes quiet while it thinks, and
  reconnects after a restart. Five idle minutes end its lease and wipe its state.
- A team wants devices held overnight for its nightly suite and its own QA agents, without those
  agents starving the first pull requests in the morning.
- When a Maestro flow fails, the person looking at it wants the device the test left behind, not
  a wiped one.

Decision 0011 proposed running agent-device on a lease for logs, network and JavaScript. Its
runner takes 4 to 10 s to start and about 290 MB per device, and its proxy reaches the whole
daemon, which gets around the lease scoping. Hangar gets the app log from `simctl`, and
JavaScript, console and network from the Metro and Hermes inspector it already tunnels, with no
extra process per device.

## Decision

### Lease time

1. A token carries an idle limit and a longest-lease limit, both capped by the operator per role.
   Defaults stay as they are for tokens that don't set them. A lease may ask for less than its
   token allows, never more.
2. A lease that loses its client is not idle while its token's grace period runs (60 s by
   default). The client reattaches by lease id with the same token and carries on.
3. A `keepalive` call (API and MCP) counts as activity without touching the device.

### Bookings

4. A booking holds a number of devices of one class (usually an image) for a window on given days,
   in the broker's time zone. It belongs to a team and has a name.
5. Only tokens made for a booking (`hangar connect <booking>`) lease from it, and only while the
   window is open. A request that arrives early waits in the queue until the window opens.
6. CI keeps a floor: a number of devices per host that bookings never count as theirs. The floor
   and the bookings together may not exceed a host's capacity; the broker refuses a booking that
   would.

### Priority and preemption

7. Every lease has a priority, from its token: `ci` above `interactive` above `booked`. Inside a
   booking, `hangar run` shards come before agent leases.
8. When a higher-priority request can't be served and every matching device is busy, the
   scheduler picks the lowest-priority lease that matches, newest first, and sends it a
   `lease_ending` event with the reason. The lease ends two minutes later with reason
   `preempted`. An interrupted run shard reruns.
9. At the end of a window, leases from the booking get `lease_ending` ten minutes early and end
   with reason `window_closed`.
10. Preemption and window ends never drop what a lease recorded. The recording, findings and logs
    are kept as for any other ending.

### Held devices

11. A lease can end into a new device state, `held`, instead of `wiping`, when its run asked for
    it (`--hold`). A held device keeps its app state for the hold time, counts against its team's
    quota, and can be leased only by a person on that team, through the run's page. When the hold
    ends or that person's lease ends, the device is wiped as usual.

### Pure scheduler

12. Bookings, the floor, priorities and preemption are part of the pure scheduling function. It
    takes queued requests, devices, active leases with their priorities, bookings and the time,
    and returns assignments and preemptions. The property tests cover the invariants below.

## Invariants added

6. A device belongs to at most one booking at any moment.
7. A `ci` request that arrives while a booking's agents hold every device gets a device within
   two minutes and five seconds.
8. A booked lease never outlives its window.
9. A held device is wiped before anyone outside its run's team leases it.

## Consequences

- `LeaseEndReason` gains `preempted` and `window_closed`; the device state machine gains `held`.
- Tokens gain `idleMs`, `maxMs`, `priority` and an optional booking.
- The broker needs the time zone, which it takes from the host it runs on unless
  `HANGAR_TIME_ZONE` says otherwise.
- agent-device stays out of the agent. Making Hangar an agent-device provider plugin, so
  agent-device users can lease Hangar devices, is still possible and is in "Later".
