# Child-token lifecycle

Run this example against a development Home origin with a parent API token that
grants transcript access to the named session and the named browser origin.
The example mints a read-only child, inspects its non-secret self projection and
revokes it. It does not print the bearer or create a session.

Provide `HAPPIER_API_ENDPOINT`, `HAPPIER_TOKEN`, `HAPPIER_SESSION_ID`,
`HAPPIER_EMBED_ORIGIN` and `HAPPIER_CHILD_EXPIRES_AT`, then run from the checkout:

```bash
pnpm exec tsx packages/sdk/examples/child-token/index.ts
```

Choose the expiry yourself as a future ISO timestamp no later than the parent's
expiry. The API imposes no additional maximum lifetime. The daemon-local endpoint
does not serve child-token or self routes and returns `unsupported_endpoint`.
