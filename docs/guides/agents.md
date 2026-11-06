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

Tools that act on a device take an optional `leaseId`; without it they use your only active
lease. A good loop is lease, observe, act, observe, and release at the end; a device left idle
for 5 minutes is released and wiped anyway.

## REST, for agents with their own tools

An agent framework without MCP can call the REST API with the same token, or use the TypeScript
client:

```ts
import { Hangar } from '@hangar/client';

const hangar = new Hangar({ url: process.env.HANGAR_URL!, token: process.env.HANGAR_TOKEN! });
await using lease = await hangar.lease({ model: 'iPhone 17' });
await lease.launch('com.example.app');
await lease.tap({ label: 'Sign in', role: 'button' });
const { nodes } = await lease.ui();
const png = await lease.screenshot();
```
