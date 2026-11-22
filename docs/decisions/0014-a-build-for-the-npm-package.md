# 0014. A build for the npm package

- **Status:** Accepted
- **Date:** 2026-11-22
- **Amends:** [0001](0001-typescript-on-node-22-for-every-package.md)

## Context

The repository runs its TypeScript sources directly on Node 22 and has no build step. Installing
Devicepool meant cloning the repository and running `pnpm install`.

Node refuses to strip types from files under `node_modules`, so a package installed from npm
cannot run `.ts` sources. The CLI also depends on `@devicepool/protocol`, `@devicepool/broker` and
`@devicepool/agent` through workspace links that exist only in the repository.

## Decision

`pnpm build:npm` runs `scripts/build-npm.ts`, which writes one package named `devicepool` to
`dist/npm`. It runs only before a release. Development, the tests, the benchmarks and the
Dockerfile keep running the `.ts` sources, and nothing in the repository imports from `dist`.

The build does four things:

- `tsc -p tsconfig.build.json` emits `.js` and `.d.ts` for the CLI, the client and every module
  they import, and rewrites `./x.ts` imports to `./x.js`. Test files are not reachable from those
  two entry points, so they are not emitted.
- The script replaces each `@devicepool/*` import in the emitted files with a relative path, and
  fails if one is left.
- It copies the files the code reads at run time: the console's static files, `screen.swift` and
  `hosts/versions.json`, plus `LICENSE`, `NOTICE` and `README.md`.
- It writes the published `package.json` from `packages/devicepool/package.json`. The `bin` and
  `exports` point at the emitted `.js`, and the dependencies are the registry dependencies of the
  four packages.

`dist/npm` keeps the repository's layout (`packages/broker/src/...`, `hosts/versions.json`), so
every path the code builds from `import.meta.url` resolves the same way in both places.

The build uses the TypeScript compiler that the type check already needs. It adds no dependency
and no bundler.

`packages/devicepool/package.json` stays `private`, so `npm publish` in that folder refuses to
publish the sources. The maintainer publishes `dist/npm`.

The screen helper is still compiled on the Mac that runs it. The first stream runs
`xcrun swiftc` on the shipped `screen.swift` and caches the binary in `~/.devicepool/bin` under a
name that contains the source's hash. The tarball contains no binary, and the install runs no
script.

## Consequences

- `npm install -g devicepool` and `npx devicepool up` work without the repository or pnpm.
- A release has one more step, and a bug can exist in the built package only. Before publishing,
  install the tarball from `npm pack` and run `devicepool doctor`.
- Code that names a sibling source file as a string has to follow its own extension, as
  `service.ts` does for `main`. tsc rewrites import statements only.
- A new file that the code reads at run time has to be added to the copy list in
  `scripts/build-npm.ts`, or the installed package will not find it.
- The published package holds the broker and the agent, so a laptop that only needs the client
  also installs them and their dependencies (23 MB in `node_modules`).
