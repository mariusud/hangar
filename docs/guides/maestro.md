# Maestro flows

`hangar run maestro` splits a folder of Maestro flows over fresh devices, retries a failed flow on
the same device, marks flows that pass on a retry as flaky, and writes one JUnit report.

```bash
hangar run maestro .maestro --app build/Build/Products/Release-iphonesimulator/MyApp.app \
  --shards 3 --junit hangar-maestro.xml -e TEST_USER=qa@example.com
```

`--app` is a built simulator `.app`, an archive of one, or the name of a build already on Hangar.
Use a Release build, so the JavaScript is in the app and no Metro is needed. The options:

- `--shards N` leases N devices and gives each a share of the flows, longest first by each flow's
  last timing. Shards wait in Hangar's queue like any lease.
- `--retries N` retries a failed flow N times (default 1, at most 3), each retry recorded.
- `-e KEY=VALUE` passes a variable to the flows; repeat it for more.
- `--model M` asks for a simulator model, such as `iPhone 17`.
- `--junit file.xml` writes the merged report.
- `--hold 30m` keeps a failed flow's device as it was (below).

The broker runs the flows (`POST /v1/runs`), so the console's Runs page shows the run live, and
Ctrl-C or the page cancels it. `config.yaml` in the folder is Maestro's own settings file and is
not run as a flow. The output ends with each flow's result and links to the recordings of failed
and flaky attempts; [GitHub Actions](github-actions.md) covers recordings, the pull request
comment, reruns of one flow and flake rates.

## Keep the device a flow failed on

```bash
hangar run maestro .maestro --app MyApp.app --shards 3 --hold 30m
```

With `--hold`, a shard whose flow still fails after its retries isn't wiped. Its device stays as
the test left it, with the app and its data, for the time you give (`30m`, `2h`, up to 4 hours).
One device is held per shard, for the first flow in it that failed. The output shows it under the
flow:

```
FAIL  login.yaml (shard 2, 2 attempts)
      Assertion is false: "Welcome" is visible
      recording (first attempt): https://hangar.example.ts.net/recordings/...
      recording (last attempt): https://hangar.example.ts.net/recordings/...
      device held until 14:32:10: hangar held <run-id> login.yaml
```

Take the device with that command:

```bash
hangar held <run-id> login.yaml
```

It prints a lease id and the link to watch and drive the device in the console. The live screen
and the Metro tunnel reach a held device like any other. The API is
`POST /v1/runs/:id/flows/:flow/hold-lease`.

- Only a person on the run's team can lease a held device. Agent tokens and booking tokens get
  `HOLD_FOR_TEAM`.
- One person at a time: a second one gets `HOLD_IN_USE` with the name of who is on it.
- A held device counts against the team's quota until it is wiped.
- The device is wiped when the hold time ends or when your lease of it ends, whichever comes
  first, and then goes back to the pool as usual. `DELETE /v1/runs/:id/flows/:flow/hold` lets it
  go sooner.

The GitHub Action has no input for `--hold` yet, and the pull request comment doesn't link to a
held device. Held devices are tested against fake hosts only.

## When a shard is preempted

A run's shards have the priority of the token that started it. A `ci` request can end a
lower-priority lease with two minutes' notice (see
[Night QA](night-qa.md#priority-and-preemption)), so a shard started with a booking token or a
person's token can lose its device. When that happens, the flows it hadn't finished go back to
the queue with the message "The device was taken for a higher-priority lease." and run again on
another lease. Flows that had finished keep their results. After three interrupted tries the
remaining flows fail with "Gave up after 3 tries."

Shards started with a `ci` token are not preempted, since nothing ranks above them.
