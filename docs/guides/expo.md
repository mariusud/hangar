# Run an Expo or React Native app on a leased simulator

You need a Mac running `hangar up` that your machine can reach, and a React Native app with an
`ios` folder. Hangar is not on npm yet, so run the CLI from a clone:

```bash
git clone https://github.com/mariusud/hangar && cd hangar
pnpm install && npm install -g ./packages/hangar
```

## Sign in once

```bash
hangar login http://studio-mini.local:7420
```

The browser opens the console, you approve, and the CLI saves a token in `~/.hangar/client.json`.

## Run your app

From the app folder:

```bash
npx expo prebuild -p ios   # Expo apps without an ios folder, once
hangar run ios
```

`hangar run ios`:

1. Builds the Debug simulator app with `xcodebuild`, in Xcode's usual DerivedData, so later runs
   are incremental. If your app builds another way, pass the result: `--app path/to/App.app`.
2. Starts Metro on this machine (`expo start --localhost`), or uses the one already on the port
   (`--port`, default 8081).
3. Leases a simulator, installs the app and launches it. The app loads its JavaScript from your
   Metro through Hangar. An Expo dev client build opens straight into your bundle.
4. Opens the live screen in your browser.

Edit a file and Fast Refresh updates the leased device, usually within 200 ms. Press Ctrl-C to
release the device; Hangar wipes it.

## Debug with React Native DevTools

Once the app's JavaScript runs, `hangar run ios` prints a React Native DevTools link. It opens
the debugger for the app on the leased simulator: the console, breakpoints, the network panel,
React components and the profiler. The debugger talks to your own Metro, and Metro talks to the
app through the same tunnel as the bundle; a console evaluate takes about 5 ms there and back.

The link uses `127.0.0.1`, not `localhost`. Expo's dev server closes debugger connections whose
origin is not exactly its own address, without an error, so a `localhost` link shows an empty
DevTools window.

## Things to do on the device

With the lease running, in another terminal:

```bash
hangar dev-menu                          # the React Native dev menu (command-D)
hangar reload                            # reload the bundle (command-R)
hangar open-url myapp://settings         # a deep link
hangar push com.example.app '{"aps":{"alert":"Hello"}}'
hangar permission grant location com.example.app
hangar location 59.91,10.75
hangar appearance dark
hangar language com.example.app nb-NO    # then relaunch the app
```

## Uploading a build needs permission

Installing an app you built yourself uploads it to the Mac, and an app is code that runs there.
Today only operators can upload. Ask an operator to make you one, or to register builds for you
(`POST /v1/builds`), which members can install by name.
