# Device images

A plain lease gets a fresh simulator with nothing installed. If every test starts by installing
the same app and switching the language, a device image does that once per Mac instead.

An image is a name, the builds to install, and optionally a locale, an appearance, permissions
granted to its apps and a sign-in flow. Operators declare it:

```bash
hangar image set norsk --app ./build/MyApp.app --locale nb_NO --appearance dark
```

`--app` is a path, which is uploaded as a build, or the name or hash of a build already on the
broker. Repeat it for more apps; they install in order.

Every iOS host builds the image once: it clones its plain golden device, boots it, installs the
apps, grants the permissions, sets the locale and appearance, runs the sign-in flow, and shuts
it down. That copy is the image's golden device.
The host then keeps one clone of it ready, next to its plain devices, within its `--max`.

Lease one:

```bash
hangar lease --image norsk
```

The API takes `{ "class": { "image": "norsk" } }`, and the MCP tool `lease_device` takes
`image`. A lease asked for right after the image is declared waits until the host has built it.
A request without an image never gets a device from an image.

A leased image device is wiped like any other: deleted on release and replaced by a fresh clone
of the image.

## Permissions

```bash
hangar image set norsk --app ./build/MyApp.app --grant photos,location
```

`--grant` takes a comma-separated list, and can be repeated. Each permission is granted with
`simctl privacy` to every app in the image, so an image with grants needs at least one app. The
services are those of `simctl privacy`: `all`, `calendar`, `contacts`, `contacts-limited`,
`location`, `location-always`, `photos`, `photos-add`, `media-library`, `microphone`,
`motion`, `reminders` and `siri`. `camera` is refused, because the simulator has none.

## A signed-in user

A sign-in flow is one Maestro flow file that the host runs once on the image's golden device,
after the apps, grants, locale and appearance are in place. Every device leased from the image
then starts signed in.

```bash
printf %s "$TEST_PASSWORD" | hangar image secret TEST_PASSWORD
hangar image set norsk --app ./build/MyApp.app --sign-in .maestro/sign-in.yaml \
  --env TEST_USER --env TEST_PASSWORD
```

The flow reads its account details as Maestro variables (`${TEST_USER}`), and `--env` names
them. The declaration holds only the names; keep the values out of the flow file and the
repository. For each name the host takes the value from the broker's secret store, or, if the
store doesn't have it, from the environment `hangar up` or `hangar join` runs in. If neither has
a value, the build fails with `SIGN_IN_ENV_MISSING` and the name.

`hangar image secret NAME` reads the value from standard input, so it doesn't land in your shell
history, and `hangar image secret NAME --rm` removes it. Only operators can set or list secrets,
and `GET /v1/image-secrets` returns names and times only. `GET /v1/images` shows a sign-in flow
by its hash and the names it reads, never values. The flow file can be at most 64 KB and read
at most 32 names. Maestro has to be installed on each iOS host that builds the image.

### What is stored where

- The broker keeps the flow text and the variable names in its database, with the image.
- The broker keeps secret values in the same SQLite database, unencrypted. Anyone who can read
  the broker's data folder, a backup of it, or a file from `hangar export` can read them.
- The broker sends each host the image declarations with the values each sign-in flow reads,
  over the host's connection to the broker, and again whenever an image or a secret changes. The
  host keeps them in memory.
- To run the flow, the host writes it to a temporary folder readable only by its user, runs
  `maestro test` with each value as `-e NAME=value`, and deletes the folder after. Maestro's
  output, if the flow fails, is logged with the values replaced by `***`.
- While Maestro runs, the values are in its command line, and on macOS any user on the Mac can
  see a process's command line with `ps`. Use a test account, and run Hangar on a Mac where you
  trust the other users.

A changed secret is used the next time an image that reads it builds. An image that is already
built keeps the account it signed in with; to build it again, remove it and declare it again.

## Changing and removing

`hangar image set` with the same name replaces the declaration. Each host sees that the hash of
the declaration changed, deletes its copy and the unleased devices made from it, and builds the
new one. The hash covers the apps, locale, appearance, grants, the flow text and the variable
names, but not secret values. `hangar image rm norsk` removes it everywhere. `hangar images`
lists what is declared.

If a build fails on a host, for example because an app is not built for the simulator or the
sign-in flow fails, the host logs why and stops offering the image. It tries again after it
restarts, or when the declaration changes.

## Limits

- iOS simulators only. Android hosts ignore images.
- Each host builds the image from its own Xcode runtime and runs the sign-in flow itself;
  nothing is copied between hosts.
- An image is not rebuilt when a new build of its app is uploaded; declare it again.
- Grants and sign-in flows are tested with fake device steps. They have not yet been built on a
  real simulator.
