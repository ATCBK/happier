# `@happier-dev/triage-protocol`

`@happier-dev/triage-protocol` is the public, source-neutral V1 contract between
the `happier.triage` target and plugins that contribute Triage sources. It owns
the bounded schemas, contribution protocol, the two caller-bound source Action
references — administration and its read counterpart — and the conformance
helpers needed to declare a source. It does not own provider clients,
credentials, source materialization, host registries, UI, or persistence.

## Importing the contract

The package exposes only three entry points:

- `@happier-dev/triage-protocol` re-exports V1.
- `@happier-dev/triage-protocol/v1` exports the V1 schemas, types, contribution
  protocol, and both source Action references:
  `TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1`, which creates, reconfigures,
  removes and reactivates a configured source instance, and
  `TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1`, which lists the instances the
  calling contribution already owns. Three of the administration arms name a
  `sourceInstanceId` the caller must already hold, so a Settings surface needs
  the read Action to reach them. Administration remains the only configured-source
  lifecycle writer.
- `@happier-dev/triage-protocol/testing/v1` exports fixtures, conformance
  assertions, and the published byte-gate derivation
  (`buildMaximalSchemaValue`, `deriveMaximumEncodedBytes`,
  `deriveMaximumEncodedBytesByLabel`, `encodedJsonBytes`) for source-plugin
  tests.

For a source plugin, import declarations from `/v1` and validate its manifest
declaration with the testing entry point:

```ts
import {
    TRIAGE_SOURCES_ADMINISTER_ACTION_REF_V1,
    TRIAGE_SOURCES_READ_CONFIGURED_ACTION_REF_V1,
    TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';
import {
    checkTriageSourceContributionV1,
} from '@happier-dev/triage-protocol/testing/v1';
```

A source Settings surface passes either ref to `hostApi.executeAction(...)`
unchanged. Both accept an optional exact admitted `source` address; it selects
the contribution and never supplies caller provenance. The host stamps the
caller independently. Plugin callers read and administer only their own source's
instances. Host agent/MCP/CLI callers can read all admitted sources or filter by
that address; create requires it, while lifecycle changes resolve the source
from the stored instance and refuse a conflicting address.

The conformance helper verifies the declared source contribution against the
public V1 contract. Installation, generation currentness, provider behavior,
and host admission remain owned by their existing host boundaries.

Account-only sources use `TriageSourceConnectedAccountInputsV1` from `/v1`
for their Action input schemas. These canonical specializations preserve the
role fields and require a configured account in every instance-bearing arm.
Native-capable sources use `TriageSourceCredentialInputsV1` and declare both
account and native-service selection paths. This specialization requires a real
credential selection in every input arm. Conformance accepts only the published
generic schema or its canonical account-only and credential specializations.

In 0.3 development source, a source reading the current authenticated Account's
data uses the generic input with the explicit Account-data binding. It needs no
Connected Account or native login. The source remains responsible for the
current Account's admitted data access on every invocation.

## Optional pull-request status (development preview)

Sources may bind the safe `readPullRequestStatus` role for a declared
`pullRequest` workflow kind. It accepts the existing exact-instance
`TriageGetInputV1` and returns `TriagePullRequestStatusResultV1`: named checks,
nullable counts, review decisions and reviewer verbs, mergeability/blocker,
and head/base branches with optional diff counts. Unknown or partial reads
remain explicit; they are not zero checks or an approval. This detail read
cannot conclude entry absence or replace `get`/`scan` observations.

The Session tab requests it only when a PR is expanded, through Triage's own
safe Action and the source's existing admitted readers. Sources that leave
the optional role unbound continue to provide their existing entry details.

## Optional task writes (0.3 development source)

Sources may mark a kind as a task and bind optional `create`, `edit` and
`transition` roles to their ordinary named Actions. The same `/v1` entry exports
`TriageTaskCreateFieldsV1Schema`, `TriageTaskFieldsV1Schema` and
`TriageTaskWriteResultV1Schema`, the role inputs, capability declarations and
`triageTaskStatusCategoryV1`. Account-only specializations are included in
`TriageSourceConnectedAccountInputsV1`. Sources keep provider authorization,
native transition semantics and at-most-once settlement; an uncertain result
does not authorize a replay.

The entry snapshot carries optional live parent, children summary and blocked-by
facts. External sources do not persist a Happier copy of those relationships.
The existing state projection supplies mixed-view categories through the one
mapper; linked-agent activity remains a separate derived fact. See
[source ownership](../../docs/triage-sources.md#task-sources-03-development-source).

A source whose task record owns Session relationships may also bind optional
`linkSession` and `readSessionLinks` roles. The write uses the ordinary named
source Action and its remote-write approval; the safe read returns relationships
within the current Account and Home. Sources that omit these roles keep the
existing external-entry link path. The public role inputs and results are
exported from `/v1` beside the task write contracts.

## Evolving the ABI

V1 is the only supported epoch. Keep shared source fields and schemas in this
package, and keep provider-specific implementation details in the contributing
plugin. Do not add `default`, `current`, `latest`, legacy, or compatibility
aliases. A breaking or independently-versioned shared contract requires a new
explicit versioned entry point rather than changing the V1 shape in place.
