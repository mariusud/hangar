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
  records the phone: third-party packages with the path of each APK, every path under `/sdcard`
  (apart from `/sdcard/Android`) and `/data/local/tmp`, six settings and the night mode, and the
  `adb reverse` and `adb forward` mappings. It writes this to
  `~/.devicepool/phones/<device id>.baseline.json` before it answers the broker.
- **The wipe undoes the lease.** It removes port mappings that are not in the baseline,
  uninstalls every package that is not in the baseline, runs `pm clear` on packages the lease
  installed or launched through Devicepool that stay on the phone, deletes every path that is
  not in the baseline, puts the recorded settings back and presses home.
- **Verification is a second reading.** After the steps the agent records the phone again and
  compares it with the baseline. Any difference, or a `pm clear` that did not answer `Success`,
  fails the wipe. A step that throws does not fail the wipe on its own; the second reading
  decides.
- **A failed wipe quarantines the phone.** The device's `note` says what differs and what to do,
  the agent logs it, and `devicepool devices` prints it. The baseline file stays. Unplugging the
  phone and plugging it in again runs the wipe and the check once more.
- **The baseline file marks an unwiped phone.** It is deleted only after a verified wipe. If the
  agent stops, crashes or loses the phone during a lease, the file is still there when the agent
  next sees the phone, and the phone is wiped against it before it is `ready`.
- **A lease may not uninstall a package from the baseline.** The agent answers `IN_BASELINE`.
- **Phones are opt-in and asked for by name.** `--phones` turns them on for a host, because a
  phone on a Mac's USB port may be somebody's own. A lease gets a phone only when its class says
  `platform: 'android-device'`, because the wipe below covers less than deleting an emulator.
- **No new message takes a serial.** Phones appear in the agent's inventory under an id made
  from a hash of the serial, and the agent maps a lease to its phone as it does for emulators.

## What the wipe does not cover

The second reading can only compare what adb can read without root. These survive a lease:

- Data inside apps from the baseline that the lease opened by tapping, by a link or from a test
  flow. Only packages installed or launched through Devicepool's own operations are cleared.
- Accounts signed in to system apps or to Android itself, such as a Google account.
- An app from the baseline that the lease installed over. The wipe notices, because the APK path
  changes, and quarantines the phone; it cannot put the earlier version back.
- Files from the baseline that the lease changed or deleted, and everything under
  `/sdcard/Android`.
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
