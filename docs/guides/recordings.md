# Record a bug

A recording is the video of a leased device, the log of the apps on it, the last screenshot,
and a timeline of what was done: every tap, swipe, key, deep link and app launch,
with the ones that failed marked. It becomes a link to paste into the bug report. People on the
recorder's team, and operators, can open it after they sign in.

## From the console

On a device page, press **Record**, reproduce the bug, and press **Stop recording**. The page
links to the recording. Releasing the device also stops and saves a recording.

On the recording page, click a step in **What happened** or a line of the app log, and the video
jumps to that moment.

## From the CLI

```bash
hangar record              # start on your current lease
hangar record stop         # prints the link
hangar lease --record      # record the whole lease; the link is in `hangar recordings`
```

## From code and agents

```ts
await lease.record();
// reproduce
const { url } = await lease.stopRecording();
```

The MCP tool `record` takes `action: "start"` or `"stop"`. Stop returns the link, so an agent
that reproduces a bug can hand a person something to check.

## What is kept

| File | What it is |
|---|---|
| `video.mp4` | The screen, written from the live stream's own H.264 frames, so recording does not encode twice. Frames come only when the screen changes. A rotation during a recording leaves out the frames after it. |
| `timeline.json` | `[{ "at": ms, "what": "Tap \"Sign in\"", "failed"?: "..." }]`, from the actions the broker carried. Typed text shows only its length, since tests type passwords. Screenshots and tree reads are left out. |
| `log.ndjson` | `log stream` output for apps installed on the device, up to 16 MB. React Native release builds log `console` output here. |
| `applog.json` | The app's own log lines, as `app_log` returns them, collected every 10 seconds while recording; the newest 5000 lines are kept. |
| `network.json` | The app's network requests, as `network_requests` returns them; the newest 2000 are kept. Empty without the Metro tunnel. |
| `screenshot.png` | The screen when the recording stopped, at full resolution. |

## A link for someone without an account

On a recording page, **Copy view-only link** copies a link that opens the recording without
signing in, for 7 days. The page shows the video, the timeline, the app log and the downloads,
and says when the link stops working. `POST /v1/recordings/:id/share` makes one, with `days`
from 1 to 30.

The link carries its end time and a signature made with a key the broker keeps in its data
folder (`view-link.key`). Anyone who has the link can watch the recording until then; a single
link can't be revoked early. Deleting the recording ends every link to it, and deleting the key
file and restarting the broker ends every view-only link at once.

## How long recordings are kept

Recordings are deleted after 14 days. The person who recorded it, or an operator, can delete one
sooner: `DELETE /v1/recordings/:id`.

## API

| | |
|---|---|
| `POST /v1/leases/:id/recording` | Start recording a lease you hold. |
| `POST /v1/leases/:id/recording/stop` | Stop, wait for the Mac to save the files, return the recording. |
| `POST /v1/leases` with `"record": true` | Record from the moment the device is ready until release. |
| `GET /v1/recordings`, `GET /v1/recordings/:id` | Yours, or `?all=1` for the team's. Each has `url` (the page) and `files`. |
| `GET /v1/recordings/:id/video.mp4` (and the other files) | With range requests, so players can seek. |
| `POST /v1/recordings/:id/share` | A view-only link, `{ url, view, expiresAt }`. The page and its files take `?view=`. |
