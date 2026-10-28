# Contributing to Workbox

Thanks for taking the time to contribute. This document explains how the project is organized,
what we expect from patches, and how to get changes merged quickly.

## Ground rules

- Be respectful. The [code of conduct](CODE_OF_CONDUCT.md) applies to every interaction in this
  project.
- Keep changes focused. One pull request should do one thing. If you find yourself fixing an
  unrelated bug on the way, split it out.
- Every change that touches behavior needs a test. If it cannot be tested, explain why in the pull
  request description.
- Discuss large changes first. Open an issue before writing a thousand lines nobody asked for.
  Small fixes and obvious improvements can go straight to a pull request.
- Do not report security problems in public issues. Follow [SECURITY.md](SECURITY.md).

## Getting set up

You need Node.js 22.13 or newer and pnpm (the repository pins `pnpm@12.8.1` in `package.json`).
From a checkout of the repository:

```sh
pnpm install --frozen-lockfile
make check
make unit-unprivileged
```

`make check` runs lint, the format check, the 1:1 test gate and the documentation gate. It needs
no privileges. `make help` lists every target.

## Running sandboxes and the full test suite

Sandboxes need a Linux host with cgroup v2, bubblewrap and root. Docker is needed only to build
the rootfs. On a host you are willing to prepare:

```sh
sh deploy/install.sh
node packages/cli/src/main.js doctor     # every failure names its remedy
make test
```

`pnpm test` runs the unit, integration and e2e tests against real sandboxes, and
`pnpm test:coverage` enforces the coverage floors (lines 90, branches 80, functions 90). The
integration and e2e tests cannot run on an ordinary hosted CI runner, so CI runs the static gates
and the unit tests that work without root. A change to the launch chain, cgroups, the network
policy or a surface should be run through `make test` before you open the pull request, and the
pull request should say so. `bash deploy/check.sh` validates the deployment assets and runs the
host doctor.

The operating procedures are in [docs/operations.md](docs/operations.md), and the design in
[docs/architecture.md](docs/architecture.md).

## Project layout

Eight packages under `packages/`: `protocol`, `core`, `runner`, `wb`, `server`, `sdk`, `mcp` and
`cli`. `protocol`, `runner` and `wb` run inside the box and have no runtime dependencies. Scope,
decisions and acceptance criteria live in [spec/workbox/spec.kvx](spec/workbox/spec.kvx); read the
requirement your change serves before you start.

## Code standards

- Plain JavaScript, Node 22 ESM, JSDoc for types. No TypeScript, no bundler.
- `.editorconfig` and `.prettierrc` are authoritative. Run `pnpm fmt` before committing.
- `pnpm lint` must pass.
- Every source module `packages/<p>/src/<path>.js` has a unit test at
  `packages/<p>/test/unit/<path>.test.js`. `node scripts/check-tests.mjs` enforces it, and fails a
  package with code but no integration test.
- Tests run real code on real host primitives. Fakes, mocks and stubs that make a test pass
  without exercising the real path are not accepted.
- Errors carry stable codes. No silent catches.
- If you change the `wb` command table, regenerate the reference with `node docs/gen-wb.mjs`.
  `node docs/check.mjs` fails on a stale `docs/wb.md` or a link that does not resolve.

## Commits and pull requests

- Write the commit message as a plain sentence describing the real change. Subjects in this
  repository are not `type:` prefixed; the changelog groups them by the spec task they carry
  (`[spec:workbox/<wave>.<n>]`) and otherwise by the leading verb.
- Do not mix formatting-only changes with behavior changes.
- Fill in the pull request template and list the commands you ran with their results. Say which of
  them could not run on your machine.
- [CHANGELOG.md](CHANGELOG.md) is generated from the git history; `make changelog` regenerates it
  with git-cliff.

## Licensing

The packages are marked `UNLICENSED` and the repository carries no license file. Do not add third
party code without recording it in [NOTICE](NOTICE).
