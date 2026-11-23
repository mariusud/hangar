# Open source alternative to Appetize

Is there an open source, self-hosted alternative to Appetize? Yes, for your own team: Devicepool
is an open source (Apache-2.0) device farm that streams iOS simulators and Android emulators
from your own Macs to the browser, and lets CI and AI agents use the same devices. It is made
for a team's internal work, and Appetize is the better choice for showing an app to the public
on a website.

## What Appetize is

Appetize is a hosted service that runs a mobile app on a virtual device in the web browser. Its
documentation lists live app previews, previews embedded in web pages, customer support,
training, demos, testing and screenshot automation as uses. For iOS you upload a simulator build
(`.app`) in a `.zip` or `.tar.gz` file.

The pricing page lists four plans:

| Plan | Price | Included |
|---|---|---|
| Free | $0 | 1 user, 2 devices at once, 30 minutes a month, sessions of 3 minutes |
| Starter | $59 per month billed yearly, $89 monthly | 3 devices at once, 500 minutes, then $0.06 per minute |
| Premium | $319 per month billed yearly, $449 monthly | 16 devices at once, 500 minutes, then $0.06 per minute |
| Enterprise | on request | private cloud or self-hosting |

## What Devicepool does instead

- The console shows a live device in the browser, in H.264, with touch and keyboard. On one Mac
  we measured 52 frames a second over HTTPS or localhost, 38 on a plain-HTTP LAN ([numbers](../numbers.md)).
- It takes the same kind of build: a simulator `.app` for iOS, an APK for Android.
- The `<devicepool-screen>` element puts a live device in a page of your own, such as a support
  tool or an internal dashboard. Your server passes the stream on and adds the token
  ([guide](../guides/embed-screen.md)).
- Device images keep simulators ready with your app installed and a locale set, so a session
  starts in the app.
- It has no session minutes to count. The limit is how many devices your Mac can run: 3
  simulators on a 16 GB Mac mini by default.
- Each device is deleted after use and replaced with a fresh clone.
- CI runs (Maestro, XCUITest, Espresso) and AI agents over MCP draw from the same pool.

## What Devicepool does not do

- It is not built to serve an app preview to the public. A viewer's browser has to reach your
  server, your server has to reach the Mac, and every viewer takes one of a few devices.
- It does not host anything. You need a Mac with Xcode and idb, and someone to keep it updated.
- It does not run iPhones. Android phones over USB are experimental and have never run on real
  hardware.
- The live screen for Android emulators needs HTTPS or localhost. There is no JPEG fallback for
  Android yet.
- It is early and not on npm yet.

## When to pick Appetize

- You want an app demo on a public website, or in front of customers, with no server of your
  own.
- You want more devices at once than your Macs can run.
- You use it for less than 30 minutes a month, which the free plan covers.
- Nobody on your team wants to look after a Mac.

## How to switch

1. On a Mac with Xcode and idb:

   ```bash
   git clone https://github.com/mariusud/devicepool && cd devicepool
   pnpm install && npm install -g ./packages/devicepool
   devicepool up
   ```

2. For previews by your team, open the link it prints, invite people from the People page, and
   install the build on a device in the console.
3. To start every session with the app installed, make a device image and lease from it:

   ```bash
   devicepool image set demo --app ./MyApp.app
   devicepool lease --image demo
   ```

4. To embed a device in your own page, copy `/screen.js` from the broker and add the element.
   Your server forwards the socket with `proxyStream` from the `devicepool` client library.

   ```html
   <script type="module" src="/screen.js"></script>
   <devicepool-screen src="/device-stream" style="width: 320px; aspect-ratio: 402 / 874"></devicepool-screen>
   ```

The guides: [embed a screen](../guides/embed-screen.md),
[device images](../guides/device-images.md), [recordings](../guides/recordings.md).

## Sources

Read on 2026-11-22:

- [appetize.io/pricing](https://appetize.io/pricing) for the plans.
- [docs.appetize.io](https://docs.appetize.io/) for what Appetize is and its uses.
- [Uploading iOS apps](https://docs.appetize.io/platform/app-management/uploading-apps/ios) for
  the build format.

Devicepool is not affiliated with Appetize.
