# Show HN

## Read before posting

- Hacker News guidelines say: "Don't post generated text or AI-edited text." (news.ycombinator.com/newsguidelines.html, read 2026-11-22). The comment below was drafted by an assistant from the repo's docs. Use it as a fact sheet and write the comment again in your own words before you post. The same goes for every reply in the thread.
- The Show HN rules (news.ycombinator.com/showhn.html) ask for something people can try without a signup, built by the poster, who stays in the thread. A git clone on a Mac with Xcode meets that. They also forbid asking friends to upvote or comment.
- Link the post to the GitHub repo, not to a landing page.
- Every number below is from docs/numbers.md. Check that file again on the day, because other people are editing the docs.

## Title

```
Show HN: Devicepool – Self-hosted iOS simulator and Android emulator farm
```

73 characters. URL: https://github.com/mariusud/devicepool

Alternative, 70 characters:

```
Show HN: Devicepool – Shared iOS simulators for a team, CI and agents
```

## First comment (draft, rewrite in your own words)

Hi HN. Devicepool is an open source, self-hosted device farm for iOS simulators and Android emulators, for your team, your CI and your AI agents. It is Apache-2.0, sends no telemetry and runs on Macs you own.

Why I built it. [The repo's docs do not record your reason, so write this paragraph yourself. What the docs do support: one office Mac mini, a cloud-hosted assistant agent that reaches it over Tailscale and used another tool server before, and a plan to move the nightly e2e suite and night QA onto the same Mac (ROADMAP.md, "Using it for real").] I wanted one pool where a person, a CI job or an agent asks for a device, gets one nobody else has, and hands it back clean.

How it works. `devicepool up` on a Mac starts a broker and an agent in one process and keeps a warm pool of simulators sized from the Mac's memory. A client takes a lease. Leases have a fair queue, a TTL and an idle timeout. When the lease ends, Devicepool deletes the simulator and clones a fresh one from a golden device, so no login or app data carries over. The screen is captured natively and sent as H.264 over a WebSocket to the browser, with touch and keyboard going back. Agents connect over MCP at `/mcp` on your own broker; the tools use mobile-mcp's names, so an agent written for mobile-mcp works unchanged. `devicepool run ios` connects the leased simulator to the Metro server on your laptop through a tunnel, so Fast Refresh and React Native DevTools work. `devicepool run maestro` splits flows over fresh devices, retries a failed flow once and writes one JUnit report with a video of each failure. Everything outside capture, encode and input is TypeScript on Node 22 with no build step.

Numbers, from `pnpm bench:stream` on an M4 Pro with Xcode 26.6 and an iPhone 17 simulator at 1206 by 2622, through the real broker and agent:

- 52 fps during motion over H.264. The target is 60, so that one is not met.
- 10.7 ms p50 and 28.9 ms p95 from capture to client.
- 109 ms p50 and 197 ms p95 from input to the first changed frame. The target is p95 under 80 ms, so that one is not met either. In a trace the swipe reached the simulator's HID input in 1 to 7 ms; the rest was iOS recognizing a scroll.
- 509 KB/s during motion.
- 87 ms p50 and 163 ms p95 from saving a file to the first frame of the change on the leased device (`bench:metro`).
- Reading the element tree takes 3 to 5 ms median, down from 303 ms, after device calls went straight to the idb companion's gRPC. A JPEG screenshot at 800 px went from 594 ms to 39 ms.

The benchmark scripts and the baseline file are in the repo (bench/). I have not published numbers against other tools yet. The comparison script exists, but its only full run was on a loaded machine, so I am not quoting it.

What is missing or untested:

- It is not on npm. You install from a git checkout.
- Physical phones are not supported. Simulators and emulators only.
- More Macs can join one broker with `devicepool join`, but that has only been tested on one machine. No second Mac has joined yet.
- XCUITest has run against a small fixture, not through the full pool. Espresso has not run against a real test APK.
- The LaunchDaemon install has not been through a real reboot with nobody logged in.
- OIDC sign-in is tested against a fake provider. S3 storage is tested against a fake bucket. The Helm chart has not been installed.
- Bookings, held devices, findings and image capture are tested against fake hosts only.
- A leased iOS app runs as a process on the Mac. If two teams do not trust each other's code, give them separate Macs.
- Android runs on a Mac only. Push, permissions, language and recordings are not done on Android.

It has run for one week on our office Mac mini with a cloud service leasing devices over Tailscale. That week found four bugs, which are in the roadmap and the launch post.

On Apple's license, since someone will ask. I am not a lawyer and this is not legal advice. I read the macOS Tahoe 26 license and the Xcode and Apple SDKs agreement on 2026-11-22. What I found:

- The macOS license (section 2B(ii)) lets a company run one copy for a single person on each Mac it owns or controls, or for several people on one shared Mac it owns or controls.
- Section 2I allows one device at a time to control the Mac's graphical desktop session remotely. The same section says you agree not to use the software for service bureau, time-sharing, terminal sharing or similar services, and it says this applies inside your own organization as well as to third parties.
- Section 3 lets a hosting company lease a whole Mac for CI, for at least 24 hours, with sole use by the lessee. That is the clause Mac hosting providers work under. Devicepool does not lease Macs to anyone.
- The Xcode agreement (2.2A) allows installing Xcode on Apple-branded computers you own or control, for use by you or your authorized developers, to test and develop software. Section 2.7 says the software may not be made available over a network where multiple computers could run or use it at the same time, unless Apple permits it in writing.

What Devicepool does in those terms: the simulators run on your Mac and never leave it. Devicepool sends each simulator's screen as video and sends input back. It does not share the macOS desktop session. Whether several people each using a different simulator on one Mac counts as terminal sharing under 2I, or as making Xcode available over a network under 2.7, is a question the text does not answer for me, and I do not know how Apple reads it. If that matters for your company, read both documents and ask your lawyer. The repo has a page on this (docs/licensing.md) and makes no claim either way. Devicepool is not a hosted service and I do not plan to make it one.

I would like to hear from anyone who runs simulators for a team: what breaks first, and what you use today.

## Questions to prepare for

| Question | Where the answer is |
|---|---|
| How is this different from Simlock, Tapflow, Argent or Expo Simulators? | docs/comparison.md. Give only the differences listed there, with the date they were read. Do not compare speed. |
| Is it faster than X? | No published head-to-head numbers. Say so. |
| Why not VMs for isolation? | ROADMAP.md spike results: macOS VMs lose the hardware video encoder and are capped at two per Mac. |
| How many simulators per Mac? | docs/comparison.md: 3 by default on 16 GB, 6 on 24 GB. |
| Why SQLite? | docs/decisions/0009. |
| Does it phone home? | No. AGENTS.md: nothing calls out to the internet. |
| Is this from Expo? | No. Devicepool is not affiliated with Expo. |
| Was this written with AI? | Answer truthfully. |
