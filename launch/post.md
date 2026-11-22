# A week of Devicepool on the office Mac mini

Draft for the launch blog post. The prose is about 700 words; with the table and the install block it is about 870. Every fact is from ROADMAP.md ("Current status"), docs/numbers.md and docs/features.md as read on 2026-11-22. Two places are marked for you to fill in, because the docs do not hold the detail. If you link this post from Hacker News, rewrite it in your own words first: HN's guidelines ask for no generated or AI-edited text.

---

Devicepool is an open source, self-hosted device farm for iOS simulators and Android emulators, for your team, your CI and your AI agents. Before telling anyone about it, I ran it for a week on the Mac mini in our office. A service we host in the cloud leased simulators from it over Tailscale with a member token. This post is what that week found.

## The setup

One Mac mini, one `devicepool up`. The broker and the agent run in the same process. The pool keeps simulators warm, a client takes a lease, and when the lease ends Devicepool deletes the simulator and clones a fresh one. The client in this case was not a person. It was a cloud service that asks for a device, installs a build, reads the screen and taps.

[Fill in: which Mac mini, how many leases the week saw, and what the service does. The docs do not record these.]

## Four problems

**1. A tap crashed the agent.** The cloud service sent points as `{x, y}`. Devicepool expected the other form, and the agent on the Mac crashed. The broker now accepts both forms.

**2. A queued lease outlived the request that made it.** A client asks for a device with `?wait` and holds the request open until one is free. When that client disconnected, its queued lease stayed in the queue. A queued lease now ends when the client that made it disconnects.

**3. An image lease waited behind an idle device.** Device images keep simulators ready with an app installed. A lease on an image queued while a warm plain simulator sat idle on the same Mac. A full host now wipes an idle warm device of another class when the broker says a lease is waiting for it.

**4. Signing in needed a script.** An image could sign in to the app by running a Maestro flow once. Some sign-ins cannot be scripted. `devicepool image capture` now saves a leased device that someone set up by hand as an image on that Mac.

[Fill in, if you have it: what each one looked like when it happened, and how long it took to find. The roadmap records only the cause and the fix.]

All four came from a client other than my own CLI, using the pool for real work.

Two of the fixes are less proven than I would like. The pool swap in problem 3 and the capture in problem 4 are tested with fake hosts. Capture has not yet run on the mini.

## The numbers

These are from `pnpm bench:stream` on an M4 Pro with Xcode 26.6 and an iPhone 17 simulator at 1206 by 2622, through the real broker and agent. The scripts and the baseline are in the repo.

| | Measured | Target |
|---|---|---|
| Frame rate during motion, H.264 | 52 fps | 60 fps |
| Capture to client | 10.7 ms p50, 28.9 ms p95 | |
| Input to first changed frame | 109 ms p50, 197 ms p95 | p95 under 80 ms |
| Bandwidth during motion | 509 KB/s | |
| Fast Refresh, save to first frame on the leased device | 87 ms p50, 163 ms p95 | under 1 s |

Two targets are not met. The frame rate is 8 short. The input p95 is more than twice the target. In a trace, the swipe reached the simulator's HID input in 1 to 7 ms, and the rest went to iOS recognizing a scroll that starts on a table row. Most of that p95 is iOS.

Device calls got faster when they went straight to the idb companion's gRPC: the element tree went from 303 ms to 3 to 5 ms median, and an 800 px JPEG screenshot from 594 ms to 39 ms.

I have no numbers against other tools. The comparison script exists and has run end to end, but only on a machine under heavy unrelated load, so there is nothing to publish.

## What is still untested

- No second Mac has joined a broker. `devicepool join` is tested on one machine.
- The LaunchDaemon has not been through a real reboot with nobody logged in.
- Espresso has not run against a real test APK. XCUITest ran against a small fixture on a test host, not through the full pool.
- OIDC is tested against a fake provider, S3 storage against a fake bucket, and the Helm chart has not been installed.
- Bookings and night QA are tested against a simulated fleet. No finding has been filed from a real simulator.
- The benchmark numbers above are from an M4 Pro, not from the Mac mini. The lease-time target needs a clean run on the mini before it counts.
- Physical phones are not supported.

It is not on npm yet. To try it on a Mac with Xcode:

```bash
git clone https://github.com/mariusud/devicepool && cd devicepool
pnpm install && npm install -g ./packages/devicepool
devicepool up
```

If you run it and it breaks, open an issue with what you did. A week with one outside client found four bugs.

[Fill in: where to reach you.]
