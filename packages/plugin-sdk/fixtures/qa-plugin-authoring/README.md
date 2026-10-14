# Plugin-authoring QA fixtures

These six private author packages exercise the public Happier SDK and UI SDK.
They are QA sources, excluded from workspace plugin membership and the SDK's
published file inventory. Do not add them to bundled-plugin projections.

| Package | Author contract |
| --- | --- |
| `qa-collection-detail` | Collection, detail pane, and row Actions |
| `qa-home-widget` | Home widget and companion page |
| `qa-action-webhook` | Agent-callable Action and verified webhook receiver |
| `qa-connected-service` | Connected service with a static display title |
| `qa-resource-document` | Live Resource-backed document page |
| `qa-settings-actions` | Descriptor-owned settings and an Action per setting |

The packages adapt maintained public examples. Their creation does not prove
that the `plugins create` command works. Follow the
[public authoring CLI](https://docs.happier.dev/plugins/packaging/authoring-cli)
from each package root:

```sh
hdev plugins dev typecheck .
hdev plugins dev build .
hdev plugins test .
```

The managed commands prepare dependencies when required. Do not add local SDK
aliases, file dependencies, a separate watcher, or a release archive to make a
failed authoring check pass. Presentation comes from
`@happier-dev/plugin-ui/components`; Resources and Actions use the public SDK.

Runtime installation, UI and agent invocation, and screenshots belong to Phase B
on the orchestrator-owned QA stack. Source tests do not prove loaded admission,
publication, endpoint verification, or credential custody.
