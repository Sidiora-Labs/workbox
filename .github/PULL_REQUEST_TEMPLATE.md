## Summary

<!-- What does this change do, and why? Link the issue if there is one. -->

## Compatibility

<!-- Does this change the protocol, REST routes, `wb --json` output, MCP tools, CLI flags or the
on-disk sandbox layout? How are existing sandboxes affected? -->

## Security

<!-- Does this touch capabilities, seccomp, namespaces, cgroups, network policy, secrets, leases,
artifacts or API scopes? -->

## Testing

<!-- The commands you ran and their results. -->

- [ ] `make check` passes
- [ ] `make unit-unprivileged` passes
- [ ] `make test` passes on a prepared host (for changes to the launch chain, cgroups, network or
      an interface)
- [ ] Documentation is updated; `node docs/gen-wb.mjs` was run if the `wb` command table changed
- [ ] No secrets, tokens or audit data are included
