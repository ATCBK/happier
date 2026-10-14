# QA · Review collection

Private QA-only external package root, manually adapted from the maintained
public Collection composition in the native UI guide and the public
`code-defined` and `widget-areas` examples. It is not a shipped plugin and does
not join Happier's global catalog.

`rows` is a dynamic Resource backed by transient occurrence-local sample data.
The public Collection owns the table, responsive list, detail pane and pushed
phone detail. Each row and its detail invoke the same `set-complete` Action.
`clear` and `restore` exercise empty-state recovery. Resource invalidation wakes
the host after a change; repeated completion writes do not emit false changes.
Reload resets the samples. No Account database, network access or polling is used.

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
orchestrator-owned QA stack, open `reviews`, complete a row from the UI and an
agent, clear and restore the list, and capture wide/phone, light/dark views.
The UI reference is the public Collection example in
`apps/docs/content/docs/plugins/ui/react-native.mdx`; all visual primitives
are composed through `@happier-dev/plugin-ui/components`.
