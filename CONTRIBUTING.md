# Contributing

Hangar is at the design stage. The most useful contribution right now is review of
[docs/design.md](docs/design.md): open an issue or a discussion with what is wrong or missing.

## Decisions

Decisions that shape the code are recorded in [docs/decisions/](docs/decisions/), one file each.

- The file name and title state the decision, for example
  `0003-webrtc-with-h264-signaled-over-whep.md`.
- Each file starts with Status (proposed, accepted, superseded), Date, and Supersedes when it
  replaces an earlier one.
- Then three sections: Context, Decision, Consequences.
- A decision is changed by a new file that supersedes it, not by editing an accepted one.

## Code

Once code exists, this section will list the setup and the checks every pull request must pass.
The plan:

- pnpm workspace on Node 22. `pnpm install`, then `pnpm check` for lint, types and unit tests.
- `pnpm e2e` runs the end-to-end suite against the fake driver on any machine. The real-device
  suite runs on a self-hosted Mac in CI.
- Changes to drivers run the smoke test for each Xcode and runtime pair in `hosts/versions.json`.
- Every user-visible change adds a changeset (`pnpm changeset`).

## Vendored code

Third-party code goes under `vendor/<name>/` with its license file, a README that says where it
came from and what was changed, and a line in `NOTICE`.

## License

By contributing you agree that your work is licensed under [Apache-2.0](LICENSE).
