# QA · Review progress

Private QA-only external package root, manually adapted from the maintained
`widget-areas` example. It is not a shipped plugin and does not join Happier's
global catalog.

The App-target `progress` widget declares Home availability; the host owns its
configured Home instance, layout and frame. `overview` is its companion app
page and has a host-owned `pinned` widget area. Both read the same dynamic
`summary` Resource. The `set-completed` Action changes transient progress and
invalidates the Resource; the host rereads through `useLivePluginResource`.
Repeated writes retain the current value without false invalidations. No
polling, Account database, filesystem watch or external network is used.
Reload resets the count; the daily goal is sample display data, not a write cap.

From this package root, use the normal managed author commands:

```sh
happier plugins dev typecheck .
happier plugins dev build .
happier plugins test .
happier plugins doctor .
```

The public CLI scaffold was unavailable during initial Phase A authoring.
These files do not establish scaffold, build, publication, admission or live
validation success. Phase B must run the managed development lifecycle on the
orchestrator-owned QA stack, add `progress` to Home, record a review from the
widget and an agent, observe both surfaces update, open `overview` from the
widget, reset the count and remove the configured widget. Capture the whole
Home and companion page at wide/phone sizes in light/dark themes. The visual
reference is `packages/plugin-sdk/examples/widget-areas/ui`; presentation
imports use `@happier-dev/plugin-ui/components`.
