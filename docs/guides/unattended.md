# Run a Mac unattended

A Mac in a closet should start Hangar on its own after a reboot or a crash. There are two ways,
and both start `hangar up` with the options you give them.

## Start at login (LaunchAgent)

```bash
hangar up --install --warm 2 --url https://studio-mini.example.ts.net
```

This writes `~/Library/LaunchAgents/dev.hangar.up.plist`, which starts Hangar when you log in
and restarts it if it stops, and prints the sign-in link once Hangar is up. The log is
`~/.hangar/hangar.log`. To come back after a reboot with nobody at the Mac, turn on automatic
login for that user (System Settings, Users & Groups); macOS allows that only with FileVault
off. `hangar up --uninstall` removes it.

## Start at boot as a chosen user (LaunchDaemon)

```bash
sudo hangar up --install --system --user hangar --warm 2
```

This writes `/Library/LaunchDaemons/dev.hangar.up.plist`, which starts Hangar when the Mac
boots, as the user you name, with nobody logged in, and restarts it if it stops. Use a standard
user that holds nothing else; [isolation.md](isolation.md) explains why and how to make one.
Before you run it:

- Log in as that user once, so macOS sets up its home folder, and open Xcode there to accept
  the license and install its components.
- Install Node and Hangar where that user can read them, such as under `/usr/local` or `/opt`.
  The command checks this and stops if the user can't read them.
- Install the idb companion, idb and Maestro so they are on one of the usual paths
  (`/opt/homebrew/bin`, `/usr/local/bin`, or `~/.local/bin` and `~/.maestro/bin` in that
  user's home). The daemon's `PATH` lists those, because `sudo` resets it.

The daemon keeps its data and log in the user's `~/.hangar` (or `HANGAR_HOME` if you set it when
you install). If FileVault is on, the command says so: after a reboot the Mac waits for someone
to unlock the disk before anything starts, and `sudo fdesetup authrestart` restarts once
without that wait. `sudo hangar up --uninstall --system` removes the daemon.

Both forms run `hangar up`. A Mac that joins a broker elsewhere with `hangar join` has no
install option yet.

The LaunchDaemon has not been checked through a real reboot with nobody logged in. Its plist
and the checks before writing it are tested; whether simulators boot and stream from a daemon
with no login session is the open question.

## Check the Mac

`hangar doctor` checks Xcode, the iOS runtimes, the idb companion and client, the user Hangar
runs as, and how many simulators fit. When the idb companion is missing because Homebrew
refuses to install it while the Command Line Tools are older than Xcode, the fix it prints says
so and gives two ways out: update the Command Line Tools, or use the prebuilt companion from
the facebook/idb release that the Homebrew formula names, checked against the formula's
sha256. Hangar downloads nothing itself; you run the commands.

## A smoke test for each Xcode

```bash
pnpm bench:smoke
```

In a Hangar checkout, this starts a Hangar with real simulators and goes through boot, clone,
capture, tree, tap and wipe, and with `HANGAR_SMOKE_APP` set to a built `examples/hello` app
also its two Maestro flows. It writes the result for this Xcode build and runtime to
`hosts/versions.json`, or to the file in `HANGAR_VERSIONS`.

With `HANGAR_REQUIRE_SMOKE=1`, `hangar up` doesn't offer simulators on an Xcode build that has
no passing entry in that file, and says why at start; `hangar doctor` then shows the check too.
Without it, Hangar starts whatever the file says.
`hangar up --install` passes both variables on to the service. No entry has been recorded in
this repository's `hosts/versions.json` yet.
