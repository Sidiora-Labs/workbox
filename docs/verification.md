# Verification

Each gate answers a different question. Run the narrowest one that covers your change, and do not
read a pass as more than the last column says.

| Gate                           | What it proves                                                                                                                                          | What it does not prove                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `node scripts/check-tests.mjs` | Every `packages/<p>/src/**/*.js` has a unit test at the same relative path, every non-stub package has an integration test, and `test/e2e` holds a test | That the tests are good                  |
| `pnpm lint`                    | ESLint passes over the repository                                                                                                                       | Behavior                                 |
| `pnpm fmt:check`               | Prettier formatting of `packages/**` (js, json, md) and `scripts/*.mjs`                                                                                 | Formatting of `docs/` or the root README |
| `pnpm test`                    | Unit, integration and end-to-end tests pass                                                                                                             | Tests that were skipped on this host     |
| `pnpm test:coverage`           | The unit and integration suites meet lines 90, branches 80, functions 90                                                                                | End-to-end behavior                      |
| `node docs/check.mjs`          | Required pages exist, `wb.md` is current, every relative link and anchor resolves, every page is reachable from the docs index                          | That the prose is true                   |
| `bash deploy/check.sh`         | Deployment assets parse and pass their checks on this host                                                                                              | A production deployment                  |

## Host-dependent tests

The integration and end-to-end tests drive real sandboxes, so they need a host that passes
`workbox doctor`: root, bubblewrap, user namespaces, cgroup v2 delegation, overlayfs and the
network tools. Some tests are skipped with a stated reason when the host cannot run them: the
seccomp tests off x86_64, a session test that needs to switch to uid 65534, and the toolchain
preset install matrix unless it is enabled. Read the skipped count in the test summary before
treating a green run as full coverage.

## Documentation gate

`node docs/check.mjs` is the only documentation gate. It checks structure, not truth: a link can
resolve and the sentence around it can still be wrong. Every command, flag and path in these pages
was checked against the source at the revision that last changed them; when you change a command,
update its page in the same change.

- `docs/wb.md` is generated: `node docs/gen-wb.mjs` rewrites it from `wb tools --json`.
- `docs/measurements.md` is rewritten by `test/e2e/lifecycle.test.js`.
- Format the pages you edit with `npx prettier --write <page>`, except `wb.md` and
  `measurements.md`.
