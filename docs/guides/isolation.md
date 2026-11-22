# What a leased app can reach

An app on an iOS simulator is a normal macOS process. It runs as the user who runs Devicepool, so it
can read that user's files: SSH keys, browser profiles, other projects. Android emulators keep
apps inside the emulated device, but the emulator process itself also runs as that user.

Devicepool deletes each device after its lease, so one lease never sees the next lease's app data.
That does not stop an app from reading the host user's files while it runs.

## Run Devicepool as its own user

On a Mac that runs leases for other people, run Devicepool as a macOS user that holds nothing else.
The simulators then live in that user's home, and apps can read only what that user can.

1. Make the user. This asks for its password:

   ```bash
   sudo sysadminctl -addUser devicepool -fullName "Devicepool" -password -
   ```

2. Log in as `devicepool` once in the macOS login window. Open Xcode, accept the license and let it
   install its components.
3. As `devicepool`, install the tools `devicepool doctor` asks for, then start Devicepool with
   `devicepool up --install` (or `devicepool join ... ` on hosts that join a broker elsewhere).
4. Keep the `devicepool` user logged in, with fast user switching or automatic login. The
   LaunchAgent that `--install` writes runs only while that user is logged in. A LaunchDaemon that
   starts Devicepool as `devicepool` at boot, with nobody logged in, is in
   [unattended.md](unattended.md); it has not been checked through a real reboot.

`devicepool doctor` reports which user Devicepool runs as.

## What this does not protect

The `devicepool` user shares the Mac's kernel and network with everyone else. An app can still reach
anything on the network the Mac can reach, and a macOS vulnerability is not contained. Do not
treat this as a boundary between people who do not trust each other. Running the whole host in
a macOS virtual machine is planned (ROADMAP.md, decision 0010).

Not checked yet: booting simulators while another user holds the screen, with `devicepool` logged in
in the background.
