# Product marketing context

**Document version:** v3
**Last updated:** 2026-11-08

Prices and quotes were read on 2026-11-08. Check them again before you publish anything that
quotes them.

## The message

| | Wording |
|---|---|
| Headline | The open source device broker for React Native teams. |
| Second line | A free alternative to Expo Simulators and EAS Maestro jobs, on your own Macs. |
| What it does | Hangar hands out iOS simulators and Android emulators from your own Macs to your developers, your CI and your AI agents, and wipes each device when it comes back. Physical phones are next. |
| Uses | Develop on a device you don't have. Test every pull request. Let AI agents check their own work. Try a build by hand. |
| Why | Free and open source, one pool for everyone, a clean device every time, builds stay with you, fast. |

## Why this message

- **"Device broker" is the category.** Hangar brokers devices: simulators and emulators now,
  phones later. The word also sets Hangar apart from Expo's "cloud simulators" and Simlock's
  "simulator cloud".
- **Expo is the frame of reference.** Expo calls itself "Agentic mobile infrastructure". Its
  Simulators are a waitlist beta, "Cloud simulators your coding agent can drive on demand", and
  Maestro runs as an alpha job in Workflows. Hangar does the same jobs for free, and adds people
  in the browser and sharded CI. The closest precedent is xprem (711 stars): "Self-hosted Expo
  OTA Updates alternative to EAS Update". Expo publishes its own custom-updates-server example, so
  it tolerates such tools.
- **Name Expo only to compare.** Expo's brand page (expo.dev/brand) forbids Expo marks in a
  product name or domain, and anything that suggests you are Expo. "Alternative to Expo
  Simulators" is a fair comparison. The README ends with "Hangar is not affiliated with Expo."
- **Uses, not features.** Coolify ("What can Coolify do?") and Maestro ("Why Maestro?") use
  bold-lead bullets of one sentence each. The four uses mirror Expo's Develop and Test words, so
  people searching in Expo's terms find them.
- **No cost sums in the pitch.** Price arguments pull in hardware and upkeep. Free and open source
  says enough, and the hosted prices stay in docs/comparison.md.
- **Easy, shown rather than claimed.** Three commands under "Start", one command per use in
  "Connect", and the GIF. Simlock and Maestro lead the same way. We claim no setup time until it
  has been timed.

## Market prices

| Service | Price | Source |
|---|---|---|
| Maestro Cloud | $250 per device per month | maestro.dev/pricing |
| AWS Device Farm | $0.17 per device-minute, or $250 per slot per month | aws.amazon.com/device-farm/pricing |
| Sauce Labs virtual devices | $149 per parallel test per month billed yearly, $199 monthly | saucelabs.com/pricing |
| Appetize | $59 to $319 per month, 500 minutes included, then $0.06/min | appetize.io/pricing |
| Expo Simulators | limited beta, usage-based, 60 min/month included until 2027, no price | expo.dev/pricing |
| EAS Workflows, Maestro jobs | $0.05 per job plus CI minutes | expo.dev/pricing |
| GitHub macOS runner | $0.062/min, $0.102 for M2 Pro | docs.github.com billing reference |
| Mac mini M6 | from $899 (the smallest config is 16 GB/256 GB) | apple.com/shop/buy-mac/mac-mini |

**How many devices a Mac runs.** No neutral source has published a measurement. Hangar's
`defaultMaxDevices` sets aside 2.5 GB per simulator and keeps 8 GB for macOS. It also allows at
most half the CPU cores. That gives 3 simulators on 16 GB and 6 on 24 GB (M6, 12 cores).
Simlock's defaults are close to this: 1.5 GiB per iOS simulator, 4 GiB per Android emulator,
and half the cores. A measured number under a real Maestro load would make this stronger. It
would take a benchmark run, so it waits for a decision.

## Audience

- **Team:** React Native or Expo, 3 to 30 developers, already running Maestro or XCUITest, and
  with a Mac mini or a spare Mac.
- **Champion:** the mobile lead or platform engineer who looks after CI.
- **Who pays:** the engineering manager, who sees the macOS CI bill or the Maestro Cloud bill.
- **Fastest-growing reason to buy:** AI agents. Developers on HN in Sept and Oct 2026 describe
  several agents with simulators overloading one laptop ("my Mac would try to fly off my desk",
  HN 50199919).

**Wrong fit:**
- teams with no Mac and nobody to look after one;
- teams whose agents run only in the cloud;
- teams that need physical phones.

## Objections

| Objection | Answer | Where |
|---|---|---|
| Who looks after the Mac? | Someone on the team, for Xcode and macOS updates | README cost note |
| How many devices per Mac? | 3 on 16 GB and 6 on 24 GB, by default | README cost note |
| Our CI can't reach the office Mac | A runner on the same network, or Tailscale's GitHub Action | README Connect, GitHub Actions guide |
| Simlock is free too | Simlock serves agents; Hangar adds people in the browser, Fast Refresh and sharded CI | README table, docs/comparison.md |
| Is this allowed by Apple's license? | Read it; we link to it | README Status |
| Is it ready? | Early and not on npm yet, as the README says | README Status |

## Launch

**What has to be true first:**
1. Hangar is on npm, so the install is one line.
2. A real Fleet page GIF exists: an agent, a CI run and a person at once.
3. The GitHub Actions guide has a full Tailscale example, tested.

**Channels:**
- a Show HN (Simlock used one on 2026-10-30);
- r/reactnative;
- the Expo Discord;
- Maestro's community.

The HN title can be the headline.

**GitHub "About" line** (the user sets this; we don't write to GitHub):
"Simulators for your whole team, on your own Mac. A self-hosted alternative to Maestro Cloud,
Appetize and Expo Simulators."

## Commercial model (later)

Apache-2.0, free. If income is ever needed, there are three common paths:
- paid support;
- a managed broker in front of the customer's own Macs;
- prebuilt Mac minis.

Decide after there are users.

## Changelog

- v3 (2026-11-08): Repositioned as the open source device broker and a free alternative to Expo
  Simulators and EAS Maestro jobs. Dropped the cost sum from the pitch. Added four uses and the
  Expo trademark rules.
- v2 (2026-11-08): Combined headlines A and B into one message. Narrowed the "alternative to"
  list to services that host simulators. Replaced the unconfirmed Expo price and the $600 Mac
  mini with published prices and Hangar's own default device limit. Added the CI reachability
  answer.
- v1 (2026-11-08): First version, from research into the messaging of 24 products and the
  published prices of hosted device services.
