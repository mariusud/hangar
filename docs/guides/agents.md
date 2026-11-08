# Connect an AI agent

Agents use Hangar over MCP at `/mcp` (streamable HTTP, a bearer token) or over the REST API.
Make a token in the console on the Connect page; it shows the exact command with the token.

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

## The tools

| Tool | What it does |
|---|---|
| `lease_device`, `release_device`, `renew_lease`, `list_leases` | Get a fresh device, give it back. |
| `observe` | A screenshot (1000 px JPEG) and the elements on screen, each with a center point. |
| `act` | Taps (by element or point), swipes, typing, keys and buttons, waits, in one call. |
| `install_build`, `launch_app`, `terminate_app`, `open_url` | Apps and deep links. |
| `react_native` | Open the dev menu, or reload the bundle. |
| `send_push`, `set_permission`, `set_location`, `set_appearance`, `set_app_language` | Device presets. |
| `record` | Start or stop a recording. Stop returns a link with the video, the timeline of actions and the app log. |

Tools that act on a device take an optional `leaseId`; without it they use your only active
lease. A good loop is lease, observe, act, observe, and release at the end; a device left idle
for 5 minutes is released and wiped anyway.

## Agents written for mobile-mcp

The same endpoint also has mobile-mcp's tool names and arguments, so an agent or prompt written
for [mobile-mcp](https://github.com/mobile-next/mobile-mcp) works against the fleet. A `device`
is a lease id:

1. `mobile_allocate_remote_device` with `platform: "ios"` or `"android"` leases a fresh device
   and returns its id.
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
orientation, clipboard, folding and recording to a file are not there; use `record` instead.

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
