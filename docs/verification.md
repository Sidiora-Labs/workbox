# Testing

| Command                        | What it runs                                                                                                                                | Needs                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `make check`                   | `pnpm lint`, `pnpm fmt:check`, `node scripts/check-tests.mjs` and `node docs/check.mjs`                                                     | Node and pnpm            |
| `node scripts/check-tests.mjs` | Checks that every `packages/<p>/src/**/*.js` has a unit test at the same relative path and every package has an integration test            | Node                     |
| `make unit-unprivileged`       | The unit tests that run as an ordinary user                                                                                                 | Node                     |
| `pnpm test`                    | Unit, integration and end-to-end tests                                                                                                      | A prepared host, as root |
| `pnpm test:coverage`           | Unit and integration tests with coverage floors of 90% lines, 80% branches and 90% functions                                                | A prepared host, as root |
| `node docs/check.mjs`          | Checks that the required pages exist, `wb.md` is up to date, every relative link and anchor resolves, and every page is linked in the index | Node and pnpm            |
| `bash deploy/check.sh`         | Validates the deployment assets and runs `workbox doctor`                                                                                   | A prepared host, as root |

## Host requirements

The integration and end-to-end tests start real sandboxes, so they need a host that passes
`workbox doctor`: root, bubblewrap, user namespaces, cgroup v2 delegation, overlayfs and the
network tools. Some tests are skipped, with the reason printed, when the host cannot run them:
the seccomp tests on hosts other than x86_64, a session test that switches to uid 65534, and the
toolchain preset install matrix unless `WORKBOX_PRESET_MATRIX=1` is set. Check the skipped count
in the summary.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:

- `make check` and `actionlint` on the workflows;
- `make unit-unprivileged` on Node 22 and 24;
- on a GitHub-hosted Ubuntu 24.04 runner prepared with `deploy/install.sh`, as root:
  `workbox doctor`, `pnpm test:coverage`, the end-to-end tests and `deploy/check.sh`.

`.github/workflows/image.yml` builds `deploy/Dockerfile.server`, smoke-tests it, and on `main`
and version tags pushes it to `ghcr.io/sidiora-labs/workbox-server` with an SBOM and a build
provenance attestation. `.github/workflows/release.yml` creates the GitHub release for a `v*` tag
from its `CHANGELOG.md` section.

## Documentation

- `docs/wb.md` is generated: `node docs/gen-wb.mjs` rewrites it from `wb tools --json`.
- `docs/measurements.md` is rewritten by `test/e2e/lifecycle.test.js`.
- Format the pages you edit with `npx prettier --write <page>`, except `wb.md` and
  `measurements.md`.
- When you change a command, flag or path, update its page in the same change.
