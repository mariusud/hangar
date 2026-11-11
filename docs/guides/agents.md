# Connect an AI agent

Agents use Hangar over MCP at `/mcp` (streamable HTTP, a bearer token) or over the REST API.
The quickest way to give an agent its own token is `hangar connect`, run on a machine where you
are signed in with `hangar login`:

```bash
hangar connect claude    # adds Hangar to Claude Code, or prints the command if claude is not here
hangar connect cursor    # prints the .cursor/mcp.json block
hangar connect codex     # prints the block for ~/.codex/config.toml
hangar connect night     # a token that leases only from the booking "night", in its window
```

Each makes an agent token labelled with the target and this computer's name (see "How long a
lease lasts" below). You can also make a token in the console on the Connect page; it shows the
exact command with the token, but that token has the ordinary limits. A token for a booking is
described in [Night QA](night-qa.md#tokens-for-a-booking).

## Claude Code

```bash
claude mcp add --transport http hangar http://studio-mini.local:7420/mcp \
  --header "Authorization: Bearer hgr_member_..."
```

## Cursor

In `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "hangar": {
      "url": "http://studio-mini.local:7420/mcp",
      "headers": { "Authorization": "Bearer hgr_member_..." }
    }
  }
}
```

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.hangar]
url = "http://studio-mini.local:7420/mcp"
http_headers = { Authorization = "Bearer hgr_member_..." }
```

## The tools

| Tool | What it does |
|---|---|
| `lease_device`, `release_device`, `renew_lease`, `list_leases` | Get a fresh device, give it back. `lease_device` takes `idleSeconds` and `maxSeconds` to ask for less than the token allows. |
| `keepalive` | Count as activity without touching the device, for example while the agent thinks or waits for a build. |
| `reattach_lease` | Pick up a lease again by id after a restart, with the same token. |
| `observe` | A screenshot (1000 px JPEG) and the elements on screen, each with a center point. |
| `act` | Taps (by element or point), swipes, typing, keys and buttons, waits, in one call. |
| `install_build`, `launch_app`, `terminate_app`, `open_url` | Apps and deep links. |
| `react_native` | Open the dev menu, or reload the bundle. |
| `send_push`, `set_permission`, `set_location`, `set_appearance`, `set_app_language` | Device presets. |
| `record` | Start or stop a recording. Stop returns a link with the video, the timeline of actions, the app log and the network requests. |
| `report_finding` | File a bug with a title, a description and a severity. Hangar attaches the last two minutes of the recording, the steps, the app log, the network requests and a screenshot, and the finding goes into the night report. |
| `bookings` | The device bookings and whether their windows are open, the broker's time zone, and your token's priority and booking. |
| `app_log` | The app's own log lines, newest last. |
| `js_evaluate`, `js_console` | Evaluate a JavaScript expression in the React Native app, and read its console messages and uncaught exceptions. |
| `network_requests` | HTTP requests the React Native app made: method, URL, status, duration. |
| `set_orientation` | Rotate the device. Android emulators only; iOS simulators answer `UNSUPPORTED`. |

Tools that act on a device take an optional `leaseId`; without it they use your only active
lease. A good loop is lease, observe, act, observe, and release at the end.

## How long a lease lasts

A lease ends at the first of three limits: the idle limit (no device action or keepalive for
that long), the longest-lease limit (that long after it started), and, if it has one, a TTL
that renewing pushes back. Each token carries its own idle and longest-lease limits, and a lease
may ask for less than its token allows, never more. A request for more fails with
`LEASE_LIMIT` and says what the token allows.

| Token | Idle | Longest | TTL |
|---|---|---|---|
| Made in the console, or by `hangar login` | 5 minutes | 4 hours | 10 minutes, renewed by the client and CLI |
| Made by `hangar connect claude`, `cursor` or `codex` | 30 minutes | 8 hours | none |

Leases made over MCP have no TTL whatever the token, so they end only when idle or at the
longest-lease limit. `GET /v1/lease-limits` shows the limits your token gets and the caps per
role.

Operators cap what a token may carry, per role (`member`, `operator`, `agent`). The built-in
caps are 2 hours idle for all three, 12 hours longest for people and 8 hours for agents.
Change one with `PUT /v1/lease-limits/agent` and `{ "idleSeconds": 3600, "maxSeconds": 14400 }`;
a field set to `null` goes back to the built-in cap. A token's limits are checked against
today's cap each time it leases, so lowering a cap applies to tokens that already exist. A
token made with `POST /v1/tokens` takes `agent: true`, `idleSeconds`, `maxSeconds` and
`graceSeconds`, each held under the cap for its role.

An agent that will be quiet for a while calls `keepalive` (or `POST /v1/leases/:id/keepalive`,
or `hangar keepalive`). It counts as activity and renews the TTL, and it does not touch the
device.

## When a lease is about to end

A lease can be told it will end early: two minutes before a higher-priority request takes its
device (reason `preempted`), or ten minutes before its booking's window closes (reason
`window_closed`). The lease then has `ending: { "reason": ..., "at": <ms> }`. A client that
follows `GET /v1/leases/:id/events` gets a `lease_ending` event with the lease; MCP has no push,
so the lease tools (`keepalive`, `list_leases`, `renew_lease`) return the lease with `ending`
filled in. An agent that sees it should file what it found and release the device. What the
lease recorded is kept either way. [Night QA](night-qa.md#priority-and-preemption) has the rules.

## Reattach after a restart

An agent that restarts, or loses its connection, can pick its lease up again with
`reattach_lease` and the lease id (`list_leases` shows it), or `POST /v1/leases/:id/attach`, or
`hangar attach <lease-id>`. It has to use the same token that made the lease; another token of
the same person gets `WRONG_TOKEN`. Reattaching an active lease counts as activity. A lease that
ended can't be reattached.

A client that follows `GET /v1/leases/:id/events` holds the lease open while the stream is
connected. When the last such stream for a lease closes, the lease gets a grace period (60
seconds by default, the token's `graceSeconds` if set) during which it doesn't end as idle,
even if its idle time has run out. The idle limit applies again after that. MCP sessions don't
start a grace period; for them the idle limit is what counts.

## Logs, JavaScript and network

`app_log` (`GET /v1/leases/:id/log`) returns the app's own log lines: `log stream` filtered to
the app's installed bundle on iOS, with the last two minutes read back on the first call, and
`adb logcat` for the app's process on Android, which restarts when the app gets a new process.
The agent keeps the newest 2000 lines per app.

`js_evaluate` (`POST /v1/leases/:id/js`), `js_console` (`GET /v1/leases/:id/js/console`) and
`network_requests` (`GET /v1/leases/:id/network`) reach the app's JavaScript through Metro's
debugger, over the Metro tunnel that `hangar run ios` or `hangar run android` opens. Without
that tunnel they answer `NO_METRO_TUNNEL`. Console messages and requests are collected from the
first JavaScript call on the lease, so call one of these tools early. Network requests come from
the debugger's Network domain when the runtime has one; otherwise Hangar patches
`XMLHttpRequest` in the app, which also covers `fetch`. Request and response bodies are not
kept. The agent keeps the newest 500 console messages and 300 requests per lease.

The tools take `bundleId`; without it they use the last app installed or launched through
Hangar on the lease. `app_log`, `js_console` and `network_requests` return `next`: pass it as
`since` on the next call to get only newer entries. `dropped: true` means entries after `since`
fell out of the buffer. Everything is dropped when the lease ends.

These tools are tested against a fake Metro and fake log processes. They have not yet been run
against an app on a real leased simulator or emulator.

## Agents written for mobile-mcp

The same endpoint also has mobile-mcp's tool names and arguments, so an agent or prompt written
for [mobile-mcp](https://github.com/mobile-next/mobile-mcp) works against the fleet. A `device`
is a lease id:

1. `mobile_allocate_remote_device` with `platform: "ios"` or `"android"` leases a fresh device
   and returns its id. An optional `purpose`, such as "check the login flow", shows next to the
   device on the console's Fleet page. `lease_device` takes it too.
2. `mobile_list_elements_on_screen`, `mobile_click_on_screen_at_coordinates` (x and y, or a ref
   such as `@e1`), `mobile_double_tap_on_screen`, `mobile_long_press_on_screen_at_coordinates`,
   `mobile_swipe_on_screen`, `mobile_type_keys`, `mobile_press_button`, `mobile_take_screenshot`,
   `mobile_get_screen_size`, `mobile_launch_app`, `mobile_terminate_app`, `mobile_uninstall_app`,
   `mobile_open_url`, `mobile_set_location` and `mobile_list_available_devices` work as in
   mobile-mcp.
3. `mobile_release_remote_device` gives it back.

Coordinates are points on iOS and pixels on Android, the units the element list reports.
`mobile_install_app` takes a build registered on Hangar, by name or hash, because a path on the
agent's machine is not reachable from the fleet. mobile-mcp's tools for logs, crash reports,
orientation, clipboard, folding and recording to a file are not there under their names; use
`app_log`, `set_orientation` and `record` instead.

## REST, for agents with their own tools

An agent framework without MCP can call the REST API with the same token, or use the TypeScript
client:

```ts
import { Hangar } from 'hangar';

const hangar = new Hangar({ url: process.env.HANGAR_URL!, token: process.env.HANGAR_TOKEN! });
await using lease = await hangar.lease({ model: 'iPhone 17' });
await lease.launch('com.example.app');
await lease.tap({ label: 'Sign in', role: 'button' });
const { nodes } = await lease.ui();
const png = await lease.screenshot();
```
