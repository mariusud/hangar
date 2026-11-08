# Features

Everything Hangar does today, with links to the guides.

- `hangar up` on a Mac with Xcode and idb: checks the machine, keeps a warm pool of simulators
  sized from memory, and prints a one-use admin link. `hangar doctor` runs the checks alone.
- Leases with a fair queue, TTL, idle timeout and renew. Two clients never get the same device.
  A released device is deleted and replaced with a fresh clone, so nothing survives a lease.
- A REST API: screenshot, accessibility tree, batched actions (tap by element or point, swipe,
  type, key, button, wait for an element), install a `.app`, launch, terminate, open URL.
- A console: invite links and passwords, the device list, a live screen in H.264 at 60 frames
  per second (JPEG on plain-HTTP pages) with touch and keyboard, install and open URL.
- Teams with quotas, for operators on the People page: a team holds at most its quota of
  devices at once, and requests over it wait in the queue, fairly between teams.
- Single sign-on through any OpenID Connect provider, with groups mapped to teams and roles
  ([guide](guides/sso.md)).
- MCP at `/mcp` for AI agents, with mobile-mcp's tool names, so agents written for it work
  unchanged. Each session gets its own lease ([guide](guides/agents.md)).
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
- Recordings with a bug link. Press Record in the console (or `hangar record`, `hangar lease
  --record`, the `record` MCP tool), test, and stop: the link opens the video, a timeline of
  every tap, swipe and key with failed ones marked, the app log and the last screenshot. Click a
  step or a log line and the video jumps there. The video is the stream's own H.264 written to
  an MP4 on the Mac, so recording costs no second encode. Recordings are kept for 14 days.
- Prometheus metrics at `/metrics`: devices, leases and hosts by state, time to get a device,
  how leases ended, device op timings, frames sent and dropped per codec. Counts and timings
  only, no names or ids, so it needs no token.
- Device presets from the API, CLI and MCP: simulated push, permissions, GPS location, light
  and dark mode, an app's language. The React Native dev menu and reload (command-D and
  command-R) from the console, CLI and MCP.

`hangar up --install` sets Hangar up as a LaunchAgent that starts at login and restarts if it
stops; with automatic login it comes back after a reboot. Its plist is tested, but the install
has not yet run end to end on a Mac mini.

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
([guide](guides/device-images.md)).

`hangar run android` builds, installs and runs your app on a leased emulator, connected to Metro
here.

Not yet: Android in Linux containers or on phones. Only one Hangar can run on a Mac at a time.
