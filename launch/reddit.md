# Reddit posts

## Read before posting

Reddit blocks automated reads of its rules pages, so I could not open any subreddit's sidebar directly on 2026-11-22. The rule notes below come from web search results and are marked with how sure they are. Open each subreddit's rules in a browser before you post, and change the plan if they differ. Where a rule asks you to say how much AI was involved, answer truthfully; I have left that line for you.

Post from an account that has taken part in the subreddit before. Post each one on a different day (see checklist.md). Do not cross-post the same text.

Every number is from docs/numbers.md. No post compares speed with another tool.

---

## r/reactnative

### Rules found

- The moderators run a "Show Your Work Thread" where members share projects built with React Native and ask for feedback. Source: a copy of the thread from mid-2025 found by search. Not confirmed as the current thread.
- A "Self-Promotion" flair appears in a third-party listing of the subreddit. The rule text behind it was not found.
- Not confirmed: whether a standalone post about your own open source tool is allowed, and any limit on how often.
- What to do: read the sidebar. If standalone tool posts are allowed, post the text below with the fitting flair. If they are not, post a shorter version as a comment in the current Show Your Work Thread.

### Angle

The dev loop: your own Metro, a simulator on another machine, Fast Refresh.

### Title

```
I built an open source way to run your app on a simulator on another Mac, with Fast Refresh from your own Metro
```

### Body

[One or two sentences in your own words on why you built it. The docs do not record this.] I built Devicepool to run a React Native app on simulators that live on a Mac mini in the office, and released it under Apache-2.0.

Devicepool is an open source, self-hosted device farm for iOS simulators and Android emulators, for your team, your CI and your AI agents.

The part this subreddit may care about:

- `devicepool run ios` in your app's folder builds the app (or takes a build you already have), borrows a simulator from the pool, and connects it to the Metro server on your own machine through a tunnel. Fast Refresh works. On an M4 Pro I measured 87 ms p50 and 163 ms p95 from saving a file to the first frame of the change on the leased device.
- React Native DevTools works through the same tunnel: console, breakpoints, network, components.
- Expo dev client builds open straight into the bundle.
- You see and touch the device in the browser. The stream is H.264 at 52 fps during motion in my benchmark. The target is 60.
- `devicepool run maestro ./flows --app App.app --shards 3` splits Maestro flows over fresh simulators, retries a failed flow once, and writes one JUnit report with a video of each failure. There is a GitHub Action that wraps it.
- When a lease ends, the simulator is deleted and a fresh one is cloned, so the next run does not inherit a login.

What is not there:

- It is not on npm. You install from a git clone.
- No physical phones.
- `devicepool run android` builds with Gradle and runs on a leased emulator, but I have only checked its error paths on my Mac, not a full run.
- It has run on one Mac. Joining a second Mac is built and has not been tried with a real second machine.
- Input latency is 109 ms p50 and 197 ms p95 to the first changed frame. My target is p95 under 80 ms.

It is not affiliated with Expo.

Repo: https://github.com/mariusud/devicepool
Numbers and how they were measured: docs/numbers.md in the repo.

If you try `devicepool run ios` with your app and it fails, I would like to see the output.

[If the subreddit asks for it: say how much of the code was written with AI assistance.]

---

## r/selfhosted

### Rules found

- New projects may only be posted in the weekly "New Project Megathread". A new thread is posted every Friday, and a project can be added as a top-level comment on any day. The thread asks posters to state AI involvement. Source: search snippets of the megathread and of a rules update dated 2026-04-07. From secondary sources, likely current, not confirmed on the sidebar.
- One search result mentions the megathread route applying to projects younger than three months. Devicepool's first commit is from 2026-11-06, so it is under any such limit either way.
- What to do: do not make a standalone post. Add the comment below to the current megathread, in the format the thread's top post asks for.

### Angle

What it takes to run: one Mac, one command, no account, no outbound calls.

### Megathread comment

**Devicepool**: an open source, self-hosted device farm for iOS simulators and Android emulators, for your team, your CI and your AI agents.

Repo: https://github.com/mariusud/devicepool
License: Apache-2.0
Runs on: a Mac with Xcode (the simulators need macOS). The broker alone also runs in Docker.

What it does: one Mac in the office keeps a pool of simulators. People open one in the browser, CI runs Maestro flows on them, and AI agents drive them over MCP. Each user gets a device nobody else has. When they finish, the device is deleted and a fresh one is cloned.

For people who run their own things:

- `devicepool up` is the whole install on one Mac. The broker and the agent run in one process, with SQLite and files on local disk. No config file is required.
- No account, no telemetry, and it makes no calls to the internet. The console loads no web fonts for the same reason.
- Invite links and passwords by default. OpenID Connect sign-in with groups mapped to teams is optional. It is tested against a fake provider only, not yet against a real one.
- Prometheus metrics at `/metrics`, counts and timings only.
- `devicepool up --install` writes a LaunchAgent that starts at login and restarts on exit.
- `devicepool export` and `devicepool import` move the database, builds and recordings.
- Reach it from outside with your own VPN. I use Tailscale.

Not there yet: it is not on npm (install is a git clone), it has run on one Mac only, the LaunchDaemon for boot with nobody logged in has not been through a real reboot, the Helm chart has not been installed, and there is no support for physical phones. A leased iOS app runs as a process on the Mac, so do not share one Mac between people who do not trust each other's code. Apple's macOS and Xcode licenses decide what you may do with simulators; the repo has a page pointing to them.

AI involvement: [state this truthfully, in the form the thread asks for.]

---

## r/iOSProgramming

### Rules found

- App promotion is limited to "App Saturday": Saturday only in your local time zone, and one post per app per year. Source: moderator reminder posts from 2025 found by search. From secondary sources, not confirmed as current.
- Not confirmed: whether an open source developer tool counts as an app under that rule. Search shows open source Swift projects posted as normal discussion posts on other days.
- One user comment mentions a karma minimum to post. Not confirmed.
- What to do: read the sidebar, and if it is unclear, ask the moderators by modmail before posting. If in doubt, post on a Saturday.

### Angle

How the iOS side is built: simulator capture, input, and wiping. Not the React Native pitch.

### Title

```
What I learned sharing iOS simulators on one Mac between people, CI and agents (open source)
```

### Body

I spent the last weeks building a tool that lends iOS simulators on a Mac to several users at once and wipes each one afterwards. It is open source (Apache-2.0): https://github.com/mariusud/devicepool. Some things I found on the way that may be useful to anyone automating simulators:

- Wiping by `simctl erase` was slower than deleting the simulator and cloning a new one from a golden device that has booted once. Devicepool wipes by delete and clone.
- Accessibility tree reads and taps through idb work on Xcode 26.6 and iOS 26.5 when each simulator gets its own idb companion. Calling the companion's gRPC directly instead of spawning the idb CLI took a tree read from 303 ms median to 3 to 5 ms, and a PNG screenshot from 302 ms to 91 ms.
- A JPEG screenshot at 800 px went from 594 ms to 39 ms when it came from the display's IOSurface in a long-lived Swift helper.
- The live screen is H.264 from native capture, 52 fps during motion on an M4 Pro, with 10.7 ms p50 from capture to client.
- Input to the first changed frame is 109 ms p50 and 197 ms p95. In a trace the swipe reached the simulator's HID input in 1 to 7 ms. The rest was iOS recognizing a scroll that starts on a table row.
- Maestro and `xcodebuild` only find devices in the user's default simulator device set, so a separate device set per tenant did not work. Isolation is a separate macOS user.
- macOS VMs lose the hardware video encoder and are capped at two per Mac, so I did not use VMs for isolation.
- iOS simulators cannot be rotated or pinched through this path. Devicepool answers `UNSUPPORTED` for those.

What it does with all that: a pool of simulators with leases, a browser view with touch and keyboard, an MCP endpoint for agents, and sharded Maestro runs with JUnit. XCUITest from `build-for-testing` is built; it has run against a small SwiftUI fixture and not yet through the full pool.

Limits: simulators only, no physical devices. Not on npm. Tested on one Mac. A leased app runs as a process on the host Mac. Read Apple's macOS and Xcode license terms before lending simulators to anyone beyond the Mac's own user; the repo links to them and makes no claim.

I would like to hear how others handle simulator isolation between untrusted builds.

---

## r/androiddev

### Rules found

- Self-promotion is generally not allowed outside the subreddit's periodic showcase thread, which exists for sharing Android-native projects. Source: a showcase thread from 2025 found by search. Not confirmed as current.
- Posts specific to a cross-platform framework are treated as off topic and removed. Source: the moderators' rules revision from October 2023. May have changed.
- Shared work should come with a description of how it affects other developers, and source code where possible. Same 2023 source.
- What to do: do not make a standalone post. Add the comment below to the current showcase thread. Keep React Native out of it. Android is the smaller half of Devicepool, and the text says so.

### Angle

Emulator pooling on a Mac, and what does not work yet.

### Showcase thread comment

**Devicepool**: an open source, self-hosted device farm for iOS simulators and Android emulators, for your team, your CI and your AI agents. Apache-2.0. https://github.com/mariusud/devicepool

The Android side, which is the newer half:

- `devicepool up --android <avd>` runs read-only instances of one AVD. Each lease gets a fresh instance, and wiping is killing the instance.
- The live screen in the browser is H.264 from `screenrecord`, with touch and keyboard.
- The accessibility tree, input, APK installs and Maestro flows work. I checked them by leasing and driving a real emulator through the broker and the console.
- Rotation works on emulators over the API.
- `devicepool run espresso --app <apk> --test-apk <apk>` installs both on a fresh emulator per shard and runs `am instrument`, sharded by class with retries and JUnit. This is tested against recorded instrumentation output only. It has not run against a real test APK.

What does not work on Android yet: emulators in Linux containers (the host has to be a Mac today), physical phones, the JPEG fallback stream, and push, permissions, language and recordings. I have no Android benchmark numbers; the published ones are for iOS.

If you run emulators for a team on your own hardware, I would like to know what you use to hand them out and reset them.
