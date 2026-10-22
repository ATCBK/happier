# External integration example

An external service or CI integration driving Happier through the published SDK
only.

It imports nothing from the Happier host: no daemon module, no Protocol deep
import, no crypto helper. Installed external plugins use the public Plugin SDK
instead and retain the same trusted host capabilities as built-in plugins; they
are not narrowed to this PAT/API projection.

It covers the three public seams an integration usually needs together:

1. a post to an existing human **Discussion** through the generated Action tree
   — discussion creation remains an interactive present-user operation, while
   the daemon owns the Session cipher for the admitted post, so the caller sends
   the authored document and never handles Session keys;
2. an **Execution Run** started through canonical `execution.run.start` and then
   bound with `sessions.get(sessionId).runs.get(runId)` for `send`,
   `sendAndWait`, `history`, `stop` and terminal `wait`;
3. typed failure handling — canonical Action codes such as `approval_required`
   and `invalid_parameters` survive the transport unchanged.

## Credentials

`HAPPIER_TOKEN` accepts either credential and the call sites are identical:

- `hap_v1_…` — an ordinary bearer, with the documented Home-visible transit.
- `hapc_v1_…` — an encryption-capable credential. Selecting it seals the whole
  Action request and result before Home transit for every generated and fluent
  call, including ID-only reads. There is no per-call `encrypt` option, no
  caller-supplied key and no separate encrypted method tree, and the SDK never
  silently downgrades to plain transit. In this preview, protected calls require
  an ordinary authorized Account daemon. Delivery to a restricted Runner stays
  fail-closed until its Machine envelope has an independently authenticated
  proof.

Bootstrap and routing metadata (the PAT-self wrapping record and
`GET /v1/machines`) remain bearer-only metadata requests and are not
whole-Action protected.

```sh
HAPPIER_API_ENDPOINT='https://configured-server.example' \
HAPPIER_TOKEN='hapc_v1_…' \
HAPPIER_MACHINE_ID='machine-id' \
HAPPIER_SESSION_ID='session-id' \
HAPPIER_DISCUSSION_ID='discussion-id' \
HAPPIER_RUN_SELECTION='{"backendTarget":{…},"permissionMode":"…"}' \
pnpm exec tsx packages/sdk/examples/external-plugin/index.ts
```

`HAPPIER_RUN_SELECTION` carries the integration's own Agent target and
permission selection for `execution.run.start`. Those are runtime configuration,
not SDK concepts, so the example does not hardcode an installed Agent.
