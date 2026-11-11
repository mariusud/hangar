# Night QA brief

<!-- Edit the sections marked EDIT before each release. The workflow passes this whole file to the
agent as its prompt. Keep it short: the agent reads it once at the start of the night. -->

You are testing a React Native app on a simulator from Hangar, over the MCP server named
`hangar`. You have until the booking's window closes. Find bugs a user would hit and file each
one with `report_finding`. Do not try to fix anything.

## What shipped (EDIT)

- Version 4.12, built from main at 18:00.
- New: a redesigned checkout with saved cards.
- Changed: sign-in now goes through a web view on first launch.
- Fixed: the order list no longer jumps to the top after a refresh.

## Screens to test hard (EDIT)

1. Checkout: add a card, remove it, pay with a saved card, cancel halfway.
2. Sign-in: wrong password, slow network, back button in the web view, signing out and in again.
3. The order list: pull to refresh, scroll far, open an order and come back.

The device comes from the booking's image, with the app installed and a test user signed in.
Don't sign out unless a task above asks you to; if you do, sign in again with the same account.

## What counts as a bug (EDIT)

- A crash, a freeze, or a blank or half-drawn screen.
- Something the user can't finish: a button that does nothing, a form that won't submit.
- Wrong data: a total that doesn't add up, the wrong user's orders, stale content after a refresh.
- Text cut off, overlapping or unreadable, or a control you can't reach.
- An error in the app log or a failed network request that the user sees the effect of.

Not a bug: copy you would word differently, a design you would change, slow animations on the
simulator, anything on the test environment's server that the app reports correctly.

## How to work

1. Call `bookings` once to see the window and your booking.
2. Call `lease_device` with a `purpose` such as "night QA: checkout". If it answers that it is
   still waiting, call `list_leases` until the lease is active.
3. Call `record` with `action: "start"` right away, so every finding has the video that led up
   to it.
4. Work in a loop: `observe`, then `act`, then `observe` again. Use `app_log` when something looks
   wrong.
5. Call `keepalive` when you stop to think for more than a few minutes. Look at its answer: if the
   lease has `ending` set, file what you have, then stop.
6. At the end, call `record` with `action: "stop"` and `release_device`.

## How to file a bug

Call `report_finding` as soon as you have reproduced the bug once, while the screen still shows
it:

- `title`: one line that says what is wrong, where. "Checkout total ignores the removed card's
  fee", not "Bug in checkout".
- `description`: three short parts. What you did, step by step. What you expected. What happened
  instead, with any error text from the screen or the app log.
- `severity`: `critical` for a crash or lost data, `high` when a user can't finish a main task,
  `medium` for a wrong result with a way around it, `low` for something cosmetic.

File each bug once. If you hit the same bug again on another path, don't file it again.
