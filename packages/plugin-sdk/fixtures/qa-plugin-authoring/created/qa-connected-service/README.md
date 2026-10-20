# QA Connected service fixture

Private, QA-only external package root adapted from the maintained advanced package-root example and public Connected accounts producer guide. This package is not shipped or a workspace member.

The service's static human title is **QA Demo service**. Its manual mode accepts the literal fake value `qa-demo-token`, stages it through the host-provided attempt credential store, and returns connected metadata without inventing an account ID. The host owns attempts, settlement, selection UI, storage, cancellation and retirement. No real credential, tenant, HTTP request, secret, OAuth flow, or local credential store is involved. The producer materializes only an authorization header for `https://qa-service.example.test`; that origin is illustrative and is never contacted.

Use the normal author commands from this directory: `happier plugins dev typecheck .`, `happier plugins dev build .`, and `happier plugins test .`. The owning SDK source tests are `src/qaPluginAuthoring.connectedService.test.ts`; no scaffold, build, admission, install, or live success is implied by this fixture's presence.

Phase B owed: enable through the managed development loop, inspect the service title in Connected accounts, connect with the fake token through the canonical user/agent authentication flow, then disconnect. Capture the whole page for the visual owner. Stack lifecycle and shared database writes remain orchestrator-owned.
