# Support

Workbox is community-supported open-source software. There is no guaranteed response time or
production support SLA.

## Choose the right channel

- **Reproducible defect:** open a Bug report using the issue form.
- **Proposal for a feature or contract change:** open a Feature proposal before a large patch.
- **Usage or architecture question:** use the Question form, after reading the
  [documentation](docs/architecture.md) and [operations guide](docs/operations.md).
- **Security vulnerability:** do not open an issue; follow [SECURITY.md](SECURITY.md).
- **Community conduct incident:** follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Before asking for help

Run these and include the output:

```sh
node packages/cli/src/main.js doctor --json
node -v
bwrap --version
uname -r
```

Include the revision (`git rev-parse HEAD`), the command you ran, the expected behavior, the
actual error, and the smallest sequence of steps that reproduces it. For a sandbox that is not
healthy, add `workbox sandbox` output for it and the tail of its `launch.log`.

Do not attach the secrets file, API keys, bearer tokens, lease tokens or the audit directory.
Redact them from any log you paste.

Maintainers may convert support requests into documentation or tracked defects. Questions about
Docker, your kernel's user-namespace policy or your cloud provider's nested virtualization may
need to be handled with those projects.
