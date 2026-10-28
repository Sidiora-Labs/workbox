# Support

## Where to ask

- **Bug:** open a bug report with the issue form.
- **Feature or interface change:** open a feature request before starting a large patch.
- **Usage question:** use the question form, after checking the [documentation](docs/README.md).
- **Security vulnerability:** do not open an issue; follow [SECURITY.md](SECURITY.md).
- **Conduct issue:** follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## What to include

Run these and include the output:

```sh
node packages/cli/src/main.js doctor --json
node -v
bwrap --version
uname -r
```

Add the revision (`git rev-parse HEAD`), the command you ran, what you expected, the error you
got, and the shortest steps that reproduce it. For an unhealthy sandbox, add the output of
`workbox sandbox inspect <id>` and the end of its `launch.log`.

Never attach the secrets file, API keys, bearer tokens, lease tokens or the audit directory, and
remove them from any log you paste.
