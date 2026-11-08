# Device images

A plain lease gets a fresh simulator with nothing installed. If every test starts by installing
the same app and switching the language, a device image does that once per Mac instead.

An image is a name, the builds to install, and optionally a locale and an appearance. Operators
declare it:

```bash
hangar image set norsk --app ./build/MyApp.app --locale nb_NO --appearance dark
```

`--app` is a path, which is uploaded as a build, or the name or hash of a build already on the
broker. Repeat it for more apps; they install in order.

Every iOS host builds the image once: it clones its plain golden device, boots it, installs the
apps, sets the locale and appearance, and shuts it down. That copy is the image's golden device.
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

## Changing and removing

`hangar image set` with the same name replaces the declaration. Each host sees that the hash of
the declaration changed, deletes its copy and the unleased devices made from it, and builds the
new one. `hangar image rm norsk` removes it everywhere. `hangar images` lists what is declared.

If a build fails on a host, for example because an app is not built for the simulator, the host
logs why and stops offering the image. Declare it again with the fix to retry.

## Limits

- iOS simulators only. Android hosts ignore images.
- Images hold apps, a locale and an appearance. Signed-in accounts and granted permissions are not
  part of an image yet.
- Each host builds the image from its own Xcode runtime; nothing is copied between hosts.
