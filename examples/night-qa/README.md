# night-qa

A night of QA with your own agent on devices from a Hangar booking: a brief for the agent, the
MCP settings it connects with, and a GitHub Actions workflow that starts it when the window opens
and posts the report after the window closes. Hangar holds the devices and keeps the record; it
does not start the agent and makes no calls outside your network. The
[Night QA guide](../../docs/guides/night-qa.md) explains bookings, priorities and the report.

| File | What it is |
|---|---|
| `brief.md` | The agent's prompt: what shipped, which screens to test hard, what counts as a bug, how to work the device and how to call `report_finding`. Edit the sections marked EDIT. |
| `hangar.json` | MCP settings for the `hangar` server, with the address and token read from `HANGAR_URL` and `HANGAR_TOKEN` in the environment. |
| `night-qa.yml` | A workflow with two jobs: `agent` at 21:00 UTC, and `report` at 06:15 UTC, which runs `hangar night report night --slack-webhook`. |

## Set it up

1. Make a device image with the app and a signed-in test user
   ([device images](../../docs/guides/device-images.md)), and book devices with it:

   ```bash
   hangar book night --devices 4 --from 21:00 --to 06:00 --days mon-fri --image nightly
   ```

2. Make a token for the booking, on a machine where you are signed in:

   ```bash
   hangar connect night
   ```

   It prints the token, the MCP block, and the cron for the window's start in UTC. Put the cron in
   `night-qa.yml` if your broker isn't on UTC.

3. Copy `night-qa.yml` to `.github/workflows/`, and `brief.md` and `hangar.json` to `night-qa/` in
   your app's repository. Replace `<owner>/hangar` with your copy of the Hangar repository.

4. Add the secrets listed at the top of `night-qa.yml`. The runners reach Hangar over Tailscale,
   so `HANGAR_URL` is the Mac's address on your tailnet.

`hangar.json` is the block `hangar connect night` prints, with two changes: the address and the
token come from the environment instead of being written in the file, and `"type": "http"` is
added, which Claude Code needs to read it. Other MCP clients that read `mcpServers` take the same
block; check whether yours fills in `${...}` from the environment, or write the values in.

The agent step uses Claude Code in print mode as an example. Hangar never ships an agent; put any
MCP-capable agent CLI there, with your own model key.

## What has not run

This example has not run end to end. In particular:

- The workflow has not run on a GitHub runner, and the Tailscale step, the agent step and the
  report job have not been tried together against a real Hangar.
- `hangar.json` has not been loaded by an agent CLI, so the `${HANGAR_URL}` and `${HANGAR_TOKEN}`
  expansion and the `--mcp-config` flags are unchecked.
- No agent has filed a finding from a real simulator. Bookings, preemption, findings and the
  report are tested against a simulated fleet and fake hosts.
- `--slack-webhook` is tested against a fake webhook only.
