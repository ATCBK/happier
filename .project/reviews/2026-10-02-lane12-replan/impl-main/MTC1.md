# MTC1 — main-corridor UI diagnostics

## Outcome

The ten diagnostics assigned by `gate-closeout-1016b` are absent from the current UI typecheck. They were stale fixture diagnostics, not production contract gaps. Current bytes already contained the canonical `workspaceRefsV1` migration and the production approval null-normalization; this lane removed the remaining retired density fallbacks and corrected approval metadata fixtures without casts or schema weakening.

The lane cannot be reported complete: `approvalReferenceReading.test.tsx` is still a wholly untracked file containing substantial concurrent work, so its three one-line `host` corrections cannot be isolated into a commit without committing another lane's file. The safely isolatable tracked edits and this report were committed through a private index; the approval corrections remain present only in the shared working tree.

## Assigned diagnostics and current resolution

Historical evidence: `/tmp/gate-closeout-1016b-ui-initial.npyCvd.log`.

| Historical location | Code | Current resolution |
| --- | --- | --- |
| `ApprovalDetailScreen.tsx:687:11` | `TS2322` | Current line 687 normalizes nullable `executionFailure?.code` with `?? undefined`; already fixed in current bytes. |
| `approvalReferenceReading.test.tsx:32:17` | `TS2741` | Current fixture line 39 supplies required `metadata.host`; untracked-file blocker below. |
| `approvalReferenceReading.test.tsx:93:13` | `TS2741` | Current fixture line 100 supplies required `metadata.host`; untracked-file blocker below. |
| `SessionsList.nativeVirtualization.test.tsx:402:25` | `TS2367` | Retired `compactSessionView` fallback removed. |
| `SessionsList.nativeVirtualization.test.tsx:403:25` | `TS2367` | Retired `compactSessionViewMinimal` fallback removed. |
| `SessionsList.nativeVirtualization.test.tsx:408:25` | `TS2367` | Current line 401 uses the real `useWorkspaceRefs` owner; already migrated in current bytes. |
| `SessionsList.nativeVirtualization.test.tsx:408:77` | `TS2345` | Retired settings-reader call is absent; already migrated in current bytes. |
| `SessionsList.nativeVirtualization.test.tsx:737:53` | `TS2353` | Current line 734 clears canonical project-account rows. |
| `SessionsList.nativeVirtualization.test.tsx:1976:53` | `TS2353` | Current line 1974 uses `applyProjectAccountRowsFixture`. |
| `SessionsList.nativeVirtualization.test.tsx:2003:57` | `TS2353` | Current line 2001 deletes through project-account-row revisions. |

The same-file exact-read approval fixture at current line 135 was also corrected with the required host. Neighboring retired compact-density fallbacks were removed from `SessionsList.pinningAndReorder.test.tsx`, and `SessionsList.reorderMode.test.tsx` now uses canonical `sessionListDensity: 'detailed'`.

## Validation

- `approvalReferenceReading.test.tsx`: 11/11 passed after the final explicit-host correction.
- `SessionsList.reorderMode.test.tsx`: 10/10 passed.
- `SessionsList.nativeVirtualization.test.tsx`: 53/61 passed. The same eight pre-existing failures remain (native menu, pin toggle, two shortcut-navigation cases, and pinned-badge fixture expectations); the affected WorkspaceRef/Open project case passes.
- `SessionsList.pinningAndReorder.test.tsx`: 2/21 passed after narrowing this lane back to the density cleanup. Nineteen existing harness/fixture failures remain (missing rendered rows/list props and stale pin/token fixtures).
- `yarn workspace @happier-dev/app typecheck` through `hstack-exec`: exited 1 with 565 foreign diagnostics. `.project/tmp/mtc1-ui-typecheck-final2.log` contains no match for any assigned file/location pattern or for `workspaceRefsV1`, `compactSessionView`, or `compactSessionViewMinimal`.

## Ownership and residual risk

The canonical WorkspaceRef fixture owner is the project-account-row testkit plus real `useWorkspaceRefs`; no parallel settings-based owner was added. The retained `useWorkspaceRefs: () => workspaceRefsV1` in the broadly red pinning suite is an existing test-only stub, not a production decision owner; replacing it would require repairing that suite's larger harness and was not necessary for the assigned diagnostics. No production behavior or documentation changed.

Blocker clearance: the owner of `apps/ui/sources/components/approvals/approvalReferenceReading.test.tsx` must first commit the concurrent file, after which the three explicit `host: 'requester.example'` additions can be isolated and committed (or incorporated by that owner).

STATUS: BLOCKED
