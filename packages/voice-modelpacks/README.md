# @happier-dev/voice-modelpacks

Host-agnostic installation and lifecycle logic for Happier voice model packs.

The package owns model-pack download, verification, URL policy, resource admission, and atomic installation behavior. Filesystem, network, and digest effects are supplied by the host.

Protocol owns the closed artifact-binding and promotion-intent schemas. In current development source, persisted promotion markers and daemon model-pack state use Protocol's stored-read projection to discard unknown fields recursively while retaining known-field validation. Incoming bindings and promotion inputs remain strict; recovery payloads stay opaque until their named owner reads them.

In current development source, configured manifest and asset URLs reject URL credentials, including credential query parameters. The daemon may follow server-issued signed redirects from an admitted HTTPS URL; each destination still passes HTTPS, any configured host/origin restrictions, and fresh pinned-DNS checks. Redirect queries stay in the transport request and are omitted from response metadata, persisted installation state and transport errors. Download requests carry no Authorization header. The shared URL policy owns this distinction; Provider endpoint credential checks remain unchanged.
