# Android emulators

`hangar up --android <avd>` adds Android emulators next to the iOS simulators. Each device is a
read-only instance of that Android virtual device, booted from its snapshot, so nothing a lease
does is saved: releasing the device kills the instance and the next one starts as the AVD was.

## Set up the AVD once

Install Android Studio, make a virtual device in its Device Manager (an arm64 system image on
Apple silicon), and boot it once from Android Studio so it has a snapshot. Get it into the state
every lease should start from: skip the setup screens, sign out of Google, then close it, which
saves the snapshot. Hangar never writes to it.

```bash
~/Library/Android/sdk/emulator/emulator -list-avds
hangar up --android Pixel_8a_API_36
```

Hangar finds the SDK in `ANDROID_HOME`, `ANDROID_SDK_ROOT` or `~/Library/Android/sdk`. The
emulators use console ports from 5600 up, so an emulator you start yourself on 5554 is left
alone. A Mac that joins another broker adds the same flag: `hangar join <url> --token ...
--android Pixel_8a_API_36`.

## Lease one

```bash
hangar lease --android
```

From code, the device class is `{ platform: 'android-emulator' }`, and the MCP `lease_device`
tool takes `platform`. Without a platform, a lease takes any free device.

## Your app on a leased emulator

From a React Native or Expo app folder:

```bash
hangar run android
```

It builds the debug APK with `android/gradlew assembleDebug` (or takes `--app app-debug.apk`),
starts Metro on this machine unless one is running, leases an emulator, opens the Metro tunnel,
installs and launches the app, and opens the live screen. An Expo dev client is opened with its
`exp+<slug>` link, the slug read from `app.json`. Ctrl-C releases the emulator. For an Expo app
without an `android` folder, run `npx expo prebuild -p android` first.

## What works

- The live screen in the console, as H.264 from the emulator's own encoder. It needs the console
  on HTTPS or localhost, because browsers decode H.264 only there; there is no JPEG fallback yet.
- Screenshots, the element tree (from uiautomator: `identifier` is the view's resource id without
  the package, which React Native sets from `testID`), tap, long press, swipe, type, keys.
- Install an `.apk`, launch, terminate, uninstall, open a URL, dark mode, location.
- Maestro flows, through `hangar run maestro` or a run.
- The Metro tunnel: the device's `localhost:8081` reaches the lease's tunnel through
  `adb reverse`.

Typing goes through `adb shell input text`, which takes printable ASCII only. Push
notifications, permissions, app language and recordings are iOS only for now and fail with
`NOT_ON_ANDROID`.

## Espresso

```bash
./gradlew assembleDebug assembleDebugAndroidTest
hangar run espresso --app app/build/outputs/apk/debug/app-debug.apk \
  --test-apk app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk \
  --tests com.example.LoginTest,com.example.HomeTest --shards 2 --junit espresso.xml
```

Each shard gets a fresh emulator, installs both APKs and runs `am instrument` for its classes.
A failed class is retried once on its own, flaky classes are marked, and the results merge into
one JUnit report, like Maestro and XCUITest runs. Without `--tests` the whole suite runs on one
device. Retries are not recorded on Android yet.
