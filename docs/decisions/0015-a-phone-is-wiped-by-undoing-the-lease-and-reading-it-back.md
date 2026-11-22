# 0015. A phone is wiped by undoing the lease and reading it back

- **Status:** Accepted
- **Date:** 2026-11-22
- **Amends:** the device section of [the design](../design.md), which wipes by "delete and clone"

## Context

A simulator or emulator is wiped by deleting it: the next lease gets a new clone or a new
read-only instance, so nothing can survive. A phone on USB cannot be deleted. A factory reset
would clear it, but it also turns USB debugging off and forgets the Mac's adb key, so the phone
would leave the pool until someone walked over and set it up again.

The rule still holds for phones: a device returns to the pool only after a verified wipe.

## Decision

- **The baseline is the phone as the lease finds it.** Before a lease may do anything, the agent
  records the phone: third-party packages with the path of each APK, the name of every package
  including system apps, every path under `/sdcard` (apart from `/sdcard/Android`) and
  `/data/local/tmp`, six settings and the night mode, and the `adb reverse` and `adb forward`
  mappings. It writes this to `~/.devicepool/phones/<device id>.baseline.json` before it answers
  the broker. The file is written to a temporary name, synced and renamed, so a crash leaves the
  old record or the new one.
- **A phone that cannot be read in full gets no baseline.** A file the listing misses would look
  like a file the lease made, and the wipe would delete it. So the listing reports the exit
  status of `find`, and the agent refuses the baseline when that status is not zero, when the
  listing ends early, when `sys.user.0.ce_available` says the storage is locked, or when
  `/sdcard` is empty. A phone that does not set the property is accepted when the listing
  succeeded and `/sdcard` is not empty. The lease then fails with an error that says to unlock
  the phone once after a reboot, nothing on the phone is changed, and no record is kept. The
  readings during the wipe follow the same rule, so a phone that cannot be read is quarantined.
- **File names are taken as they are.** The listing separates names with NUL and no name is
  trimmed. A name with a control character, or with bytes that are not UTF-8, is never passed to
  `rm`: the file stays, and the second reading quarantines the phone with a note that names it.
- **The wipe undoes the lease.** It removes port mappings that are not in the baseline,
  uninstalls every package that is not in the baseline, deletes every path that is not in the
  baseline, puts the recorded settings back and presses home. It runs `pm clear` only on a
  package that was not on the phone before the lease, cannot be uninstalled as a third-party
  package, and is still installed. It never runs `pm clear` on a package from the baseline,
  system apps included, because that data belongs to the phone's owner.
- **Only the settings in the code are written.** The wipe writes the six settings and the night
  mode it knows by name. A record that names any other setting fails the wipe before any command
  is sent. On a phone without `cmd uimode night` (Android 9 and older) the night mode is not
  recorded and not restored.
- **Verification is a second reading.** After the steps the agent records the phone again and
  compares it with the baseline. Any difference, or a `pm clear` that did not answer `Success`,
  fails the wipe. A step that throws does not fail the wipe on its own; the second reading
  decides.
- **A failed wipe quarantines the phone.** The device's `note` says what differs and what to do,
  the agent logs it, and `devicepool devices` prints it. The baseline file stays. Unplugging the
  phone for ten seconds and plugging it in again runs the wipe and the check once more.
- **The baseline file marks an unwiped phone.** It is deleted only after a verified wipe. If the
  agent stops, crashes or loses the phone during a lease, the file is still there when the agent
  next sees the phone, and the phone is wiped against it before it is `ready`. A file that is
  there but cannot be read as a record quarantines the phone with a note. It never counts as
  "no record".
- **One phone is one device, and only over USB.** adb lists a phone on Wi-Fi debugging a second
  time, as `host:port` or under an mDNS name starting with `adb-`. The agent offers USB serials
  only and logs each other serial once as skipped, with the reason. Phones adb may not open all
  show the serial `????????????`; each is reported on its own.
- **A phone has left after three scans without it.** A phone that is missing from `adb devices`,
  or not in state `device`, for one or two scans keeps its place and its lease. If a phone is
  dropped while leased and comes back before the broker has ended the lease, the agent names the
  lease in its `hello` and does not wipe until the broker sends `lease.end`.
- **Work on one phone runs in order.** Recording, the end of a lease, the wipe and enrolling go
  through one queue per phone. A lease that ends while the phone is being recorded waits for the
  record. The wipe also waits, for at most a minute, for operations of the lease that are still
  running, and no operation starts once the lease has ended. A long wipe does not hold up the
  scan or other phones.
- **A lease may not uninstall a package from the baseline.** The agent answers `IN_BASELINE`.
- **Phones are opt-in and asked for by name.** `--phones` turns them on for a host, because a
  phone on a Mac's USB port may be somebody's own. A lease gets a phone only when its class says
  `platform: 'android-device'`, because the wipe below covers less than deleting an emulator.
- **No new message takes a serial.** Phones appear in the agent's inventory under an id made
  from a hash of the serial, and the agent maps a lease to its phone as it does for emulators.

## What the wipe does not cover

The second reading can only compare what adb can read without root. These survive a lease:

- Data inside apps that were on the phone before the lease, system apps included. The wipe does
  not reset it, however the lease opened the app: through Devicepool, by tapping, by a link or
  from a test flow. A lease that signs in to the phone's browser leaves that sign-in behind.
- Accounts signed in to system apps or to Android itself, such as a Google account.
- An app from the baseline that the lease installed over. The wipe notices, because the APK path
  changes, and quarantines the phone; it cannot put the earlier version back.
- Files from the baseline that the lease changed or deleted, and everything under
  `/sdcard/Android`.
- Files with a control character or bytes that are not UTF-8 in their name. The wipe notices
  them and quarantines the phone; an operator deletes them.
- Settings other than the seven recorded ones: Wi-Fi networks, Bluetooth pairings, language,
  default apps, permissions granted to baseline apps, developer options.
- Contacts, messages, call history, the clipboard, notifications, and rows in the media
  database for files that were removed.
- Other users and work profiles on the phone.

## Consequences

Phones in the pool should be test phones: no personal accounts, no SIM, no screen lock, and the
app under test not installed beforehand. For such a phone the wipe returns what a lease can
reach through Devicepool. For a personal phone it does not protect the owner's data from a
lease, and files the phone's own apps create during a lease are deleted with the lease's files.

A change someone makes to the phone between leases becomes part of the next baseline, so adding
an app to every lease is installing it while the phone is free.

A phone that its lease installed over a baseline app stays quarantined until an operator
reinstalls the earlier version, or deletes the baseline file to accept the phone as it is.

A phone that restarts stays out of leases until someone unlocks it once, because its files
cannot be listed before that. An app on the phone that updates itself during a lease changes its
APK path and quarantines the phone, so automatic updates should be off on pool phones.
