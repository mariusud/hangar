# Run Maestro flows from GitHub Actions

The Hangar action splits your flows over fresh simulators, retries a failed flow once on the
same device, marks flows that pass on the retry as flaky, and writes one JUnit report. The CI
runner needs to reach the Hangar Mac (on the same network, or through a VPN such as Tailscale)
and a token in a secret.

1. An operator makes a token on the console's Connect page with "Can upload apps" ticked,
   because the action uploads the app it tests. Save it as the `HANGAR_TOKEN` secret, and the
   Mac's address as `HANGAR_URL`.
2. Build a Release simulator app, so the JavaScript is in the app and no Metro is needed. Any
   macOS runner, EAS or Bazel can build it; the example below builds on the runner.

```yaml
name: e2e
on: [pull_request]

jobs:
  maestro:
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npx expo prebuild -p ios
      - run: |
          xcodebuild -workspace ios/MyApp.xcworkspace -scheme MyApp -configuration Release \
            -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
            -derivedDataPath build ONLY_ACTIVE_ARCH=YES ARCHS=arm64 build
      - uses: <owner>/hangar@main
        with:
          url: ${{ secrets.HANGAR_URL }}
          token: ${{ secrets.HANGAR_TOKEN }}
          app: build/Build/Products/Release-iphonesimulator/MyApp.app
          flows: .maestro
          shards: 3
          env: |
            TEST_USER=${{ secrets.TEST_USER }}
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: maestro, path: hangar-maestro.xml }
```

`<owner>/hangar` is wherever your copy of this repository lives on GitHub. The action installs
Node 22 and Hangar's own dependencies, then runs `hangar run maestro`. Its inputs are `url`,
`token`, `app` (a path, or the name of a build already on Hangar), `flows` (default
`.maestro`), `shards`, `retries` (default 1), `model`, `env` (one `KEY=VALUE` per line),
`junit` (default `hangar-maestro.xml`), and the inputs for comments and reruns below.

The step fails when a flow fails after its retries. Shards wait in Hangar's queue like any
lease, so a Mac with three simulators runs three shards at once and queues the rest. Cancelling
the job cancels the run, which releases its devices. If the runner dies before it can say so,
the run goes on in Hangar and releases its devices when it ends; cancel it on its page.
`config.yaml` in the flows folder is Maestro's own settings file and is not run as a flow.
[Maestro flows](maestro.md) describes the command itself, including `--hold`, which keeps a failed
flow's device for a person to look at; the action has no input for it yet.

A token made by `hangar connect ci` has the `ci` priority, so its shards go first in the queue,
can end a lower-priority lease with two minutes' notice when every device is busy, and can use
the devices a booking keeps free ([Night QA](night-qa.md#priority-and-preemption)). Shards
started with a person's or a booking's token can be preempted that way; their unfinished flows
then run again on another device ([details](maestro.md#when-a-shard-is-preempted)).

## Recordings of failures

Each shard records its first pass over its flows, and keeps that recording only when a flow in
it fails; when every flow passes, the recording is deleted. Each retry of a failed flow is
recorded on its own. So a failed flow links to the first attempt (the whole shard's first pass)
and to its last attempt, and a flaky flow links to the attempt that failed and the one that
passed. A recording is the video, the timeline of Maestro's taps and the app log, kept for 14
days.

The links are in the job's summary page, in the CLI output, and in the JUnit report, as a
`recording` property (the last attempt) and a `first-recording` property on the test case.

## The pull request comment

On a pull request, the action comments with the counts of passed, flaky and failed flows, a
link to the run on the console's Runs page, and a table of the failed and flaky flows with
their attempts, recording links and error. Passed flows are folded under a summary line. When a
flow failed, the comment ends with the command that reruns it.

The next run of the same job edits that comment instead of adding a new one. The comment's
first line is a hidden marker with a key made from the workflow name, the job name and the
`comment-key` input; set `comment-key` when one job uses the action more than once, such as in
a matrix. The inputs:

- `comment` is `'true'` by default; set it to `'false'` for no comment.
- `pr` is the pull request number, by default the one that started the workflow. Without one,
  for example on a schedule, no comment is written.
- `github-token` writes the comment, by default the job's `github.token`. It needs
  `pull-requests: write`, so add that to the workflow's `permissions`.

The comment step uses the GitHub CLI (`gh`), which GitHub's hosted runners have. When `gh` is
missing or the token can't write, the step prints a warning and the job's result doesn't
change.

## Run one flow again

A finished run keeps its build, its flows and the names (not the values) of its environment
variables, so one flow of it can run again on a fresh device, recorded:

```bash
hangar run maestro --rerun <run-id> --flow login.yaml
```

The run id is the last part of the run's link. The action does the same with the `rerun` and
`rerun-flow` inputs, and needs no `app` then. The API is
`POST /v1/runs/:id/flows/:flow/rerun`; anyone on the run's team can call it.

The result goes into the original run. Every attempt counts toward the flow's status: a flow
that failed and then passes on the rerun is flaky, and the first failure and its recording are
kept. The run's state is worked out again from its flows, and the pull request comment for that
run is updated if the rerun names the same `pr`.

Hangar keeps environment values in memory only. After the broker restarts, a rerun of a run
that had `env` answers `ENV_NEEDED` until you pass the values again with `-e KEY=VALUE` (or the
action's `env` input). A rerun also needs the run's build to still be on Hangar, and a run that
is still going can't be rerun.

## A nightly run

[examples/workflows/hangar-nightly.yml](../../examples/workflows/hangar-nightly.yml) runs every
flow at 03:00 UTC with two retries, and has a manual "Run workflow" form on the Actions tab
that reruns one flow of a past run, optionally updating a pull request's comment. Copy it to
`.github/workflows/` and change the build steps to match your app. To run it inside a booking's window, make its
token with `hangar connect <booking>`, which also prints the cron for the window in UTC
([Night QA](night-qa.md#tokens-for-a-booking)).

## Flaky tests

`GET /v1/tests/flaky` looks at your team's last 200 runs. It lists each test that was flaky or
failed at least once, with its flake rate and failure rate (out of the runs it was in), sorted
by flake rate, and groups failures by error message. Two messages that differ only in numbers,
ids and hex addresses are one group, with a count, the tests it hit, the latest example and a
recording. `hangar tests` shows the plain counts from `GET /v1/tests`.

The comment, the rerun and the nightly example are tested with recorded runs and a fake agent.
None of them has yet run on a real GitHub runner against a real Hangar.
