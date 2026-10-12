# Email transport protocol package instructions

The email core (`packages/plugins/channel-email`) owns this public business
protocol: versioned transport schemas, types, role declarations and conformance
helpers. Keep email parsing, trust, shaping, recipient policy, transport
implementations, polling and host runtime outside this package.

The public exports are the explicit root V1 barrel, `/v1` and `/testing/v1`.
Follow the repository [SDK protocol-evolution doctrine](../../docs/compatibility.md#sdk-protocol-evolution)
at the owning executable schema. Do not add a second parser, handwritten JSON
Schema, private Protocol dependency or unversioned alias.
