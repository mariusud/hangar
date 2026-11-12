# Night QA

A booking holds devices for your team on given days and hours, for the nightly suite and for
your own QA agents. CI keeps a floor of devices that a booking never takes, and a CI request can
take a booked device back with two minutes' notice. Agents file what they find with
`report_finding`, and in the morning `hangar night report` collects the night's findings, leases
and test runs.

Hangar holds the devices and keeps the record. It does not start your agent, and it makes no
calls outside your network: your own scheduler (a GitHub Actions cron, a CI job, a crontab)
starts the agent when the window opens and posts the report after it closes.
[examples/night-qa](../../examples/night-qa/) has a brief, the MCP settings and a GitHub Actions
workflow that do both.

Bookings, the floor, priorities, preemption, findings and nights are tested against a simulated
fleet and fake hosts. None of it has run through a whole night on a real Mac yet, and no finding
has been filed from a real simulator.

## Book devices

```bash
hangar book night --devices 4 --from 21:00 --to 06:00 --days mon-fri --image nightly
```

A booking has a name, a number of devices, the days and hours of its window, and optionally a
device image (`--image`), a model (`--model`), an OS (`--os`) or `--android`. `--days` takes
`mon-thu`, `mon,wed,fri`, `weekdays` or `daily` (the default). A window that ends before it
starts runs past midnight, and its days are the days it starts on, so the booking above runs
from Monday 21:00 to Saturday 06:00.

Times are in the broker's time zone: `HANGAR_TIME_ZONE` if it is set, otherwise the time zone of
the machine the broker runs on. `hangar bookings` prints the zone and every booking, with whether
its window is open and how many of its devices are leased. `GET /v1/bookings` returns the same.

A booking belongs to your team; an operator can book for another team with `--team`. Only people
on that team, or an operator, can remove it: `hangar book rm night`. Its leases end at once with
the reason `window_closed`.

While its window is open, a booking keeps free devices for itself, up to its count. Its leases
count against the team's quota like any other lease.

## The CI floor

Each Mac keeps a number of devices that bookings never count as theirs, 1 by default. Hangar
refuses a booking with `OVER_CAPACITY` if it and the bookings open at the same time on the same
kind of device would need more devices than the connected Macs have after their floors. The
message says how many there are.

An operator sees the floors with `GET /v1/ci-floors` and sets one per Mac:

```bash
curl -X PUT "$HANGAR_URL/v1/ci-floors/studio-mini" -H "Authorization: Bearer $HANGAR_TOKEN" \
  -H 'content-type: application/json' -d '{"floor": 2}'
```

`{"floor": null}` goes back to the default.

## Tokens for a booking

```bash
hangar connect night
```

This makes a token that leases only from the booking `night`, and only while its window is open.
It prints the MCP settings for an agent, the `claude mcp add` command, and a GitHub Actions
`schedule` that starts when the window opens, with the cron converted to UTC. GitHub reads cron in
UTC, so check it again after a daylight saving change.

A lease asked for before the window opens waits in the queue until it does. Run shards from a
booking token go before agent leases from it. The token is an agent token, so its leases end after
30 minutes without use and 8 hours at most, under the operator's caps (see
[How long a lease lasts](agents.md#how-long-a-lease-lasts)).

A booking token is an agent token and does not upload builds. Upload the app first with a CI
token from `hangar connect ci`, or put it in the booking's image.

## Priority and preemption

Every lease has a priority from its token: `ci` above `interactive` above `booked`.

- `ci` comes from `hangar connect ci`, or a token made with `"priority": "ci"`.
- `interactive` is every other token: the console, `hangar login`, `hangar connect claude`.
- `booked` comes from `hangar connect <booking>`.

The queue serves higher priorities first. When a `ci` request finds no free device, it can take
one a booking is keeping, and if every matching device is in use, Hangar picks a lease to end:
the lowest priority first, agent leases before run shards, and the newest first. That lease gets
a `lease_ending` event with the reason and the time, and ends two minutes later with the reason
`preempted`. If the device doesn't come to the request within a minute after that, it may end
another one. An `interactive` request never ends a booked lease; it waits.

At the end of a window, every lease from the booking gets `lease_ending` ten minutes early and
ends at the window's end with the reason `window_closed`. A booked lease never outlives its
window.

Preemption and window ends keep what the lease recorded: its recording, findings and logs are
saved as for any other ending. A run shard that was preempted runs its unfinished flows again on
another lease (see [Maestro](maestro.md#when-a-shard-is-preempted)).

### What the agent sees

The lease's `ending` field holds `{ "reason": "preempted" | "window_closed", "at": <ms> }` while
it is active and about to end. A client that follows `GET /v1/leases/:id/events` gets it as a
`lease_ending` event. Over MCP there is no push: `keepalive`, `list_leases` and the other lease
tools return the lease with its `ending`, so an agent that calls `keepalive` between tasks sees
it. When it does, the agent should file what it has and stop.

## The agent's tools

An agent with a booking token has the tools in [Connect an AI agent](agents.md#the-tools). The
ones that matter at night:

| Tool | Use at night |
|---|---|
| `bookings` | The bookings, the time zone, and the agent's own priority and booking. |
| `lease_device` | Waits for a device from the booking. Leave out `image` to get the booking's. |
| `keepalive` | Between tasks, so the lease doesn't end as idle, and to see `ending`. |
| `record` | Start a recording right after leasing, so a finding has video of what led up to it. |
| `app_log`, `js_console`, `network_requests` | What the app did. The JavaScript and network tools need the Metro tunnel that `hangar run` opens. Without it they answer `NO_METRO_TUNNEL`, so an agent on a Release build from an image has the app log only. |
| `report_finding` | File a bug. |
| `release_device` | At the end, or when `ending` shows up. |

### report_finding

`report_finding` takes a `title` (one line, at most 200 characters), a `description` (what the
agent did, what it expected and what happened, at most 10,000 characters), an optional
`severity` (`low`, `medium`, `high` or `critical`, default `medium`) and an optional `leaseId`.
The lease has to be active.

Hangar keeps with the finding:

- the last two minutes of the lease's recording, as a time span in the video, and the steps taken
  in those two minutes;
- the last 100 lines of the app log and the last 50 network requests;
- a screenshot taken when the finding is filed.

If the lease is not being recorded, Hangar starts a recording with the finding, so the video
shows what happens from the finding on, not what led up to it, and the finding says so in its
notes. Start a recording when the lease starts to avoid that.

The tool returns the finding's id and link. Over REST it is `POST /v1/leases/:id/findings` with
the same fields, and `GET /v1/findings/:id` reads one. A finding is visible to its team and to
operators.

A finding has an "open again" field, which replays its steps on a fresh lease. It is always
empty for now, and the report says so.

## Nights and the report

A night groups a booking's leases, findings and test runs. When a booking's window closes, Hangar
closes the night for it: the one someone opened, or a new one for the window if the booking had
leases. Its members are the leases made from the booking and the runs that used them.

You can also open and close one by hand, for example to collect a night for leases that don't
come from a booking:

```bash
hangar night open night      # findings filed by your team while it is open belong to it
hangar night close night
hangar night list --booking night
```

The report lists the findings by severity with their video span, screenshot, last steps and log
lines, then the test runs with failed and flaky flows, then the leases and how each ended. A
report of a night that is still open says that it can change.

```bash
hangar night report night                  # Markdown on standard output
hangar night report night --format json
hangar night report night --slack-webhook "$SLACK_WEBHOOK"
```

`night` is a booking name, which picks its newest night, or a night id. `--slack-webhook` takes
the https URL of a Slack incoming webhook and posts the Markdown report from the machine that
runs the command, with headings turned into bold lines. A report longer than Slack accepts is
cut, with a link to the whole report. The broker itself never posts it. Run the command from
the job your scheduler starts after the window closes; the token needs to be on the booking's
team. The API is `GET /v1/nights`, `GET /v1/nights/:id` and
`GET /v1/nights/:id/report?format=md|json`.
