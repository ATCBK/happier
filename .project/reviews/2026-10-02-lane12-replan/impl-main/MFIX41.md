# MFIX41 — Claude Action completion and result visibility

## Outcome

Fixed both MFIX41 defects at their canonical owners.

- Account-settings bootstrap now accepts the Session Action lifecycle `AbortSignal` and carries it through v2 retrieval, the v1 compatibility fallback, injected fetch dependencies, persistence, and fallback handling. Cancellation is rethrown instead of being converted into cached success. This reuses the Action lifecycle budget; no competing timeout was introduced.
- Claude unified-terminal source ingestion now observes every parsed live transcript row and projects ordinary `tool_result` blocks through the canonical runtime event seam. Non-lifecycle rows are source-ID deduped after observation, task-notification projection remains intact, and historical replay remains excluded.
- The existing UI path already renders a received `tool.result`; the missing result was dropped before runtime publication, so no UI change was warranted.

## Canonical owners and split-brain audit

- `bootstrapAccountSettingsContext` owns Account-settings retrieval/cache publication. All forced bootstrap reads in `settingsDeclarationAction` now pass `context.signal`; versioned reads already did so.
- `providerTranscript` owns ordered Claude source-row ingestion, while `turnOperations` owns canonical runtime event publication. The SDK route already used the shared tool-result extractor; the unified-terminal route is now aligned instead of retaining its task-only bypass.
- The transcript projector and `MCPToolView` renderer are retained as downstream consumers, not competing result owners.

## RED → GREEN evidence

- RED: `settingsDeclarationAction.test.ts` failed because the forced Account-settings Axios request did not receive the Action signal.
- GREEN: focused CLI settings Action suite: 8/8 passed.
- RED: the Claude unified-terminal test first observed no runtime result for an ordinary native `tool_result` row; its strengthened replay case then exposed duplicate publication until source-ID dedupe was added.
- GREEN: full `turnOperations.test.ts`: 141/141 passed.
- GREEN: fresh Claude plugin typecheck passed after the final dedupe change.
- GREEN: fresh Claude plugin build passed after the final dedupe change.
- GREEN: `git diff --check` passed for the touched corridor.

## Broader validation and residual risk

- CLI public typecheck ran and failed in unrelated, concurrently modified UI paths; no MFIX41-touched-file diagnostic was present.
- Full `bootstrapAccountSettingsContext.test.ts` ran: 28 passed and 6 failed in concurrently changing settings/protocol cases unrelated to signal propagation. The focused owner-path Action suite is green.
- CLI package build was dispatched through `hstack-exec` and remained queued/running at report close; its terminal result is therefore not claimed here.
- No stack restart or live replay was performed, per lane scope. Main owns reload/replay against the observed runtime identity. Residual risk is limited to that live integration gate and the unrelated failing broader checks above.

STATUS: DONE
