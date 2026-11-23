# Run Maestro flows from GitHub Actions

The Devicepool action splits your flows over fresh simulators, retries a failed flow once on the
same device, marks flows that pass on the retry as flaky, and writes one JUnit report. It runs
in one of two ways, and the `url` input picks which:

| | On the runner | On your Devicepool server |
|---|---|---|
| Picked by | no `url` input | `url` and `token` inputs |
| What you need | a GitHub-hosted macOS runner | a Mac running `devicepool up` that the runner can reach |
| Simulators | 1 on a standard runner (3 cores, 7 GB) | as many as your Macs hold |
| Recordings of failures | files in a workflow artifact | links to the console, kept 14 days |
| Rerun one flow, `hold`, `booking`, the console | no | yes |
| Tested on a real GitHub runner | no | no |

## On the runner, with no server

This is the way to try Devicepool without a Mac of your own. The whole workflow:

```yaml
name: e2e
on: [pull_request]
jobs:
  maestro:
    runs-on: macos-26
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - run: ./build-simulator-app.sh   # your build; it leaves a simulator .app
      - uses: mariusud/devicepool@main
        with:
          app: build/Build/Products/Release-iphonesimulator/MyApp.app
```

[examples/workflows/devicepool-runner.yml](../../examples/workflows/devicepool-runner.yml) is the
same with the build steps of an Expo app written out. The flows are read from `.maestro` unless
you set `flows`.

Runner mode has not run on a real GitHub runner yet. The input checks and the start, run and
stop steps were run on a Mac against a stand-in for the `devicepool` command, and every flag
was checked against the CLI's source. The install of Devicepool, idb and Maestro on a runner
image, the simulator boot time, and recording on a runner are untested. If it fails, open an
issue with the job log.

With no `url`, the action does this on the runner:

1. Sets up Node 22 and installs Devicepool from the action's own checkout with pnpm (the
   package is not on npm yet).
2. Installs what `devicepool doctor` checks for and the runner image lacks: idb-companion with
   Homebrew, the idb client with `pipx install fb-idb`, and Maestro with its install script.
   A tool that is already on `PATH` is left alone. Maestro needs Java, which GitHub's macOS
   images have.
3. Starts `devicepool up --max N --warm N` in the background on port 7420, with its data in
   the runner's temp folder, and waits for the line "Devicepool is running at". Devicepool
   creates one simulator and boots it once before that line, then clones it for each shard.
   `devicepool up` has no option to listen on 127.0.0.1 only, so it listens on every address
   of the runner's virtual machine until the job ends. The log, which is printed in the job
   and kept in the artifact, has a one-use admin sign-in link for that address.
4. Runs `devicepool run maestro` with your `app`, `flows`, `shards`, `retries` and `env`,
   signed in with the admin token `devicepool up` saved on the runner.
5. Stops Devicepool, which deletes its simulators, and uploads one artifact.

### The runner and Xcode

Use `runs-on: macos-26`. idb-companion's Homebrew formula (1.7.8 at the time of writing) asks
for macOS 15 or newer and Xcode 26.0 or newer, and Devicepool's drivers are checked against
Xcode 26. On `macos-15` you would have to select an Xcode 26 before the action.

The action uses the Xcode that `xcode-select` points to, the newest iOS runtime it lists and the
newest plain iPhone model (such as iPhone 17). To use another Xcode, select it in a step before
the action: `sudo xcode-select -s /Applications/Xcode_<version>.app`. Leave the `model` input
out in runner mode, because the runner offers that one model only. Build the app for the
simulator (`-sdk iphonesimulator`) and for arm64; the action stops with a message when the
`.app` is a device build or the path does not exist.

### How many simulators

GitHub's [standard macOS runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
(`macos-26`, `macos-15`, `macos-latest`) has 3 cores, 7 GB of memory and 14 GB of disk. The
[xlarge runner](https://docs.github.com/en/actions/reference/runners/larger-runners)
(`macos-26-xlarge`) has 5 cores and 14 GB of memory. A booted simulator takes about 2.5 GB.

When `shards` is left out, the action reads the runner's cores and memory and uses one
simulator per 2 cores and per 2.5 GB, after keeping 4 GB for macOS, Node and Maestro. That is
1 simulator on a standard runner and 2 on an xlarge one. With 1 simulator the flows run one
after another on one fresh simulator, with retries and recordings as on a server. You can set
`shards: 2` on a standard runner; two simulators need about 5 of its 7 GB, and that has not
been tried. For more devices at once, use an xlarge runner or a server.

### Time limits

- `start-timeout` (default 15 minutes) is how long the action waits for Devicepool to be
  ready. The first simulator boot on a runner is slow, and it has not been measured yet.
- The action sets `MAESTRO_DRIVER_STARTUP_TIMEOUT` to 300000 ms (5 minutes) for Maestro's
  driver, unless the job's `env` already sets it.
- One Maestro invocation, which is one shard's pass over its flows or one retry, is stopped
  after 30 minutes by Devicepool.
- Set `timeout-minutes` on the job. A composite action cannot set a timeout for itself.

### What the job keeps

The action uploads one artifact, named by the `artifact` input (default `devicepool-maestro`;
give each job its own name in a matrix):

- the JUnit report,
- `devicepool.log`, the output of `devicepool up`,
- `recordings/<id>/` for each kept recording: `video.mp4`, the timeline of Maestro's taps and
  the app log. Which recordings are kept is described under
  [Recordings of failures](#recordings-of-failures).

The runner's Devicepool is gone when the job ends, so there is no console page to link to. In
the job summary and the pull request comment, the action replaces each recording link with
`recordings/<id>`, the folder in the artifact, and points the run link at the workflow run.
The JUnit report and the step's log still carry `http://127.0.0.1:7420/recordings/<id>`; the
last part is the folder name.

<!-- {% raw %} -->

`rerun`, `hold` and `booking` need a server, and the action stops with a message when one is
set without `url`. A pull request from a fork gets no secrets, so a workflow that passes
`url: ${{ secrets.DEVICEPOOL_URL }}` runs in runner mode there when the job is on macOS, and
stops with a message on Linux. When `token` is set and `url` is empty, the action stops and
says so, because that is usually a missing secret.

<!-- {% endraw %} -->

## On your Devicepool server

The CI runner needs to reach the Devicepool Mac (on the same network, or through a VPN such as
Tailscale) and a token in a secret. Workflows written before runner mode existed work as they
did.

1. An operator makes a token on the console's Connect page with "Can upload apps" ticked,
   because the action uploads the app it tests. Save it as the `DEVICEPOOL_TOKEN` secret, and the
   Mac's address as `DEVICEPOOL_URL`.
   An image declared with `--follow` takes any upload under its app's build name, so a job that
   runs a pull request's code should get a token limited to a name prefix instead:
   `devicepool connect ci pr-` uploads only builds named `pr-...`. Keep the full token for jobs on
   the main branch, for example in a GitHub environment that only `main` can deploy to.
   A prefix token can upload only names that start with its prefix, and the action uploads the
   app under its folder name (`MyApp.app`) unless told otherwise. Pass `build-name` a name that
   starts with the prefix, such as `pr-` and the pull request number:

   <!-- {% raw %} -->
   ```yaml
         - uses: mariusud/devicepool@main
           with:
             url: ${{ secrets.DEVICEPOOL_URL }}
             token: ${{ secrets.DEVICEPOOL_TOKEN }}
             app: build/Build/Products/Release-iphonesimulator/MyApp.app
             build-name: pr-${{ github.event.pull_request.number }}
   ```
   <!-- {% endraw %} -->

   Outside the action, `devicepool run maestro ... --build-name pr-42` does the same.
2. Build a Release simulator app, so the JavaScript is in the app and no Metro is needed. Any
   macOS runner, EAS or Bazel can build it; the example below builds on the runner.

<!-- {% raw %} -->
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
      - uses: mariusud/devicepool@main
        with:
          url: ${{ secrets.DEVICEPOOL_URL }}
          token: ${{ secrets.DEVICEPOOL_TOKEN }}
          app: build/Build/Products/Release-iphonesimulator/MyApp.app
          flows: .maestro
          shards: 3
          env: |
            TEST_USER=${{ secrets.TEST_USER }}
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: maestro, path: devicepool-maestro.xml }
```
<!-- {% endraw %} -->

The action installs Node 22 and Devicepool's own dependencies, then runs `devicepool run maestro`.
Its inputs are `url`, `token`, `app` (a path, or the name of a build already on Devicepool),
`flows` (default `.maestro`), `shards` (default 1 with a server), `retries` (default 1), `model`,
`env` (one `KEY=VALUE` per line), `junit` (default `devicepool-maestro.xml`), `hold`, `booking`,
`build-name` (the name the app is uploaded under), and the inputs for comments and reruns below. `start-timeout`, `maestro-version` and `artifact`
apply to runner mode only. With a server the action uploads nothing itself, so keep your own
`actions/upload-artifact` step for the JUnit report.

The step fails when a flow fails after its retries. Shards wait in Devicepool's queue like any
lease, so a Mac with three simulators runs three shards at once and queues the rest. Cancelling
the job cancels the run, which releases its devices. If the runner dies before it can say so,
the run goes on in Devicepool and releases its devices when it ends; cancel it on its page.
`config.yaml` in the flows folder is Maestro's own settings file and is not run as a flow.
[Maestro flows](maestro.md) describes the command itself, including `--hold`, which keeps a failed
flow's device for a person to look at; the action's `hold` input passes it on.

A token made by `devicepool connect ci` has the `ci` priority, so its shards go first in the queue,
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
days on a server. In runner mode the files are in the job's artifact instead
([What the job keeps](#what-the-job-keeps)).

The links are in the job's summary page, in the CLI output, and in the JUnit report, as a
`recording` property (the last attempt) and a `first-recording` property on the test case.

## The pull request comment

On a pull request, the action comments with the counts of passed, flaky and failed flows, a
link to the run on the console's Runs page, and a table of the failed and flaky flows with
their attempts, recording links and error. Passed flows are folded under a summary line. When a
flow failed, the comment ends with the command that reruns it. In runner mode the comment has
the same counts, table and errors, names the artifact folders instead of recording links, and
leaves the rerun command out.

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
devicepool run maestro --rerun <run-id> --flow login.yaml
```

The run id is the last part of the run's link. The action does the same with the `rerun` and
`rerun-flow` inputs, and needs no `app` then. The API is
`POST /v1/runs/:id/flows/:flow/rerun`; anyone on the run's team can call it.

The result goes into the original run. Every attempt counts toward the flow's status: a flow
that failed and then passes on the rerun is flaky, and the first failure and its recording are
kept. The run's state is worked out again from its flows, and the pull request comment for that
run is updated if the rerun names the same `pr`.

Devicepool keeps environment values in memory only. After the broker restarts, a rerun of a run
that had `env` answers `ENV_NEEDED` until you pass the values again with `-e KEY=VALUE` (or the
action's `env` input). A rerun also needs the run's build to still be on Devicepool, and a run that
is still going can't be rerun.

## A nightly run

[examples/workflows/devicepool-nightly.yml](../../examples/workflows/devicepool-nightly.yml) runs every
flow at 03:00 UTC with two retries, and has a manual "Run workflow" form on the Actions tab
that reruns one flow of a past run, optionally updating a pull request's comment. Copy it to
`.github/workflows/` and change the build steps to match your app. To run it inside a booking's window, make its
token with `devicepool connect <booking>`, which also prints the cron for the window in UTC
([Night QA](night-qa.md#tokens-for-a-booking)).

## Flaky tests

`GET /v1/tests/flaky` looks at your team's last 200 runs. It lists each test that was flaky or
failed at least once, with its flake rate and failure rate (out of the runs it was in), sorted
by flake rate, and groups failures by error message. Two messages that differ only in numbers,
ids and hex addresses are one group, with a count, the tests it hit, the latest example and a
recording. `devicepool tests` shows the plain counts from `GET /v1/tests`.

The comment, the rerun and the nightly example are tested with recorded runs and a fake agent.
None of them has yet run on a real GitHub runner against a real Devicepool, and neither has
runner mode.

## Publishing the action to the GitHub Marketplace

For maintainers. The action is not on the Marketplace yet. `action.yml` at the repository root
has what a listing needs: a `name` no other action, user or organization has (checked on
2026-11-22), a `description` under 125 characters, and `branding`. GitHub's own steps are in
[Publishing actions in GitHub Marketplace](https://docs.github.com/en/actions/how-tos/create-and-publish-actions/publish-in-github-marketplace).

1. The repository must be public, and the account that owns it needs two-factor authentication.
2. Run runner mode once on a real runner from a branch, and fix what it finds.
3. On github.com, open `action.yml` on the default branch. A banner offers to publish the
   action. Click "Draft a release".
4. Tick "Publish this Action to the GitHub Marketplace". The first time, follow the link there
   to accept the GitHub Marketplace Developer Agreement.
5. Fix anything GitHub reports about `action.yml`, until it says "Everything looks good!".
6. Pick a primary category (Continuous integration) and, if you like, a second one (Testing).
7. Enter a new tag such as `v1.0.0` and a release title, write the notes, and click
   "Publish release".
8. Move the major tag, so that `uses: mariusud/devicepool@v1` follows the release:
   `git tag -f v1 v1.0.0 && git push -f origin v1`. Then change `@main` to `@v1` in this guide
   and in `examples/workflows/`.

To take a release off the Marketplace, edit the release, untick the same box and click
"Update release". That is done per release.
