# Open source alternatives to hosted device clouds

Devicepool is an open source, self-hosted device farm for iOS simulators and Android emulators, for your team, your CI and your AI agents.
It is free under Apache-2.0 and runs on Macs you own, so it can replace a hosted device cloud
for the work that simulators and emulators can do.

Each page below answers one question: is there an open source alternative to this service, and
when is the service still the better choice.

| Service | What it is | Page |
|---|---|---|
| Maestro Cloud | Hosted devices that run Maestro flows | [Alternative to Maestro Cloud](maestro-cloud.md) |
| AWS Device Farm | Real phones and tablets hosted by AWS | [Alternative to AWS Device Farm](aws-device-farm.md) |
| BrowserStack App Live | Real phones in the browser for testing by hand | [Alternative to BrowserStack App Live](browserstack-app-live.md) |
| Appetize | Virtual devices in the browser, also embedded in web pages | [Alternative to Appetize](appetize.md) |
| Expo Simulators | Remote simulators and emulators on Expo's servers | [Alternative to Expo Simulators](expo-simulators.md) |

## What is true on every page

- Devicepool runs iOS simulators and Android emulators. It does not run physical phones.
  Physical phones are on the roadmap.
- Devicepool needs a Mac that someone on your team looks after: macOS and Xcode updates, disk
  space, and a network your developers, CI and agents can reach.
- Devicepool is early. It is not on npm yet, and you install it from a clone of the repository.
- The facts about each service come from that service's own documentation and pricing page, with
  the date they were read. Prices change, so check the linked page before you decide.
- The pages give no cost comparison. A hosted price and the cost of owning and looking after a
  Mac are different kinds of cost, and the hosted prices are in
  [the comparison](../comparison.md#hosted-prices).

Other self-hosted and local tools (Simlock, Argent, Tapflow) are in
[How Devicepool compares](../comparison.md).

Devicepool is not affiliated with Maestro, Amazon Web Services, BrowserStack, Appetize or Expo.
