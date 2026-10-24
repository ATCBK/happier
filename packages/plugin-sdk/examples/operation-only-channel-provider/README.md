# Operation-Only Channels Provider

This is the minimal maintained public cross-plugin reference. It consumes
the maintained `@happier-dev/channels-protocol/v1` provider contract and binds
the required roles to Actions owned by this plugin.

It declares a provider display-name descriptor, with no target, renderer or UI. `happier.channels`
and its `providers` contribution point are owned by Channels; the `acme`
contribution id below is only this plugin's opaque local id. The package root
exports both the cold `manifest` and the installable `activate(api)` binding for
the declared daemon Actions.

For the advanced public target-owned descriptor and embedded-surface shape, see
the `action-contract-producer` and `action-contract-consumer` pair. External and
bundled plugins use the same public contracts; the capability matrix separately
records source availability and loaded proof. Do not use that pair as the
beginner template.

Inside this repository, run the normal managed author loop with the
development-lane CLI:

```sh
hdev plugins dev build .
hdev plugins test .
hdev plugins dev
```

The `@happier-dev/channels-protocol` dependency resolves from maintained
Developer Preview source in this repository. This example is not selected into
the published Plugin SDK package until release automation can supply an exact
published Channels Protocol version.
