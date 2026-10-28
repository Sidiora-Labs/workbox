# Contributing to Workbox

Thanks for your interest in contributing. This page covers setting up, running the tests and
getting a change merged.

## Before you start

- The [code of conduct](CODE_OF_CONDUCT.md) applies to every interaction in this project.
- Keep each pull request to one change. If you find an unrelated bug on the way, fix it in a
  separate pull request.
- Every change to behavior needs a test.
- For a large change, open an issue first so the approach can be agreed before you write it.
  Small fixes can go straight to a pull request.
- Do not report security problems in public issues; see [SECURITY.md](SECURITY.md).

## Setting up

You need Node.js 22.13 or newer and pnpm (`pnpm@12.8.1`, pinned in `package.json`):

```sh
pnpm install --frozen-lockfile
make check
make unit-unprivileged
```

`make check` runs lint, the format check, the test layout check and the docs check, and needs no
privileges. `make help` lists every target.

## Running sandboxes and the full test suite

Sandboxes need a Linux host with cgroup v2, bubblewrap and root; Docker is needed only to build the
rootfs. Use a machine you can dedicate to it:

```sh
sh deploy/install.sh
node packages/cli/src/main.js doctor     # each failure comes with a fix
make test
```

`pnpm test` runs the unit, integration and end-to-end tests against real sandboxes, and
`pnpm test:coverage` enforces the coverage floors (90% lines, 80% branches, 90% functions). CI
cannot run the integration and end-to-end tests, so it runs the static checks and the unit tests
that work without root. If you change the launch chain, cgroups, the network policy or one of the
interfaces, run `make test` before opening the pull request and say so in its description.

The design is described in [docs/architecture.md](docs/architecture.md) and the operating
procedures in [docs/operations.md](docs/operations.md).

## Code style

- Plain JavaScript, Node 22 ESM, JSDoc for types. No TypeScript, no bundler.
- Follow `.editorconfig` and `.prettierrc`; run `pnpm fmt` before committing.
- `pnpm lint` must pass.
- Every source module `packages/<p>/src/<path>.js` has a unit test at
  `packages/<p>/test/unit/<path>.test.js`, and every package has an integration test.
  `node scripts/check-tests.mjs` checks both.
- Tests exercise the real code path on real host primitives; mocks and stubs that bypass it are
  not accepted.
- Errors carry stable codes. No silent catches.
- `protocol`, `runner` and `wb` run inside the box and must not gain runtime dependencies.
- If you change the `wb` command table, regenerate the reference with `node docs/gen-wb.mjs`.

## Commits and pull requests

- Write the commit subject as a plain sentence describing the change, without a `type:` prefix.
- Keep formatting-only changes separate from behavior changes.
- Fill in the pull request template, including the commands you ran.
- [CHANGELOG.md](CHANGELOG.md) is updated when a release is cut.
