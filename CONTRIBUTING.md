# Contributing

## Set up

You need a Mac, Node 22.18 or newer and pnpm. Run the tests on any Mac. The end-to-end tests also
need Xcode with an iOS simulator runtime and idb; `devicepool doctor` lists what is missing.

```bash
git clone https://github.com/mariusud/devicepool && cd devicepool
pnpm install
pnpm devicepool up      # runs the CLI from source, no build step
```

## Scripts

| Command | What it does |
|---|---|
| `pnpm check` | Typecheck and unit tests. There is no linter. Run it before every pull request. |
| `pnpm typecheck` | `tsc` over the whole workspace. |
| `pnpm test` | Unit tests in `packages/*/src/**/*.test.ts`, with `node --test`. |
| `pnpm e2e` | End-to-end tests in `e2e/` against real simulators. Sets `DEVICEPOOL_REAL=1`. Needs Xcode and a simulator runtime, and it boots devices. |
| `pnpm bench:stream`, `bench:metro`, `bench:lease`, `bench:compare` | The benchmarks. |
| `pnpm bench:smoke` | The smoke test for the Xcode and runtime pair on this Mac. |
| `pnpm build:npm` | Writes the npm package to `dist/npm`. |

## Rules to know

[AGENTS.md](AGENTS.md) has the full list. The ones that most often matter:

- The broker never imports a driver package. It talks to agents through `packages/protocol`.
- No message type, API route or MCP tool accepts a device UDID, a host path or a shell command.
- Drivers call tools with `execFile` and an argument array, never a shell.
- The lease and device state machines and the scheduler are pure functions. Keep clocks, I/O and
  the database out of them.
- A device returns to the pool only after a verified wipe.
- Nothing calls out to the internet. No telemetry.
- Hot paths (capture, encode, input) are native. Everything else is TypeScript with no build step.

## Numbers

A performance change shows before and after numbers from one of the `bench:*` scripts. The numbers
in the README and [docs/numbers.md](docs/numbers.md) come from those scripts and have to stay
true. Do not state a target as a result.

## Docs

Docs describe what exists. Planned work goes in [ROADMAP.md](ROADMAP.md). Write plain sentences
without marketing language. A change to the design gets a new file in
[docs/decisions/](docs/decisions/) that supersedes the old one. Each decision file starts with
Status, Date and Supersedes when it applies, then Context, Decision and Consequences.

## Vendored code

Third-party code goes under `vendor/<name>/` with its license file, a README that says where it
came from and what was changed, and a line in `NOTICE`.

## License

By contributing you agree that your work is licensed under [Apache-2.0](LICENSE).
