# Run an Expo or React Native app on a leased simulator

You need a Mac running `devicepool up` that your machine can reach, and a React Native app with an
`ios` folder. Devicepool is not on npm yet, so run the CLI from a clone:

```bash
git clone https://github.com/mariusud/devicepool && cd devicepool
pnpm install && npm install -g ./packages/devicepool
```

## Sign in once

```bash
devicepool login http://studio-mini.local:7420
```

The browser opens the console, you approve, and the CLI saves a token in
`~/.devicepool/client.json`.

## Run your app

From the app folder:

```bash
npx expo prebuild -p ios   # Expo apps without an ios folder, once
devicepool run ios
```

`devicepool run ios`:

1. Builds the Debug simulator app with `xcodebuild`, in Xcode's usual DerivedData, so later runs
   are incremental. If your app builds another way, pass the result: `--app path/to/App.app`.
2. Starts Metro on this machine (`expo start --localhost`), or uses the one already on the port
   (`--port`, default 8081).
3. Leases a simulator, installs the app and launches it. The app loads its JavaScript from your
   Metro through Devicepool. An Expo dev client build opens straight into your bundle.
4. Opens the live screen in your browser.

Edit a file and Fast Refresh updates the leased device, usually within 200 ms. Press Ctrl-C to
release the device; Devicepool wipes it.

## Run without Xcode

On Linux, or anywhere you don't want to build, install a build Devicepool already has instead:

```bash
devicepool run ios --build my-app-dev --port 8081 --port 4000
```

`--build` takes the name of a registered build (`GET /v1/builds` lists them), such as a
development client your CI registers every night. The first `--port` is Metro; each other one is
forwarded too, so the app reaches a server on this machine, such as a GraphQL server on 4000, at
`localhost:4000`. On an iOS simulator that port can be taken by another lease on the same Mac;
then Devicepool picks another port and prints which one, and the app has to use that one. Android
emulators always get the port you asked for.

Every connection goes out from this machine to the broker, over the lease's tunnel socket, so it
works from a container or a sandbox that nobody can connect in to. `devicepool run android` takes
the same options.

To run on a lease made elsewhere, pass `--lease <id>` (or set `DEVICEPOOL_LEASE`). With a token made
for that one lease (see [Connect an AI agent](agents.md#a-token-for-one-lease)), the sandbox can
drive that device and nothing else. Ctrl-C then leaves the lease to whoever made it.

## Debug with React Native DevTools

Once the app's JavaScript runs, `devicepool run ios` prints a React Native DevTools link. It opens
the debugger for the app on the leased simulator: the console, breakpoints, the network panel,
React components and the profiler. The debugger talks to your own Metro, and Metro talks to the
app through the same tunnel as the bundle; a console evaluate takes about 5 ms there and back.

The link uses `127.0.0.1`, not `localhost`. Expo's dev server closes debugger connections whose
origin is not exactly its own address, without an error, so a `localhost` link shows an empty
DevTools window.

## Things to do on the device

With the lease running, in another terminal:

```bash
devicepool dev-menu                          # the React Native dev menu (command-D)
devicepool reload                            # reload the bundle (command-R)
devicepool open-url myapp://settings         # a deep link
devicepool push com.example.app '{"aps":{"alert":"Hello"}}'
devicepool permission grant location com.example.app
devicepool location 59.91,10.75
devicepool appearance dark
devicepool language com.example.app nb-NO    # then relaunch the app
```

## Uploading a build needs permission

Installing an app you built yourself uploads it to the Mac, and an app is code that runs there.
Today only operators can upload. Ask an operator to make you one, or to register builds for you
(`POST /v1/builds`), which members can install by name.
