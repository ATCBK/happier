# QA settings Actions

QA-only private external author package adapted from the descriptor-only settings example and the public scoped Settings service. It is excluded from built-in plugin membership and imports only the public SDK.

Account-scoped `enabled` and `style` descriptors own defaults, controls and storage addresses. The host renders the settings page and owns reads, writes, subscriptions and freshness. Each user-changeable setting has a UI/agent/CLI/MCP Action that writes the same `context.services.settings.forScope({ kind: 'account' })` service. There is no React settings store, Action-read projection or plugin-owned persistence.

From this package root:

```sh
happier plugins dev typecheck .
happier plugins dev build .
happier plugins test .
```

This root was manually authored from maintained examples while the public scaffold CLI was blocked by the Systemic Mini schema migration. Scaffold, managed build, installation and admission are separate pending checks. The source SDK suite is `packages/plugin-sdk/src/qaPluginAuthoring.settingsActions.test.ts` through `vitest.source.config.ts`. The independent suite consumes `dist/index.js` after a managed build. Its explicit Settings service fixture is the external host boundary: it proves Action delegation and state/notification outcomes, not Account persistence or transport isolation. Tests never access a real Account, credentials or database.

Phase B: install/enable this exact root on the orchestrator-owned QA stack, open `review-preferences-page`, change both fields, invoke `reminders-set` and `summary-style-set` as an agent, and verify mounted controls update from the host settings subscription. Reopen the page to verify persisted values. Record the loaded CLI/UI identity and whole-page light/dark/phone captures. No live or visual pass is claimed by Phase A.
