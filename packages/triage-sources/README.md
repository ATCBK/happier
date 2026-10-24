# `@happier-dev/triage-sources`

Shared Triage source runtime, authorization and UI helpers for plugins that
contribute to PRs & Issues. Source declarations and schemas belong to
`@happier-dev/triage-protocol/v1`; provider clients and credentials remain with
the contributing plugin.

In 0.3 development / Developer Preview authoring, declare this package at
`0.0.0` alongside the Plugin SDK, Plugin UI and Triage protocol. Happier's public
authoring commands prepare those packages through the managed toolchain.
Import detail helpers such as `useTriageDetailRequest` from
`@happier-dev/triage-sources/ui` and runtime helpers from
`@happier-dev/triage-sources/runtime`.

Bind `createTriageSourceSettingsSurface` to the source's discovery Action, Connected
Account service and `connectedAccountPurpose` (the discovery Action's HostAccess
request id). Its Connect/Manage link opens Happier's existing purpose setup for
that exact Action. Choosing an existing account or pool saves the host default;
return and Refresh to discover source candidates. Connecting an account without
selecting this purpose does not authorize discovery. Agent callers select the
same default through `connectedServices.purposes.default.set`, then invoke the
ordinary discovery and source-administration Actions.

In the current 0.3 development source contract, a source may supply
`readFixPullRequests` on its existing contribution. Its native associations feed
the ordinary owner-resolved fix-PR read alongside user choices and Session
links; they are not a second relationship store. Return native locators so an
associated PR outside the loaded list can be opened through exact reobservation.
In a framed detail, `useTriageDetailFixPullRequestNavigation()` from `/ui`
returns the already resolved primary PR's identity, title, provider URL and
`open`/`openExternal` callbacks, or `null` when unavailable. It shares the
frame's existing exact reader; source details must not acquire the association
again just to render these controls.

An exact `get` may return transient `dispatchEvidence` using the canonical
Session-input forge-evidence schema. Scans and retained snapshots do not carry
provider bodies. The existing composer renders this untrusted evidence through
the shared forge-content block; source UI requests Fix through
`requestTriageSessionHandoffV1` rather than framing evidence or starting Sessions
itself.

## Evolving the ABI

This package follows the Developer Preview support policy of the public Triage
protocol. V1 is the supported source-contract epoch. Keep shared source schemas
in `@happier-dev/triage-protocol/v1` and provider-specific behavior in the source
plugin. A breaking or independently versioned shared contract requires an
explicit versioned entry point. Developer Preview authoring availability does
not imply registry publication; external publication requires approval.
