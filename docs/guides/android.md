# Android emulators and phones

`devicepool up --android <avd>` adds Android emulators next to the iOS simulators. Each device is a
read-only instance of that Android virtual device, booted from its snapshot, so nothing a lease
does is saved: releasing the device kills the instance and the next one starts as the AVD was.

## Set up the AVD once

Install Android Studio, make a virtual device in its Device Manager (an arm64 system image on
Apple silicon), and boot it once from Android Studio so it has a snapshot. Get it into the state
every lease should start from: skip the setup screens, sign out of Google, then close it, which
saves the snapshot. Devicepool never writes to it.

```bash
~/Library/Android/sdk/emulator/emulator -list-avds
devicepool up --android Pixel_8a_API_36
```

Devicepool finds the SDK in `ANDROID_HOME`, `ANDROID_SDK_ROOT` or `~/Library/Android/sdk`. The
emulators use console ports from 5600 up, so an emulator you start yourself on 5554 is left
alone. A Mac that joins another broker adds the same flag: `devicepool join <url> --token ...
--android Pixel_8a_API_36`.

## Lease one

```bash
devicepool lease --android
```

From code, the device class is `{ platform: 'android-emulator' }`, and the MCP `lease_device`
tool takes `platform`. Without a platform, a lease takes any free simulator or emulator, never
a phone.

## Your app on a leased emulator

From a React Native or Expo app folder:

```bash
devicepool run android
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
- Maestro flows, through `devicepool run maestro` or a run.
- The Metro tunnel: the device's `localhost:8081` reaches the lease's tunnel through
  `adb reverse`.

Typing goes through `adb shell input text`, which takes printable ASCII only. Push
notifications, permissions, app language and recordings are iOS only for now and fail with
`NOT_ON_ANDROID`.

## Espresso

```bash
./gradlew assembleDebug assembleDebugAndroidTest
devicepool run espresso --app app/build/outputs/apk/debug/app-debug.apk \
  --test-apk app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk \
  --tests com.example.LoginTest,com.example.HomeTest --shards 2 --junit espresso.xml
```

Each shard gets a fresh emulator, installs both APKs and runs `am instrument` for its classes.
A failed class is retried once on its own, flaky classes are marked, and the results merge into
one JUnit report, like Maestro and XCUITest runs. Without `--tests` the whole suite runs on one
device. Retries are not recorded on Android yet.

## Phones over USB

`devicepool up --phones` (or `devicepool join ... --phones`) offers the Android phones attached
to the Mac. It works with or without `--android <avd>`. Phones are off unless you pass the flag,
because a phone on a USB port may be somebody's own.

Set a phone up once: turn on Developer options and USB debugging, plug it in, and accept the
"Allow USB debugging?" prompt with "Always allow from this computer" ticked. Set the screen lock
to None, since Devicepool cannot enter a PIN. Use a test phone with no personal accounts and no
SIM, and do not install the app under test beforehand.

The agent reads `adb devices -l` every three seconds. Every serial that is not an emulator's
and is in state `device` becomes a device with platform `android-device`. A phone can be plugged
in or unplugged while Devicepool runs. A phone that adb lists but cannot use shows as
`quarantined` in `devicepool devices` with what to do: accept the debugging prompt for
`unauthorized`, plug it in again for `offline`. Unplugging a leased phone ends the lease with
`device_lost`.

```bash
devicepool lease --phone
devicepool run android --lease <lease id>
```

A lease gets a phone only when it asks for one, with `--phone` or
`{ platform: 'android-device' }`. `devicepool run android` leases an emulator unless you pass
it a phone lease with `--lease`.

On a leased phone the same code runs as on an emulator, through adb: the H.264 screen from
`screenrecord`, screenshots, the element tree, tap, long press, swipe, type, keys, install,
launch, terminate, open a URL, dark mode, rotation, Maestro, Espresso, the app log and the Metro
tunnel through `adb reverse`. Two things differ. Location fails with `NOT_ON_PHONE`, because it
is set through the emulator console. Uninstalling an app that was on the phone before the lease
fails with `IN_BASELINE`. At the start of a lease the agent wakes the screen and keeps it on
while the phone is plugged in.

### The wipe

An emulator is wiped by killing it. A phone is wiped by undoing the lease
([decision 0015](../decisions/0015-a-phone-is-wiped-by-undoing-the-lease-and-reading-it-back.md)):

1. Before the lease starts, the agent records the phone: third-party packages and the path of
   each APK, every path under `/sdcard` (apart from `/sdcard/Android`) and `/data/local/tmp`,
   the three animation scales, stay-awake, the two rotation settings, night mode, and the
   `adb reverse` and `adb forward` mappings. The record is kept in `~/.devicepool/phones/`
   until the wipe is verified.
2. When the lease ends, the agent removes port mappings that were not there, uninstalls every
   package that was not there, runs `pm clear` on apps the lease installed or launched through
   Devicepool that stay on the phone, deletes every path that was not there, and puts the
   settings back.
3. It records the phone again and compares. If everything matches, the phone is `ready`. If
   not, the phone is `quarantined`, and `devicepool devices` and the agent's log say what
   differs, for example an app that refused to uninstall. Fix it on the phone, then unplug the
   phone and plug it in again, which runs the wipe and the check once more. To accept the
   phone as it is, delete its `.baseline.json` file in `~/.devicepool/phones/` before plugging
   it in.

If Devicepool stops or the phone is unplugged during a lease, the record stays on disk and the
phone is wiped the next time the agent sees it, before anyone can lease it.

The wipe does not factory-reset the phone, and it does not cover:

- data inside apps that were on the phone before the lease, unless the lease installed or
  launched them through Devicepool. An app the lease opened by tapping its icon keeps its data;
- accounts signed in to Android or to system apps, such as a Google account;
- an app from before the lease that the lease installed over. The check notices and
  quarantines the phone, and an operator has to install the earlier version again;
- files from before the lease that the lease changed or deleted, and `/sdcard/Android`;
- other settings: Wi-Fi networks, Bluetooth pairings, language, default apps, permissions;
- contacts, messages, call history, the clipboard and notifications;
- other users and work profiles.

Files that the phone's own apps create during a lease, such as a photo a chat app receives, are
deleted with the lease's files. This is one more reason to keep personal phones out of the pool.

### What was tested

No phone was attached to the Mac this was written on. The parsing of `adb devices -l`, phones
arriving and leaving, the wipe plan, the comparison and the on-disk record are tested against a
fake phone that answers the same adb commands. Nothing has run against real hardware: not
discovery, not a lease, not the stream, not the wipe. The commands most likely to differ
between phones are `find` on shared storage, `cmd uimode night`, `screenrecord` on phones whose
maker limits it, and uninstalling apps that a device policy protects.
