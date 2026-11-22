# Open source alternative to BrowserStack App Live

Is there a free, open source alternative to BrowserStack App Live? For testing an app by hand on
iOS simulators and Android emulators, yes: Devicepool is an open source (Apache-2.0),
self-hosted device farm that puts a live device in your browser, running on your own Mac. For
testing on real phones, no: App Live gives you physical devices, and Devicepool does not yet.

## What BrowserStack App Live is

App Live is BrowserStack's product for testing mobile apps by hand on real iOS and Android
devices in its cloud, from a browser. Its product page says you can upload an APK, AAB or IPA
file or install an app from the Play Store or App Store, read logs and crash reports, inspect UI
elements, and use device features such as biometrics and a physical SIM.

App Live is a paid subscription with a free trial. This page gives no prices, because the plan
prices could not be confirmed from the pricing page on the date below. See
[browserstack.com/pricing](https://www.browserstack.com/pricing?product=app-live).

## What Devicepool does instead

- The console shows a live device in the browser, in H.264, with touch and keyboard. On one Mac
  we measured 52 frames a second ([numbers](../numbers.md)).
- You install a build, open a deep link, set a GPS location and switch light and dark mode. On
  iOS you can also set an app's language, grant permissions and send a simulated push.
- Record gives you a link with the video, a timeline of every tap and key, the app log and the
  last screenshot. A view-only link lets someone without an account watch it for 7 days.
  Recordings are iOS only for now.
- Each device is deleted after use and replaced with a fresh clone, so a tester never inherits
  the last tester's login.
- The devices run on your Mac, so an unreleased build stays on your network.
- The same pool serves CI runs and AI agents.

## What Devicepool does not do

- It does not run physical phones. They are on the roadmap. You can't test a specific phone
  model, a camera, a SIM or real biometrics on a simulator.
- It installs simulator builds (`.app`) and APKs. An IPA built for a phone does not run on an
  iOS simulator, and a simulator has no App Store.
- It offers the simulator models your Xcode has and the Android virtual device you set up. It
  has no catalogue of phone models.
- It does not host anything. You need a Mac with Xcode and idb, and someone to keep it updated.
- It is early and not on npm yet.

## When to pick BrowserStack App Live

- You need to see the app on real phones, or on many phone models and OS versions.
- You test release builds (IPA files) or apps from the stores.
- Your testers are outside your network and you don't want to give them a VPN.
- Nobody on your team wants to look after a Mac.

## How to switch the simulator part

1. On a Mac with Xcode and idb:

   ```bash
   git clone https://github.com/mariusud/devicepool && cd devicepool
   pnpm install && npm install -g ./packages/devicepool
   devicepool up
   ```

2. Open the link it prints. Invite your testers from the console's People page.
3. A tester opens the console, takes a device, installs the build and tests. Record makes the
   bug link.

From a terminal, the same thing is:

```bash
devicepool login http://your-mac.local:7420
devicepool lease --record
devicepool install MyApp.app
devicepool release
devicepool recordings
```

Uploading a build needs an operator, or a build an operator has registered
([details](../guides/expo.md#uploading-a-build-needs-permission)). The guides:
[recordings](../guides/recordings.md), [Android](../guides/android.md).

## Sources

Read on 2026-11-22:

- [browserstack.com/app-live](https://www.browserstack.com/app-live) for what App Live is and
  does.

Devicepool is not affiliated with BrowserStack.
