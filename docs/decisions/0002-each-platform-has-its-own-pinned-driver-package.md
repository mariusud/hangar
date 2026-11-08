# 0002. Each platform has its own pinned driver package

- **Status:** Superseded by [0010](0010-hangar-2.md): the drivers live in the agent package,
  since nothing else uses them. Pinned tool versions per driver still apply.
- **Date:** 2026-11-05

## Context

Drivers break with Xcode and Android releases. idb has open iOS 26 issues (#964: `describe-all`
returns one element; #985: an empty tree after `idb ui quiet`). WebDriverAgent works on simulators
but costs an XCTest runner per device. pymobiledevice3 is GPL-3.0.

## Decision

Drivers are separate packages behind one interface (`create`, `boot`, `erase`, `screenshot`,
`describe`, `tap`, `swipe`, `type`, `key`, `install`, `launch`, `terminate`, `openUrl`,
`settings`, `logs`, `videoStream`):

- `driver-ios-simulator`: `simctl` for lifecycle and settings, idb companion for input, the
  accessibility tree and H.264 video. Fallbacks: AXe for the tree, serve-sim for video and input.
- `driver-android` (milestone 2): adb, emulator gRPC on loopback, Appium's UiAutomator2 server for
  the tree, scrcpy server for video and phone input.
- `driver-ios-device` (milestone 3): devicectl, WebDriverAgent, go-ios.

Runners (Maestro, `xcodebuild test-without-building`, `adb shell am instrument`, Appium) live in
the agent and call the same tools. Every version is pinned in `hosts/versions.json`.

## Consequences

- A broken driver is fixed and released in one package.
- CI runs a smoke test per supported Xcode and runtime pair, and the broker refuses to schedule on
  a host whose versions are not in the tested list unless an operator overrides it.
- If spike 1 shows idb's tree is not usable, this decision is superseded with the fallbacks.
