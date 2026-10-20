# QA Action and webhook fixture

Private, QA-only external package root adapted from the maintained public-authoring example and public webhook guide. This package is not shipped or a workspace member.

`summarize-note` is available to UI, agent, CLI and MCP callers. `receive-note` receives only the public verified webhook envelope and applies the same note behavior. It has no HTTP listener, signature verifier, queue, credential, or delivery store. Repeated deliveries are safe because the QA operation is pure.

Use the normal author commands from this directory: `happier plugins dev typecheck .`, `happier plugins dev build .`, and `happier plugins test .`. The owning SDK source tests are `src/qaPluginAuthoring.actionWebhook.test.ts`; no scaffold, build, admission, install, or live success is implied by this fixture's presence.

Phase B owed: load with the managed development loop, open QA notes, invoke Summarize note, compare agent invocation, and route a host-verified QA delivery. Capture the whole page for the visual owner. Stack lifecycle is orchestrator-owned.
