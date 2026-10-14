---
name: happier-plugin-authoring
description: Create, edit, diagnose, test, package, and install a Happier plugin through public authoring contracts.
---

# Happier plugin authoring

This workspace uses `@happier-dev/plugin-sdk@0.0.0`, derived from the public toolchain compatibility packet.

## Public API source of truth

Before choosing an SDK import, read `node_modules/@happier-dev/plugin-sdk/API.md`. That generated inventory is the current public API contract; do not guess names or copy a versioned export list into this skill.
Before adopting a contribution or service family, read `node_modules/@happier-dev/plugin-sdk/capability-matrix.json`. It is the sole product-availability authority: a `deferred` row is conformance-only reference material, not a supported product lifecycle. Its source API and consumer fields do not by themselves establish loaded-platform or release availability.
Use only the package entrypoints documented there. Do not reach into host source, private aliases, or another installed plugin artifact.

## Settings and configuration pages

A plugin settings or detail page uses the same anatomy as Happier's own settings (`DESIGN.md` → "Configuration surfaces"): a page header, sentence-case sections with their explanation above the rows, one control per row, visual tiles for choices that change what you see, and list + detail for collections of named things. Compose it from the public plugin UI components that render through Happier's own page owners — `PageHeader`, `ItemGroup` with a `title`/`description`/`action` (a page section), `Item` rows with one control in `accessory`, `Toggle`, `Select` (`presentation="segmented"` for 2–4 short options, `"field"` for longer sets), `TextField presentation="field"` for a value typed in place (`onCommit` saves on leaving), `SelectionTiles` (`variant="visual"` with real previews) and `EmptyState` (`layout="page"`/`"line"`) — checking exact names in the API inventory; do not rebuild headers, row dividers, dropdown triggers, switches or selection rings locally, and do not draw a back control or duplicate the page title (the host places both). See [Settings and detail pages](https://docs.happier.dev/plugins/ui/configuration-pages).

Load `.agents/skills/happier-ui-craft` for the method: hierarchy, control choice, copy, states and the side-by-side check.

For a few operations, use public `SelectionTiles variant="action"` with `onPress`: the shared owner turns a narrow page section into rows of one sheet; footer-bearing actions retain their cards. Public `CountedDisclosureItem` folds quiet aggregate details behind a title and optional count or subtitle; use public `List` controlled expansion for a collection item's own details. Import author adapters from `@happier-dev/plugin-ui/components`; `presentation` is host-internal, not an author renderer/metrics API. Public `Collection presentation="grid"` already owns compact tiles: return `null` for absent descriptions and omit unused footer slots. Check these development-source exports in the package API inventory before using them from a published toolchain.

## Cross-plugin integrations

For broader public composition patterns, use the maintained repository examples linked from the [public quickstart](https://docs.happier.dev/plugins/quickstart), including public-authoring and advanced-package-root. Installed copies at `node_modules/@happier-dev/plugin-sdk/examples/public-authoring/` and `node_modules/@happier-dev/plugin-sdk/examples/advanced-package-root/` are release-owned snapshots. Use only contribution and service families marked available in the capability matrix; an example demonstrates public package boundaries but does not create product availability. This beginner scaffold does not declare a feature integration.

## Normal author loop

Work in a normal Happier Agent Session rooted at this source directory. Use the same public lifecycle as a human author:

1. Start or continue live development with `happier plugins dev`. It prepares declared dependencies automatically; do not run `happier plugins dev install .` first. Explicit registration trusts this exact source root without a separate code-trust prompt. Automatic workspace discovery still requires its remembered project-trust decision. Optional host resources and secrets require their separate authority decisions.
Exception — dependency refresh: that cold-start preparation materializes an author root exactly once, only when nothing resolvable is installed yet. After you change declared dependencies in `package.json`, or your `node_modules` is stale or wiped, run `happier plugins dev install .` once to refresh the tree; the watch loop does not reinstall on every start.
2. The generated prepublication SDK version resolves automatically through the running Happier CLI during managed author commands; do not add a workspace alias, file dependency, author-owned `pnpm-workspace.yaml`, or ad hoc local registry.
When deliberately preparing from an approved registry origin, pass `--sdk-registry <origin>` to `happier plugins dev`, `happier plugins dev install .`, or `happier plugins pack .`.
3. Make the smallest source change, then use `happier plugins dev typecheck .`, `happier plugins dev build .`, and `happier plugins test .` for focused checks. Validate through the managed source-development lifecycle; do not create or install a local release archive as an additional feature-QA gate.
4. Use `happier plugins doctor .` to diagnose an import or top-level evaluation issue; it evaluates once and does not prove repeated evaluation is pure.
5. Adapt the smallest maintained repository example through documented SDK exports. Installed copies in `node_modules/@happier-dev/plugin-sdk/examples/` are release snapshots. For a custom persistent Session Agent, start with `happier plugins create <name> --template session-agent`; the maintained session-agent example is the richer deterministic lifecycle reference. Use advanced-package-root only when the same package also needs External Sessions, a Provider, Connected Accounts, Resources, or background work.

The daemon owns prepared-change custody and activation. A failed in-process replacement keeps the incumbent plugin occurrence active only while that daemon lives. After a daemon restart, Happier rebuilds the current source; if it cannot build and activate, the development plugin is unavailable until corrected. Fix the source and let the normal development cycle retry; do not start another watcher or loader.

## Explicit development install

`happier plugins install . --dev --json` is the explicit code-trust action for that exact local development source, so the first install needs no redundant code-trust prompt. It selects no optional host resources, and cancels the pending change with `plugin_explicit_trust_target_mismatch` if the daemon review names any other source.
Later iterations need nothing further: a trusted development source root short-circuits code review, so `happier plugins reload --json` applies subsequent edits. This is an alternative explicit install command; the normal `plugins dev` loop already trusts its registered source root.

## Reviews and reconnecting

A local-path install carries code trust only. A separate authority decision still returns a daemon-issued pending ID for a present user to decide. Preserve that ID and rejoin the same change with `happier plugins change status <pendingChangeId> --json`; a present user decides it with `happier plugins change approve <pendingChangeId> --json` or `happier plugins change reject <pendingChangeId> --json`, or from Settings -> Plugins on that machine. Do not submit a second change request while a review or apply is pending. Optional host resources and secrets always stay with their canonical authority owner.
A pending ID can be rejoined only during the same daemon lifetime. If status reports `expired` after a daemon restart, rerun the original development or install request and review its newly prepared facts; do not reuse the old pending ID. `outcome_unknown` is different: inspect installed state before replaying a mutation.
