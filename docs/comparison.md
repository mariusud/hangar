# How Devicepool compares

Read on 2026-11-08 from each project's own documentation, Tapflow on 2026-11-22. "Not documented"
means the pages read do not mention it, not that the tool cannot do it.

| | Devicepool | Simlock | Argent | Tapflow | Expo Simulators |
|---|---|---|---|---|---|
| Runs on | Your Macs; the broker also in Docker or Kubernetes | Your Mac and Linux machines | Your own computer | Your Macs; the relay also on Linux or in Docker | Expo's servers |
| License | Apache-2.0 | MIT | Apache-2.0 source; the bundled simulator-server, ax-service and native devtools libraries are proprietary | MIT | Hosted service; EAS CLI is MIT |
| Telemetry | None | Not documented | On by default, `argent telemetry disable` | Not documented | Hosted |
| One device per user or agent | Yes, fair queue, TTL, idle timeout | Yes, queue and TTL (15 min default, 4 h max) | No pool | Pick a free device in the dashboard; no queue documented | Sessions with time and idle limits |
| Wiped between uses | Deleted and cloned fresh | Simulators and emulators deleted; phones wiped | Not documented | Not documented | Not documented |
| Live screen in the browser | Yes, H.264, touch and keyboard | Yes, watch and input, off by default | Not documented | Yes, H.264 at about 30 fps, touch, keyboard and audio | Yes |
| AI agents | MCP with mobile-mcp tool names, CLI, REST | MCP, CLI, HTTP | MCP, CLI, skills | MCP (experimental), REST | Through agent-device, Argent or Appium; CLI and REST |
| CI test runs | Maestro, XCUITest, Espresso: sharded, retried, JUnit, recordings, GitHub Action | Not documented | Flows replay | Its own YAML flow runner with JUnit (experimental); Appium and other frameworks are out of scope | Not documented; Appium works |
| React Native dev loop | Metro through Devicepool, Fast Refresh, DevTools | Port tunnels for Metro | Local only | Not documented | Dev build and Metro tunnel |
| Many hosts, teams | Several Macs, teams with quotas, OpenID Connect SSO | Gateway over many workers, roles, sign-in through a proxy | No | One relay over many Mac agents, roles, tokens | Expo accounts |
| Android emulators | Yes | Yes, macOS and Linux | Yes | Yes, on macOS | Yes |
| Physical phones | Android over USB, experimental, never run on real hardware; no iPhones | Yes | Yes | No | No |
| Also covers | | Linux hosts for Android, a slim simulator mode | Apple TV, Android TV, Fire TV, Electron, profiling, visual diffs | Build tracking, clipboard sync, taking a device offline | Runs from Linux and Windows, no hardware needed |

Sources: Simlock's docs in github.com/callstackincubator/simlock (website/src/content/docs),
Argent's README and Telemetry.md in the `@swmansion/argent` package, Tapflow's README in
github.com/jo-duchan/tapflow, Expo's
docs/pages/preview/simulators in github.com/expo/expo.

## Hosted prices

Read on 2026-11-08 from each service's pricing page, unless a row gives another date. The
[alternatives pages](alternatives/index.md) compare Devicepool with each hosted service.

| Service | Price |
|---|---|
| Maestro Cloud | $250 per device per month, set by the most runs at once |
| AWS Device Farm | $0.17 per device-minute, or $250 per device slot per month |
| Sauce Labs virtual devices | $149 per parallel test per month billed yearly, $199 monthly |
| Appetize | $59 to $319 per month billed yearly, 500 minutes included, then $0.06 per minute |
| Expo Simulators | $0.10 per minute on a paid plan (from $19 per month), 60 minutes a month included until 2027; read on 2026-11-22 |
| GitHub macOS runner | $0.062 per minute, $0.102 for the M2 Pro runner; for building, not a device pool |
| Mac mini (M6, 16 GB) | from $899, once; Devicepool runs 3 simulators on it by default, 6 on 24 GB |

