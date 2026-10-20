# QA Resource document

QA-only external author package adapted from the maintained public Action + Resource + UI example and public-authoring live Resource page. It is private and has no built-in plugin membership. Imports use only the public SDK and UI SDK. The document is demonstration state local to the loaded module; reload starts empty.

The `document-write` Action is available from UI, agent, CLI and MCP. The `document` Resource returns Markdown and invalidates live readers on changed writes. Its observation stops on disposal or cancellation. The page uses `useLivePluginResource`, public loading/error/empty/freshness components and Markdown; it has no polling loop.

From this package root, use the documented managed author commands:

```sh
happier plugins dev typecheck .
happier plugins dev build .
happier plugins test .
```

The package was authored manually from maintained examples while the public scaffold CLI was blocked by the Systemic Mini schema migration. File presence is not evidence that scaffold, managed build, installation or admission passed. The source SDK suite is `packages/plugin-sdk/src/qaPluginAuthoring.resourceDocument.test.ts` through `vitest.source.config.ts`; the independent author suite above consumes `dist/index.js` after a successful managed build.

Phase B: install/enable this exact root on the orchestrator-owned QA stack, open `document-page`, save sample notes, invoke `document-write` from an agent, observe the new Markdown without reload, clear the document, close/reopen the page and inspect loading/error recovery. Record the loaded CLI/UI identity and whole-page light/dark/phone captures. No live or visual pass is claimed by Phase A.
