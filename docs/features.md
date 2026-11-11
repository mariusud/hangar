# Features

Everything Hangar does today, with links to the guides.

- `hangar up` on a Mac with Xcode and idb: checks the machine, keeps a warm pool of simulators
  sized from memory, and prints a one-use admin link. `hangar doctor` runs the checks alone,
  and says how to get the idb companion when Homebrew refuses it.
- Leases with a fair queue, TTL, idle timeout and renew. Two clients never get the same device.
  Each token carries its own idle and longest-lease limits under caps an operator sets per role,
  `keepalive` counts as activity without touching the device, and the same token can reattach
  to its lease after a restart ([guide](guides/agents.md#how-long-a-lease-lasts)).
  A released device is deleted and replaced with a fresh clone, so nothing survives a lease.
- A REST API: screenshot, accessibility tree, batched actions (tap by element or point, swipe,
  type, key, button, wait for an element), install a `.app`, launch, terminate, open URL.
- A console: invite links and passwords, the device list, a live screen in H.264 at 60 frames
  per second (JPEG on plain-HTTP pages) with touch and keyboard, install and open URL. Leasing
  from the console can pick a device image, and a device page has light and dark buttons and,
  on iOS, sets one app's language and restarts it.
- The Fleet page, for operators: every device at once with a live picture, who holds it, how
  they got it (an agent's purpose, a run's shard, the console) and the last thing they did.
  Watching a device does not keep its lease alive. `hangar lease --purpose` sets the line too.
- Teams with quotas, for operators on the People page: a team holds at most its quota of
  devices at once, and requests over it wait in the queue, fairly between teams.
- Single sign-on through any OpenID Connect provider, with groups mapped to teams and roles
  ([guide](guides/sso.md)).
- MCP at `/mcp` for AI agents, with mobile-mcp's tool names, so agents written for it work
  unchanged. Each session gets its own lease ([guide](guides/agents.md)). `hangar connect
  claude`, `cursor` or `codex` makes an agent token and sets it up.
- The app log, JavaScript evaluate and console, and the app's network requests for agents, over
  MCP and REST, through the Metro tunnel `hangar run` opens. Tested against fakes only.
- A TypeScript client (`hangar`) and a CLI: `login`, `lease`, `screenshot`, `ui`, `tap`,
  `type`, `install`, `launch`, `open-url`, `watch`, `release`.
- `hangar run ios`: your app on a leased simulator, loading JavaScript from the Metro on your own
  machine through Hangar, with Fast Refresh and React Native DevTools (console, breakpoints,
  network, components) through the same tunnel. Expo dev client builds open straight into the
  bundle.
- `hangar run maestro ./flows --app App.app --shards 3`: Maestro flows split over fresh devices,
  failed flows retried once, flaky flows marked, one merged JUnit report (`--junit`). Each retry
  is recorded, so a failed or flaky flow comes with a link to its video, timeline and app log.
  Hangar runs it (`POST /v1/runs`), so the console's Runs page shows it live and Ctrl-C or the
  page cancels it. A GitHub Action (`action.yml`) wraps the same command.
- The first failed attempt of a flow is recorded too, not only the retry. `hangar run maestro
  --rerun <run> --flow <flow>` runs one flow of a finished run again on a fresh device. The
  action comments on the pull request and updates that comment, and
  `examples/workflows/hangar-nightly.yml` is a nightly run. `GET /v1/tests/flaky` gives flake
  rates and failures grouped by error ([guide](guides/github-actions.md)).
- Recordings with a bug link. Press Record in the console (or `hangar record`, `hangar lease
  --record`, the `record` MCP tool), test, and stop: the link opens the video, a timeline of
  every tap, swipe and key with failed ones marked, the app log and the last screenshot. Click a
  step or a log line and the video jumps there. The video is the stream's own H.264 written to
  an MP4 on the Mac, so recording costs no second encode. Recordings are kept for 14 days. A
  view-only link lets someone without an account watch one for 7 days
  ([guide](guides/recordings.md)). A recording also keeps the app's log lines and network
  requests from the device tools.
- `hangar run maestro --hold 30m` keeps the device a flow failed on as the test left it, and
  `hangar held <run-id> <flow>` leases it to a person on the run's team. A shard whose device was
  taken for a higher-priority lease runs its unfinished flows again, up to three times
  ([guide](guides/maestro.md)). Tested against fake hosts only.
- Bookings: `hangar book night --devices 4 --from 21:00 --to 06:00 --days mon-fri` holds devices
  for a team in a window, in the broker's time zone, and `hangar connect night` makes a token that
  leases only from it. Each Mac keeps a CI floor that bookings never take. Leases have a priority
  (`ci`, `interactive`, `booked`); a `ci` request can end a lower one with two minutes' notice,
  and booked leases get ten minutes' notice before their window closes (`lease_ending`)
  ([guide](guides/night-qa.md)). Tested against a simulated fleet only.
- Findings and nights: the `report_finding` MCP tool files a bug with a span of the recording, the
  steps, the app log, the network requests and a screenshot. A booking's window end closes its
  night, and `hangar night report <booking>` prints the report in Markdown or JSON, or posts it to
  a Slack webhook from the machine that runs it. Tested against a fake host; no finding has been
  filed from a real simulator.
- Prometheus metrics at `/metrics`: devices, leases and hosts by state, time to get a device,
  how leases ended, device op timings, frames sent and dropped per codec. Counts and timings
  only, no names or ids, so it needs no token.
- Device presets from the API, CLI and MCP: simulated push, permissions, GPS location, light
  and dark mode, an app's language. The React Native dev menu and reload (command-D and
  command-R) from the console, CLI and MCP. Rotation over the API and MCP on Android emulators;
  iOS simulators answer `UNSUPPORTED`, and so do pinch and rotate gestures on both.

`hangar up --install` sets Hangar up as a LaunchAgent that starts at login and restarts if it
stops; with automatic login it comes back after a reboot. `sudo hangar up --install --system
--user <name>` writes a LaunchDaemon that starts it at boot as that user, with nobody logged in.
The plists are tested, but neither install has run end to end on a Mac mini, and the
LaunchDaemon has not been through a real reboot ([guide](guides/unattended.md)).

`pnpm bench:smoke` checks this Mac's Xcode against real simulators and writes the result to
`hosts/versions.json`; with `HANGAR_REQUIRE_SMOKE=1` a Mac offers no simulators on an Xcode
that hasn't passed.

More Macs join one broker with `hangar join`, and the broker runs alone in a container or on
Kubernetes ([guide](guides/more-macs.md)).

Android emulators run next to the simulators with `hangar up --android <avd>`: a fresh read-only
instance per lease, the live screen, input, the tree, installs and Maestro
([guide](guides/android.md)).

`hangar run xcuitest build/Build/Products` runs XCUITest from `build-for-testing` the same way
([guide](guides/xcuitest.md)).

`hangar run espresso` does the same for Espresso on Android emulators.

Device images keep simulators ready with your app installed and a locale and appearance set:
`hangar image set norsk --app ./MyApp.app --locale nb_NO`, then `hangar lease --image norsk`
([guide](guides/device-images.md)). An image can also grant permissions to its apps
(`--grant`) and run a Maestro sign-in flow once (`--sign-in`), with the account's values from
the broker's secret store or the Mac's environment. Grants and sign-in are tested with fakes
only. `hangar image refresh norsk --app ./MyApp.app` builds the image again with a new build
while leases on the old one keep running; tested with a fake host only.

`hangar run android` builds, installs and runs your app on a leased emulator, connected to Metro
here.

Not yet: Android in Linux containers or on phones. Only one Hangar can run on a Mac at a time.
