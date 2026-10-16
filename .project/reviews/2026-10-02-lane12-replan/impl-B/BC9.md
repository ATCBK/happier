# BC9 — Fork B commit pass

Committed **35 packets across 138 distinct paths** before this report: 56 report/brief paths and 82 source/test paths. The pass remains blocked for the explicitly held mixed or dependency-incomplete work below. The 13-path web-worker asset producer also remains uncommitted because neither executor admitted its required test payload. No whole-tree, runtime reload or release clearance is granted.

**Executed public checks:** Server typecheck passed; Protocol failed at uncommitted Usage aggregation (`TS2322`, `src/usage/resolveUsagePageAggregation.ts:455`); UI failed with 438 diagnostic headers (437 source-location headers plus `TS6053` for the missing foreign `vitest.fix-r113b-attribution.config.ts`); CLI stopped on the imported UI Action-label error (`action_policy`, `actionFamilyTranslations.shared.ts:52`). No diagnostic from these completed runs names a BC9-committed path. This is a bounded location observation, not a package pass, current whole-worktree clearance or historical attribution of every error. Later moving-source changes are listed below.

## Authority and preservation

- Read `BC9-BRIEF.md` and `COMMIT-OWN-HUNKS.md` completely and consumed BC8’s committed/held inventory. Remote validation used the standing 2026-10-10 grant through `./apps/stack/bin/hstack-exec`; validation never used `--local`. Explicit `--local` was used only for ignored authoritative reports and Git/temp-state audits that cannot run in the source mirror.
- Initial branch `refs/heads/v0.3`, HEAD `ad81685418cc7d799f88afc836c166b9eea37c47`; configured and resolved author/committer `Leeroy Brun <leeroy.brun@gmail.com>` verified before the first commit, without changing identity. Each commit has the requested Claude co-author trailer exactly once.
- Hook inspection found only sample hooks, no configured `core.hooksPath`, and no configured commit-signing requirement. Each packet received explicit manifest, private diff/whitespace, secret-pattern, size/provenance, relative/host-alias import and newly imported sibling-export checks before `commit-tree` and compare-and-swap `update-ref`.
- Every private index started from its actual parent HEAD. Only complete attributable hunks or wholly attributable new files entered it. The old-blob guard preserved differing shared staging. No shared-index `git add`, destructive Git command, branch change, force, stack lifecycle or credential-file access occurred.
- BC9 authored no production/source correction. It committed existing lane changes, ran read-only validation, and authored this requested report. Delegated reconnaissance did not mutate source or Git; the parent was the sole commit writer. Temporary transaction state and evidence are outside the repository under `/tmp`.
- Final object audit at HEAD `66fbb6db2280fefe1332f3036d8664ffcd6f3e1b`: 35 unique packet commits are ancestors, exact recorded parents/trees/path manifests match, identities/trailers match, no credential/QA/generated plugin path is selected, and **6 selected worktree paths changed since their recorded source basis**. Audit failures: 0. No claim is made about ownership of all 5166 dirty tracked paths.

## Commits and exact paths

Paths below are the exact committed manifests. For partial files, `git show <SHA> -- <path>` is the selected-hunk record; unselected bytes remain in the worktree.

| Commit | Concern | Exact paths |
| --- | --- | --- |
| `7dfff05e50ae5e113faa26d04b084fb25fababa3` | docs(lane12): publish Fork B follow-up findings and gate evidence | `.project/reviews/2026-10-02-lane12-replan/impl-B/BC8-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/BC9-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX80-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX80.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX81-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX81.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX81b-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX81b.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX82-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX82.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX82b-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX82b.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX82c-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX82c.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX82d-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX82d.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX82e-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX82e.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX82f-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX82f.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX83-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX83.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX84-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX84.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX85-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX85.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX86-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX86.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX86b-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX86b.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX86c-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX86c.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX86d-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX86d.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX87-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX87.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX88-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX88.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX88b-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX88b.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX89-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX89.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX90-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/FX90.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/GATE4-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/GATE4.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/GATE4b-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/GATE4b.md` |
| `edc572e3e3c37ac0a5b42a02d3ed4d425156c3c2` | perf(protocol): validate canonical base64 without copying ciphertext | `packages/protocol/src/crypto/base64.test.ts`<br>`packages/protocol/src/crypto/base64.ts` |
| `b7a0aa987520863a8c5a06833d323bd596d92eb5` | perf(protocol): reuse public-key validation by immutable bytes | `packages/protocol/src/crypto/boxBundle.test.ts`<br>`packages/protocol/src/crypto/boxPublicKeyValidation.ts` |
| `ea7e7034b05a1b1e2a208cbb3f3347756de0e6c5` | perf(protocol): bypass parsing for absent Session metadata markers | `packages/protocol/src/sessions/metadata/sessionDirectoryV1.test.ts`<br>`packages/protocol/src/sessions/metadata/sessionDirectoryV1.ts`<br>`packages/protocol/src/sessions/metadata/terminalMetadata.test.ts`<br>`packages/protocol/src/sessions/metadata/terminalMetadata.ts` |
| `32339b8c1e2af11f25b7273c9b69f1e6d22b9042` | perf(ui): project Home identifiers once per profile snapshot | `apps/ui/sources/sync/domains/server/serverProfiles.test.ts`<br>`apps/ui/sources/sync/domains/server/serverProfiles.ts` |
| `ac7430b6eb21db37bae7d35740386c371025f1d2` | perf(ui): avoid parsing absent Session workflow headlines | `apps/ui/sources/sync/domains/session/awareness/sessionAwareness.test.ts`<br>`apps/ui/sources/sync/domains/session/awareness/sessionAwareness.ts` |
| `ec399797cd5fd74caf3769c3e79ebcdb2c84df1c` | perf(ui): retain successful scoped data-key openings | `apps/ui/sources/sync/encryption/encryption.nativeDataKeyEnvelopeContract.test.ts`<br>`apps/ui/sources/sync/encryption/encryption.ts` |
| `91a7166dd48d49ac8f3f3621925d6157e60ed598` | perf(ui): reuse immutable linked Session presentation parses | `apps/ui/sources/activity/source/createActivityAttentionStoreSourceSelector.test.ts`<br>`apps/ui/sources/sync/domains/session/external/readExternalSessionLink.ts`<br>`apps/ui/sources/sync/store/hooks.sessionListRowProjection.test.tsx` |
| `5b3401969aaa2abbd3fb5655b4987492eefb6d59` | perf(ui): retain unchanged Session drag bindings | `apps/ui/sources/components/sessions/shell/useSessionListEntityDragDrop.ts`<br>`apps/ui/sources/components/sessions/shell/useSessionListRowInteractions.lifecycle.test.ts` |
| `20995c80e47d786b4639e1bd55e8a28a3d4c7ec3` | perf(ui): keep deferred Session parents off row clocks | `apps/ui/sources/components/sessions/shell/useSessionListRenderModels.test.tsx`<br>`apps/ui/sources/components/sessions/shell/useSessionListRenderModels.ts` |
| `0df3c4fc86ef27492ff98b29cfc7f13225a046a1` | perf(ui): retain unchanged Workflow Run window projections | `apps/ui/sources/components/workflows/library/workflowLibraryReads.test.tsx`<br>`apps/ui/sources/components/workflows/library/workflowLibraryReads.ts` |
| `6759204b148f47526c45d56354e6de0047af7152` | fix(cli): compose optional Worktree owner data with Mini schemas | `apps/cli/src/storage/categories/worktrees.ts` |
| `e2bf91b49fcad03277f72130b50942831e8c9923` | fix(server): align broker schemas and password proof fixtures | `apps/server/sources/app/teams/credentials/providerBrokerAdmission.sqlite.integration.spec.ts`<br>`apps/server/sources/app/teams/credentials/providerBrokerAdmission.ts` |
| `96d53e737597748782ddc0e5be5d8fae6ea5f968` | fix(ui): consume Mini schemas in plugin and prompt readers | `apps/ui/sources/components/settings/plugins/model/pluginMarketplaceModel.ts`<br>`apps/ui/sources/sync/domains/input/suggestionCommands.ts` |
| `77805bb8cd7e70d3a085d736c6af210dc9f1d001` | docs(lane12): record boundary review and live replay findings | `.project/reviews/2026-10-02-lane12-replan/impl-B/CR3-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/CR3a.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/CR3b.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/LV11-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/LV11.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/LV12-BRIEF.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/LV12.md`<br>`.project/reviews/2026-10-02-lane12-replan/impl-B/LV13-BRIEF.md` |
| `5b9114e830f041bd2b6cb249b48c536820bd7d4e` | perf(ui): reuse stable Session projections during demanded hydration | `apps/ui/sources/sync/domains/session/listing/sessionListRenderable.ts`<br>`apps/ui/sources/sync/domains/session/readSessionOwnerMetadataView.ts`<br>`apps/ui/sources/sync/domains/state/storageTypes.ts`<br>`apps/ui/sources/sync/engine/sessions/readSessionLayout1OwnerProjection.test.ts`<br>`apps/ui/sources/sync/engine/sessions/readSessionLayout1OwnerProjection.ts`<br>`apps/ui/sources/sync/engine/sessions/sessionById.ts`<br>`apps/ui/sources/sync/engine/sessions/sessionHttpCompat.ts`<br>`apps/ui/sources/sync/engine/sessions/sessionSnapshot.performance.test.ts`<br>`apps/ui/sources/sync/engine/sessions/sessionSnapshot.ts`<br>`apps/ui/sources/sync/store/domains/areStoredSessionsEqual.ts`<br>`apps/ui/sources/sync/store/domains/sessions.ts`<br>`packages/protocol/src/sessions/metadata/sessionMetadataEnvelopesV1.test.ts`<br>`packages/protocol/src/sessions/metadata/sessionMetadataSchemasV1.ts` |
| `2a9866e52ba07136143bdaf3f79242b78639f9fd` | fix(cli): include detached Run identity in cold send envelopes | `apps/cli/src/session/actions/createCliActionDeps.executionRuns.test.ts`<br>`apps/cli/src/session/actions/createCliActionDeps.ts` |
| `f65f2085d31740e50f50850cc884620f792faa02` | fix(ui): keep omitted-execution Scripts on SOURCE | `apps/ui/sources/components/projects/projectSetup/ProjectScriptsBody.tsx`<br>`apps/ui/sources/components/projects/projectSetup/projectSetupAuthoring.test.ts` |
| `b26d049ff42acfc97f22043a313d3c1443c3ba83` | fix(ui): include the Machine in shared setup details | `apps/ui/sources/components/projects/projectSetup/ProjectSetupReview.tsx` |
| `45ec82cbefbe28031938a01d2fcfe24df1fac44e` | test(ui): narrow the retained Script command fixture | `apps/ui/sources/components/projects/projectSetup/ProjectScriptsBody.test.tsx` |
| `869b99abc74214a831c5bebb4c00a19d0343d9e8` | fix(ui): keep one launcher row per target identity | `apps/ui/sources/sync/domains/local/services/launch/store.test.ts`<br>`apps/ui/sources/sync/domains/local/services/launch/store.ts` |
| `8eacbe8db8dae82ce40334a57fc629a482a8bf14` | fix(ui): accept absent Home metadata in path formatting | `apps/ui/sources/utils/sessions/formatPathRelativeToHome.ts` |
| `53188c5f70673a6121790e8083c8d3599ab9ca5d` | fix(ui): align the inert Scripts specimen with controller types | `apps/ui/sources/components/dev/scripts/ScriptsSpecimen.tsx` |
| `76812ffd39f259dfe3f490422e7efc26dcec68d4` | fix(ui): preserve canonical Project worker result types | `apps/ui/sources/components/projects/workers/ProjectAgentGuidanceDisclosure.test.ts`<br>`apps/ui/sources/components/projects/workers/ProjectAgentGuidanceDisclosure.tsx`<br>`apps/ui/sources/components/projects/workers/WorkspaceWorkerSettings.tsx` |
| `d3c8c59c030e91ae7833ee24132fdc03b11b2252` | test(ui): parse Project Action fixtures at their schema boundaries | `apps/ui/sources/components/projects/detail/services/ProjectRightPanelServicesView.test.tsx`<br>`apps/ui/sources/components/projects/projectSetup/ProjectScriptRow.test.tsx`<br>`apps/ui/sources/components/projects/projectSetup/projectScriptPresentation.test.ts`<br>`apps/ui/sources/components/projects/projectSetup/projectScriptRuns.test.tsx`<br>`apps/ui/sources/components/projects/projectSetup/useProjectScriptsController.test.ts`<br>`apps/ui/sources/sync/ops/actions/defaultActionExecutor.projectTrust.test.ts` |
| `2551cbf89ce525c9987fdd1832579b5b55b34370` | fix(ui): preserve captured Account retirement on Trust read failure | `apps/ui/sources/sync/api/account/apiProjectTrust.test.ts`<br>`apps/ui/sources/sync/api/account/apiProjectTrust.ts` |
| `37e4e7f37c1720aba777b1465cb0f1ba4de9055a` | test(cli): resolve Sync recovery children through authored source | `apps/cli/src/workspaces/sync/workspaceSyncTargetBootstrap.test.ts` |
| `16cb2a0220b51239e4fc95aa666ba8e5b8a3f3eb` | fix(ui): preserve workspace destination preflight refusals | `apps/ui/sources/sync/ops/sessionHandoffs.thinClient.test.ts`<br>`apps/ui/sources/sync/ops/sessionHandoffs.ts` |
| `59b677d322c3b6280c47ead1131866a12a3ce890` | fix(protocol): retain opted-in RPC refusal envelopes | `packages/protocol/src/actions/actionExecutor.workspaceSyncRelationshipCreate.test.ts`<br>`packages/protocol/src/actions/executor/actionFailureEnvelope.ts` |
| `03ea936ff8bb7628ef7dd2bf3a7e3bc795a06321` | fix(services): retain admitted execution in launcher observations | `apps/cli/src/daemon/local/services/launch/feed.test.ts`<br>`apps/cli/src/daemon/local/services/launch/feed.ts`<br>`packages/protocol/src/local/services/launcher/v1.test.ts`<br>`packages/protocol/src/local/services/launcher/v1.ts` |
| `057ff6b303e2fd739cb63f3ed6bfd8d2d15b9a82` | fix(ui): renew retired watches when shared demand returns | `apps/ui/sources/sync/runtime/subscriptions/sharedSubscriptionStore.test.ts`<br>`apps/ui/sources/sync/runtime/subscriptions/sharedSubscriptionStore.ts` |
| `0ab2eeb5eca10803dc75d157d526aa75cf526e55` | fix(ui): show the source checkout in project approvals | `apps/ui/sources/components/approvals/ApprovalDetailScreen.test.tsx`<br>`apps/ui/sources/components/approvals/ProjectCommandApprovalFacts.test.tsx`<br>`apps/ui/sources/components/approvals/ProjectCommandApprovalFacts.tsx` |
| `0f2f4e09bae0e2440e6f8fff4799474af0640104` | test(ui): restore mounted approval and popover boundaries for stop | `apps/ui/sources/components/inbox/actionOperations/requestActionOperationStop.test.ts`<br>`apps/ui/sources/dev/testkit/harness/popoverHarness.ts` |
| `8c62ce6da9f3b3b717e40ea83e6bc82a767ee528` | fix(ui): align runner draft parsing and default density fixtures | `apps/ui/sources/components/sessions/drafts/newSessionDraftDeletion.ts`<br>`apps/ui/sources/components/sessions/shell/NewSessionDraftsSection.test.tsx` |
| `95e74ad677594be3f22240fdd0f4f4cc028cd181` | fix(services): correlate managed occurrences with native listeners | `apps/cli/src/daemon/local/services/launch/feed.test.ts`<br>`apps/cli/src/daemon/local/services/launch/feed.ts`<br>`apps/cli/src/daemon/local/services/runtime.ts`<br>`apps/cli/src/daemon/startup/startDaemonSessionControlRuntime.ts` |

## Validation performed

Checks used moving source after the canonical synchronization barrier. Applicable successful source results were checked against commands, terminal evidence and bytes before their source commits; Git commits did not rewrite those bytes. No historical lane GREEN was substituted for a missing execution. This report records those observed results, not a certification of later changes made while executor preparation was pending.

| Check | Terminal result and evidence |
| --- | --- |
| Protocol crypto/metadata | 4 files / 41 passed; `/tmp/bc9-approval-protocol-tests-retry.log`. Initial nonexistent package config failed before tests and was corrected at the root config owner. |
| Protocol owner-envelope proof | 100 passed; `/tmp/bc9-approval-protocol-envelope-tests.log`. |
| UI profiles, metadata projection, hydration, encryption | 6 files / 176 passed; `/tmp/bc9-approval-ui-crypto-tests.log`. |
| UI linked/drag/clock/Workflow identity | 7 files / 110 passed / 1 optional timing skip; `/tmp/bc9-approval-ui-identity-tests.log`. No aggregate speedup claim. |
| CLI detached Run sender | Complete owner file, 65 passed; `/tmp/bc9-approval-cli-sender-tests.log`. |
| UI Mini consumers | Marketplace/suggestions 86 passed, actual native-removal settings hook 19 passed; `/tmp/bc9-mini-ui-tests.log`, `/tmp/bc9-mini-ui-native-removal-tests.log`. Foreign marketplace test hunks remain held. |
| Server broker | Complete integration file, 17 passed; `/tmp/bc9-mini-server-tests.log`. Both prior BC8 failures pass on current source. |
| CLI retained Worktree parser | Complete category file, 13 passed from package cwd; `/tmp/bc9-mini-cli-package-cwd-tests.log`. Initial root-source attempt failed before tests at the publication lease; GATE4’s known native fixture cwd was respected on retry. |
| GATE4 authoring/Review/Body | 3 files / 65 passed; `/tmp/bc9-gate-authoring-current.log` (partial captured tool chunk, command in manifest). |
| GATE4 consumer/API union | 11 files / 118 passed; `/tmp/bc9-gate-ui-current.log` (partial captured tool chunk, command in manifest). React act warnings remain visible. Protocol policy-fixture attempt used a nonexistent config and failed before tests; no retry was needed because the fixture was independently held for its foreign policy producer. |
| GATE4 bootstrap recovery children | Complete file, 31 passed on nl3, exit 0; `/tmp/bc9-sync-bootstrap-current.log` is explicitly transcript-derived, not a full shell capture. |
| FX80 preflight classification | Complete owner file, 13 passed; `/tmp/bc9-sync-preflight-current.log` is explicitly transcript-derived. |
| FX63 returned RPC failures | 2 files / 11 passed; `/tmp/bc9-sync-protocol-current.log` is explicitly transcript-derived. |
| Services Protocol | Complete launcher owner file, 20 passed; `/tmp/bc9-services-protocol-current.log`. |
| Services UI and shared subscriptions | 6 files / 65 passed, exit 0; `/tmp/bc9-services-ui-auto.log`. AUTO selected its permitted controller fallback; this is not represented as a remote-host run. |
| Approval, popover and draft fixtures | 4 files / 114 passed, exit 0; `/tmp/bc9-ui-fixtures-auto.log`. |
| Services CLI/native occurrence | 4 files / 57 passed, exit 0 from package cwd on nl3; `/tmp/bc9-services-cli-package-current.log`. Root-cwd attempt failed before tests at publication admission; `/tmp/bc9-services-cli-auto.log`. The retry used the established package harness, not a lease bypass. |
| Web worker adapter, routing and telemetry | 3 files / 44 passed, exit 0; `/tmp/bc9-worker-auto.log`. The runtime adapter remains provenance-held despite GREEN. |
| Web worker asset builder and preparation | No tests executed; held, not GREEN. AUTO/mac3 and the single serial nl3 attempt both waited on canonical workspace/package-dist admission behind live shared owners. Their own waiting controllers were cancelled cleanly, terminal 130, without touching shared owners or locks. Logs: `/tmp/bc9-worker-assets-auto.log`, `/tmp/bc9-worker-assets-nl3.log`; exact unchanged three-file command and prerequisite are in the final Services manifest. |
| Services adjacent | `/tmp/bc9-services-ui-adjacent-current.log`: 2 files, 1 passed / 1 failed; 22 passed / 1 failed. The four-case launcher store passes; the mounted host fails at line 351 because the exact preparation expectation omits `heldOperationId`. That mounted fixture/source vertical stays held. |
| Public Protocol | Exit 1, one Usage diagnostic; `/tmp/bc9-protocol-typecheck.log`. |
| Public UI | Exit 1, 438 diagnostic headers including the missing foreign temporary config; `/tmp/bc9-ui-typecheck.log`. |
| Public CLI | Exit 2 on imported UI Action labels; `/tmp/bc9-cli-typecheck.log`. |
| Public Server | Exit 0; `/tmp/bc9-server-typecheck.log`. |

Additional selected-source invocations and dispositions are recorded by the final source manifests/evidence. No filtered or failed invocation is represented as an entire-suite pass. No browser/device, loaded-runtime reload, Windows/macOS native certification or release acceptance ran in BC9.

Seven pinned windows1-linux requests were cancelled before test execution (exit 130); no test result is inferred from them. AUTO replacements reused the canonical executor and publication admission. The AUTO asset request later remained in mac3 package-dist/workspace admission behind live shared compilers. Inspection established that its node:module/dynamic producer loading genuinely requires UI/CLI runtime preparation; a cwd change would not remove that contract. Its own controller was gracefully cancelled and verified terminal 130, with no TAP payload and no shared owner/lock mutation. One serial, unchanged three-file request then targeted the approved nl3 executor; full runtime preparation remained enabled, with no overlapping asset attempt or bypass. That request also remained before TAP behind dependency-install.lock and canonical workspace-lease-busy queue 5/6. Only its verified own waiting group was interrupted; its controller/wrapper were then absent and terminal 130 was observed. The asset packet is held for the unavailable prerequisite, not failed tests or an invented timeout. One initial sandbox UID-map setup failure and one pre-execution approval-review timeout were safely retried under the existing grant; neither was an evaluated denial or supplied test evidence. Foreign interleaved commits are excluded from every BC9 count and manifest.

The final byte audit found later changes in six selected paths. Exact stored-basis diffs showed inactive Session Action-confirmation projection; a new encryption-context-only fetch mode; changed attention paging/hydration demand and its performance assertions; and new widget/plugin dependency reads plus typed Session-spawn incompatibility reasons. These Session owner changes are material, so earlier Session GREEN is not reused to certify the current changed implementations. The daemon startup full-basis blob was not retained as a Git object; its selected native `readProcessRoots` adapter is still present, but its much larger mixed remainder is not re-certified. The detached Run sender hunk itself is unchanged; its 65-test result is scoped to the recorded sender contract, not the later foreign whole-file changes.

- `apps/ui/sources/sync/domains/session/listing/sessionListRenderable.ts`
- `apps/ui/sources/sync/engine/sessions/sessionById.ts`
- `apps/ui/sources/sync/engine/sessions/sessionSnapshot.performance.test.ts`
- `apps/ui/sources/sync/engine/sessions/sessionSnapshot.ts`
- `apps/cli/src/session/actions/createCliActionDeps.ts`
- `apps/cli/src/daemon/startup/startDaemonSessionControlRuntime.ts`

## Interrupted synchronization and retained shared staging

The Workflow-window and Action-fixture commits advanced HEAD successfully before a transient foreign `.git/index.lock` interrupted their per-path sync. After the lock was absent, BC9 verified the already-created commit’s parent/tree/ancestry and recovered only its guarded synchronization. No lock was deleted and no duplicate commit was created.

| Path | Pre-existing shared index | Old parent blob | Committed blob |
| --- | --- | --- | --- |
| `apps/server/sources/app/teams/credentials/providerBrokerAdmission.sqlite.integration.spec.ts` | `eeae91bc8a2d376783a07d5780abc570558d34e1` | `172b3c71267ac2c8e87bdb90a7153bacd1a508f6` | `63904dd2e51576028f0e254770a08a88aaa3422e` |
| `apps/server/sources/app/teams/credentials/providerBrokerAdmission.ts` | `9a41971ddb056f9201da4e1c8c72e352a268c556` | `21041a85f004f2b39a8b5f4d939813a34ad11539` | `133299ccc1a7eca2e849da4ae0f8a41a751a3ede` |
| `apps/cli/src/session/actions/createCliActionDeps.ts` | `ef98ec0136799fac3ac91345e152147cd743b301` | `ab7a1456a7f4a7dc58a22ab437b53fe86fa77924` | `acefb45f9820b561d5a1eef060e10169756d98cb` |
| `apps/ui/sources/components/approvals/ApprovalDetailScreen.test.tsx` | `644549747bf0c8fd9047baedfde29409a5ab0478` | `ed4824b8bf7543fc359e2dc5955895d6c3ea6993` | `f7a39bcfe2f478b0eb8e245b1c24ac5c58fc4002` |
| `apps/cli/src/daemon/startup/startDaemonSessionControlRuntime.ts` | `ca374cc9953ee8ca91610939cbe9bca49d3b53c1` | `f3c930bbbc48681229d1da25a16110ad59a1e36d` | `e1d12e1c26ec0bd27e89f4cf7f50e069670588d6` |

Main must inspect these staged intents before a later commit. BC9 did not replace them merely to make the index agree with HEAD.

Observed shared staging: 841 entries (386 M / 451 D / 2 R / 2 A). Starting shared staging was 753 entries (302 M / 449 D / 2 A). These counts describe shared state, not ownership or a clean-index claim.

## Main list — held source and mixed files

The list is reconciled to current filesystem-versus-HEAD bytes; already committed whole-file changes are omitted from held groups. A path in a group may retain only the stated foreign/mixed remainder. This is a commitability verdict, not authority to implement or take foreign work.

### sync-creation-recovery-preview

The defining composed creation test hunk 3 merges FX63/72/80 create scenarios with FX89 registered preview. Preview needs GATE4 authorizeMachineRpcRequest physical-target admission plus rpcHandlers hunk6. That hunk also changes ProjectWorkerDependencyV1Schema.array() to z.array(...), whose CLI-site authorship is not established by inspected MIG-B/GATE2 reports. Cannot take whole mixed hunk or drop its body lines. Controller FX80 hunk7 and FX63 hunk2 themselves are separable, but defining whole composed tests require the withheld preview closure.

- `apps/cli/src/workspaces/sync/workspaceSyncController.ts`
- `apps/cli/src/workspaces/sync/workspaceSyncTargetAuthority.ts`
- `apps/cli/src/workspaces/sync/workspaceSyncTargetBootstrap.ts`
- `apps/cli/src/workspaces/sync/workspaceSyncMutagenAdapter.ts`
- `apps/cli/src/api/machine/rpcHandlers.workspaceSync.ts`
- `apps/cli/src/daemon/startup/createProductionDaemonWorkspaceSyncRuntime.test.ts`
- `apps/cli/src/daemon/startup/createProductionDaemonWorkspaceSyncRuntime.testkit.ts`
- `apps/cli/src/workspaces/sync/workspaceSyncTargetAuthority.test.ts`

### signed-preparation-currentness

One installed requester/approval/Sync vertical retained by BC8, dependent on uncommitted requester Account custody and original-envelope routing. Current production runtime imports readRequesterAccountActionContext, adds callWorkspacePrepareBetween and validates original signed Script/Exec/Move inputs, then consumes new WorkspaceSyncFlushExpectation. Cannot land only adapters/types as a completed correction; approval lane owns the coupled installed-runtime/custody closure.

- `apps/cli/src/daemon/startup/createProductionDaemonWorkspaceSyncRuntime.ts`
- `apps/cli/src/workspaces/sync/workspaceSyncController.test.ts`
- `apps/cli/src/workspaces/sync/workspaceSyncHandoffAdapter.ts`
- `apps/cli/src/workspaces/sync/workspaceSyncHandoffAdapter.test.ts`
- `apps/cli/src/workspaces/sync/workspaceSyncPreparation.ts`
- `apps/cli/src/workspaces/sync/workspaceSyncTypes.ts`

### fx63-topology-list

CLI selector import hunk4 also removes SessionCreationCorrespondenceV1Schema and imports foreign buildSessionCreationCorrespondence. Complete-hunk rule prevents selecting only topology import. Leaving existing CLI topology decision active while adding new UI/shared owner violates the no-split-brain migration contract. UI worker test import/bootstrap hunks also merge GATE2 approval fixture changes. Hold full shared-selector extraction with its migrated consumers.

- `packages/protocol/src/workspaces/workspaceSyncTopology.ts`
- `apps/ui/sources/sync/ops/workspaceSyncRelationshipsListRpc.ts`
- `apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts`
- `apps/cli/src/session/actions/createCliActionDeps.ts`
- `apps/ui/sources/sync/ops/actions/defaultActionExecutor.projectWorkers.test.ts`
- `apps/cli/src/session/actions/createCliActionDeps.test.ts`
- `packages/protocol/src/actions/actionExecutor.ts`

### fx83-original-setup-continuation

Runner import hunk1 combines FX83 decision support with FX86b extracted actionOperationSetupReview and canRetainProjectSetupReviewV1. Types/runtime combine FX86b owner routing and Session/Run/Workflow contexts. Finite owner also contains held currentness/terminal changes; UI Action client hunk3 mixes new request identity with Mini schema typing. Service review files named in FX83 are now deleted/replaced without attributable report provenance. No partial schema/SDK or locale-only commit: consuming retained producer and all three decision surfaces must move coherently.

- `packages/protocol/src/actions/projectActionFamily.ts`
- `packages/protocol/src/actions/projectSetupConsentFailure.test.ts`
- `packages/plugin-sdk/src/actions/dtos/projectExecutionActionDtos.generated.ts`
- `apps/cli/src/daemon/actionOperations/actionOperationRunner.ts`
- `apps/cli/src/daemon/actionOperations/actionOperationTypes.ts`
- `apps/cli/src/daemon/actionOperations/createHostActionOperationRuntime.ts`
- `apps/cli/src/workspaces/projectSetup/projectFiniteAction.ts`
- `apps/cli/src/workspaces/projectSetup/projectFiniteAction.test.ts`
- `apps/ui/sources/components/projects/projectSetup/projectSetupConsentDecision.ts`
- `apps/ui/sources/components/projects/projectSetup/useProjectScriptsController.ts`
- `apps/ui/sources/components/projects/projectSetup/useProjectScriptsController.test.ts`
- `apps/ui/sources/components/projects/projectSetup/projectManifestActionClient.ts`
- `apps/ui/sources/components/projects/projectSetup/ProjectSetupReview.tsx`
- `apps/ui/sources/components/projects/projectSetup/ProjectSetupSessionReview.tsx`
- `apps/ui/sources/components/projects/projectSetup/ProjectSetupSessionReview.test.tsx`
- `apps/ui/sources/components/projects/projectSetup/ProjectScriptsBody.test.tsx`

### fx83-copy

Exact FX83 consequenceSkip insertions are attributable/separable; parent explicitly retains them with held consuming setup vertical, not as unused independent copy. Every other locale hunk remains foreign.

- `apps/ui/sources/text/translations/ca.ts`
- `apps/ui/sources/text/translations/de.ts`
- `apps/ui/sources/text/translations/en.ts`
- `apps/ui/sources/text/translations/es.ts`
- `apps/ui/sources/text/translations/fr.ts`
- `apps/ui/sources/text/translations/it.ts`
- `apps/ui/sources/text/translations/ja.ts`
- `apps/ui/sources/text/translations/pl.ts`
- `apps/ui/sources/text/translations/pt.ts`
- `apps/ui/sources/text/translations/ru.ts`
- `apps/ui/sources/text/translations/zh-Hans.ts`
- `apps/ui/sources/text/translations/zh-HantOverrides.ts`

### fx84-worker-composition

Harness hunk7 combines FX84 installed-worker selection and BC8-held Local Services runtime override; import hunk1 likewise combines both. Removing only executor wrapper gives the wrong supplied-worker dispatch, while taking whole hunk depends on held Services protocol/producer. MCP nonselected hunk1 imports listHappierMcpToolNames absent HEAD; it must not be included accidentally. FX84 MCP hunks2/4/5 are individually clean but do not complete worker parity without held harness.

- `apps/cli/src/session/actions/createCliActionExecutor.ts`
- `apps/cli/src/session/actions/createCliActionExecutorHarness.ts`
- `apps/cli/src/mcp/createHappierMcpServer.ts`
- `apps/cli/src/session/actions/createCliActionDeps.projectWorkers.test.ts`
- `apps/cli/src/mcp/createHappierMcpServer.projectWorkers.test.ts`

### fx85-service-managed-destination-ui

New hook and changed controls/observation/right-panel import FrontDoorRuntimeActionExecute, absent HEAD. Its exporting frontDoorRuntimeActionExecutor.ts hunk combines type introduction, isPluginSettingsIntentCurrent, requireActionSuccess assertion and readActionApprovalRequestCreatedError; parent gate reconnaissance confirms no GATE4 authorship for whole hunk. Cannot include foreign owner to repair closure, or land picker/request builder alone as complete New Machine continuation.

- `apps/ui/sources/components/projects/workers/WorkerDestinationPicker.tsx`
- `apps/ui/sources/components/projects/detail/services/useProjectServiceManagedMachine.ts`
- `apps/ui/sources/components/projects/detail/services/projectServicePlacementObservation.tsx`
- `apps/ui/sources/components/projects/detail/services/ProjectServicePlacementControls.tsx`
- `apps/ui/sources/components/projects/detail/services/ProjectServicePlacementControls.test.tsx`
- `apps/ui/sources/components/projects/detail/services/ProjectRightPanelServicesView.tsx`
- `apps/ui/sources/components/sessions/localServices/launcherStartAction.ts`
- `apps/ui/sources/components/sessions/localServices/launcherStartAction.test.ts`
- `apps/ui/sources/sync/domains/local/services/launch/machineRpc.test.ts`

### fx85-native-services

Native producer source hunk1 adds FX85 execution-input imports together with unclaimed switch from isApprovalRequiredByActionsSettings to resolveActionApprovalRouting/getActionSpec; later approval-routing hunk is same competing policy change. Defining test hunk12 merges FX85 native Move with GATE4 installed canonical read/Stop fixture and independent approval-waiver tests; shared setup imports add broader approval/requester fixtures. Existing Services/installed-runtime/Sync prerequisites are already BC8-held. Keep canonical starter with complete consumers/approval closure.

- `apps/cli/src/daemon/local/services/launch/projectDeclarations.ts`
- `apps/cli/src/daemon/local/services/launch/projectDeclarations.test.ts`

### fx82f-empty-query-projection

Composed regression requires sessionListRuntimeClock import in test h1, which also adds foreign Sync/Account harness imports. h2/3/5 install/retire the composed connection harness. FX82f says other lanes' composed-harness edits were preserved; its report does not claim those hunks. No edited hunk bodies permitted. Ask GATE4 owner for exact provenance, then include full test if matched. Existing focused 110-test union passes, but that does not establish authorship.

- `apps/ui/sources/sync/domains/session/listing/useSessionListQuerySourceState.ts`
- `apps/ui/sources/hooks/session/useVisibleSessionListPaneState.workflowRuns.test.tsx`

### bc8-observer-settings-currentness-migration

New observer, removal of predecessor observer and every requester/connection consumer are one lifecycle migration. Projection h2 imports settings-publication owner and diagnostics; h12/13 mix observer reference lifetime, private custody, settings publication and phase diagnostics in complete hunks. Credentials h6 similarly combines observation, settings refresh and retirement. Publication belongs to FX85, diagnostics to later lane provenance, and exact Move/currentness contracts depend on signed preparation below. Committing only the new owner or old deletion leaves active competing maps or unresolved imports. HEAD connectedServiceCredentialApi already references the new observer; this existing incomplete seam does not authorize another partial migration. Parent may unlock by combining independently attributed FX85/diagnostic and authority closures. No fresh broad-runtime test was launched because these selected hunks cannot yet form an attributed closed tree.

- `apps/cli/src/api/client/accountEncryptionCurrentnessObservation.ts`
- `apps/cli/src/daemon/sessionEncryption/requesterAccountEncryptionCurrentness.ts`
- `apps/cli/src/daemon/sessionEncryption/requesterAccountActionProjection.ts`
- `apps/cli/src/daemon/sessionEncryption/requesterAccountActionProjection.test.ts`
- `apps/cli/src/daemon/sessionEncryption/requesterSessionCredentials.ts`
- `apps/cli/src/daemon/sessionEncryption/requesterSessionCredentials.test.ts`
- `apps/cli/src/daemon/sessionEncryption/requesterSessionCredentialBinding.performance.test.ts`
- `apps/cli/src/daemon/sessionEncryption/createRequesterSessionRuntimeContext.ts`
- `apps/cli/src/daemon/sessionEncryption/createRequesterSessionRuntimeContext.integration.test.ts`
- `apps/cli/src/api/api.ts`
- `apps/cli/src/api/apiMachine.ts`
- `apps/cli/src/api/client/accountEncryptionMode.ts`
- `apps/cli/src/api/machineAccessGrantEnvelopeHost.composed.test.ts`
- `apps/cli/src/daemon/sessionEncryption/requesterAccountCurrentness.socket.test.ts`
- `apps/cli/src/api/machineAccessGrantEnvelopeHost.ts`
- `apps/cli/src/workspaces/projectAccountRows.ts`
- `apps/cli/src/settings/accountSettings/updateAccountSettingsV2WithRetry.ts`
- `apps/cli/src/settings/accountSettings/requesterAccountSettingsPublication.ts`

### bc8-signed-installed-preparation-and-Move-authority

Installed runtime h2 combines new Session custody, local-vs-Home currentness and signed requester/worker preparation in one complete hunk; HEAD finite runtime has neither verifyCurrent nor the later setup decision/attachment contract. startDaemon's forwarding h24 requires the moving Sync prepareBetween third context argument; requester projection similarly consumes exact manager-owned SOURCE/Move-child currentness proofs. Those producers and strict transport schemas remain mixed with active Sync, approval and later provider/role work. The entire signed authority direction must close together, not by taking foreign callers to satisfy import checks. createCliActionDeps detached-send h46 is separately selected; all its other hunks stay held. Services feed and FX90 original-own-custodian snippets may be selected independently by the Services lane with their exact independent evidence; this group does not claim those packets.

- `apps/cli/src/daemon/startup/createInstalledProjectFiniteRuntime.ts`
- `apps/cli/src/daemon/startup/createInstalledProjectFiniteRuntime.session.test.ts`
- `apps/cli/src/daemon/startDaemon.ts`
- `apps/cli/src/daemon/startup/startDaemonSessionControlRuntime.ts`
- `apps/cli/src/daemon/startup/createProductionDaemonWorkspaceSyncRuntime.ts`
- `apps/cli/src/api/apiMachine.ts`
- `apps/cli/src/api/machine/machineRpcAuthorization.ts`
- `apps/cli/src/api/rpc/RpcHandlerManager.ts`
- `apps/cli/src/api/machine/rpcHandlers.workspaceSync.ts`
- `apps/cli/src/session/transport/rpc/machineRpc.ts`
- `apps/cli/src/daemon/externalActions/executeExternalAction.ts`
- `apps/cli/src/daemon/externalActions/executeExternalAction.test.ts`
- `apps/cli/src/api/externalActionExecutionAuthorization.ts`
- `apps/cli/src/rpc/handlers/_actionDispatchAdapter.ts`
- `apps/cli/src/daemon/local/services/launch/projectDeclarations.ts`
- `apps/cli/src/daemon/local/services/launch/projectDeclarations.test.ts`
- `apps/cli/src/workspaces/projectSetup/projectFiniteAction.ts`
- `apps/cli/src/workspaces/projectSetup/projectFiniteAction.test.ts`
- `apps/cli/src/workspaces/projectSetup/projectSetupExecution.ts`
- `apps/cli/src/session/actions/createCliActionExecutorHarness.ts`
- `apps/cli/src/session/actions/createCliActionExecutorHarness.test.ts`
- `apps/cli/src/session/actions/createCliActionExecutorFromCredentials.ts`
- `apps/cli/src/session/actions/createCliActionExecutorFromCredentials.policyBinding.test.ts`
- `apps/cli/src/session/actions/createCliActionDeps.ts`
- `apps/cli/src/session/actions/createCliActionDeps.test.ts`
- `apps/server/sources/app/auth/externalActionExecutionAuthorization.ts`
- `apps/server/sources/app/api/routes/actions/externalActionExecutionAuthorization.sqlite.integration.spec.ts`
- `apps/server/sources/app/api/socket/rpc/registerSocketRpcHandlers.ts`
- `apps/server/sources/app/api/routes/machines/registerMachineAdmissionRoutes.ts`
- `packages/protocol/src/machines/peer/mediation/rpc/routePolicyV1.ts`
- `packages/protocol/src/sessions/creation/sessionRequesterBootstrapV1.ts`
- `packages/protocol/src/sessions/creation/sessionRequesterBootstrapV1.test.ts`
- `packages/protocol/src/workspaces/projectServiceRelocationV1.ts`
- `packages/protocol/src/machines/identity/installationIdentity.ts`
- `packages/protocol/src/rpc/socket.ts`
- `packages/sync-client/src/rpc/callSocketRpc.ts`

### fx86-native-Session-Run-Workflow-launch-custody

RuntimeCore h2 is an indivisible import hunk combining the new Project invocation/qualifier with foreign terminal-transcript-follow/projector/cleanup imports. The two needed new symbols do not exist in HEAD. Cold Run consumer h3 and qualifier publication h9/11/12 cannot land without this hunk; the new common native owner, Session startup, Machine producer and Workflow reservation lifecycle cannot be reduced to SDK/Exec-only dormant wiring. setup review extraction also shares whole imports/types with FX83 and approval contracts. SDK/context/service exports, ACP/Claude/Codex adapters and their tests are kept with that consumed vertical, not committed as an unusable horizontal API. Original FX86 collision is superseded by FX86b/c/d source changes and tests, but no fresh broad current-tree gate was run by this reconnaissance lane. FX86d report supplies historical composed source evidence only; parent must replay actual Run/startup/Workflow checks after a report-attributed closed packet exists. Isolated detached send envelope is separately offered and passed its complete 65-test current owner.

- `apps/cli/src/workspaces/projectSetup/projectAgentLaunch.ts`
- `apps/cli/src/workspaces/projectSetup/projectAgentNativeLaunch.ts`
- `apps/cli/src/workspaces/projectSetup/projectSetupAcceptedWorkspace.ts`
- `apps/cli/src/workspaces/projectSetup/projectSetupAcceptedWorkspace.test.ts`
- `apps/cli/src/workspaces/projectSetup/projectSetupPreparation.ts`
- `apps/cli/src/workspaces/projectSetup/projectSetupExecution.ts`
- `apps/cli/src/workspaces/projectSetup/projectFiniteAction.ts`
- `apps/cli/src/workspaces/projectSetup/projectFiniteAction.test.ts`
- `apps/cli/src/daemon/agentRuntime/runnerAgentProjectLaunch.ts`
- `apps/cli/src/daemon/agentRuntime/runnerAgentProjectLaunch.composed.test.ts`
- `apps/cli/src/daemon/agentRuntime/runnerAgentSessionOpenAttestation.ts`
- `apps/cli/src/daemon/agentRuntime/runnerDaemonPluginServicesHost.ts`
- `apps/cli/src/daemon/agentRuntime/runnerDaemonPluginServicesHost.nativeLaunch.test.ts`
- `apps/cli/src/daemon/agentRuntime/prepareForegroundAdmission.ts`
- `apps/cli/src/daemon/agentRuntime/foregroundAdmission.ts`
- `apps/cli/src/daemon/agentRuntime/foregroundAdmissionContract.ts`
- `apps/cli/src/daemon/agentRuntime/foregroundAdmissionContract.projectLaunch.test.ts`
- `apps/cli/src/daemon/agentRuntime/prepareForegroundAdmission.projectEnvironment.composed.test.ts`
- `apps/cli/src/cli/runBackendSessionCliCommand.ts`
- `apps/cli/src/daemon/types.ts`
- `apps/cli/src/daemon/spawn/prepareDaemonSpawnChildEnvironment.ts`
- `apps/cli/src/daemon/spawn/prepareDaemonSpawnLifecycle.ts`
- `apps/cli/src/daemon/spawn/createSpawnLifecycleCallbacks.ts`
- `apps/cli/src/daemon/startup/executeSpawnSessionRequest.ts`
- `apps/cli/src/daemon/startup/startDaemonSessionControlRuntime.ts`
- `apps/cli/src/daemon/startup/startDaemonSessionControlRuntime.projectLaunch.composed.test.ts`
- `apps/cli/src/daemon/startup/startDaemonSessionControlRuntime.claudeLaunch.composed.test.ts`
- `apps/cli/src/session/actions/lifecycle/sessionStartupProjectOperation.ts`
- `apps/cli/src/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler.ts`
- `apps/cli/src/session/actions/lifecycle/createSpawnNewSessionLifecycleActionHandler.startupCustody.test.ts`
- `apps/cli/src/session/actions/lifecycle/createForkSessionLifecycleActionHandler.ts`
- `apps/cli/src/session/actions/lifecycle/createContinueWithReplayLifecycleActionHandler.ts`
- `apps/cli/src/session/actions/lifecycle/requesterSessionLifecycle.ts`
- `apps/cli/src/session/actions/lifecycle/sessionLifecycleTypes.ts`
- `apps/cli/src/session/shared/spawnSessionContract.ts`
- `apps/cli/src/daemon/actionOperations/actionOperationSetupReview.ts`
- `apps/cli/src/daemon/actionOperations/actionOperationRunner.ts`
- `apps/cli/src/daemon/actionOperations/actionOperationTypes.ts`
- `apps/cli/src/daemon/actionOperations/actionOperationRpcHandlers.ts`
- `apps/cli/src/daemon/actionOperations/createHostActionOperationRuntime.ts`
- `apps/cli/src/daemon/actionOperations/createHostActionOperationRuntime.runSetup.test.ts`
- `apps/cli/src/api/apiMachine.ts`
- `apps/cli/src/api/machine/rpcHandlers.ts`
- `apps/cli/src/api/machine/rpcHandlers.executionRuns.composed.test.ts`
- `apps/cli/src/rpc/handlers/executionRuns/registerExecutionRunRpcHandlers.ts`
- `apps/cli/src/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction.ts`
- `apps/cli/src/agent/runtime/registry/engineRegistryTypes.ts`
- `apps/cli/src/agent/runtime/registry/engineRegistry/runtimeCore.ts`
- `apps/cli/src/agent/runtime/registry/engineRegistry/nativeAgentSession.ts`
- `apps/cli/src/agent/runtime/bridges/executionRun/executionRunProjectSetup.ts`
- `apps/cli/src/agent/runtime/bridges/executionRun/executionRunTypes.ts`
- `apps/cli/src/agent/runtime/bridges/executionRun/ExecutionRunHostBridge.ts`
- `apps/cli/src/agent/runtime/bridges/executionRun/nativeAgentExecutionRun.ts`
- `apps/cli/src/agent/runtime/bridges/executionRun/nativeAgentExecutionRun.test.ts`
- `apps/cli/src/agent/runtime/bridges/executionRun/nativeAgentExecutionRun.retainedParity.test.ts`
- `apps/cli/src/agent/runtime/bridges/executionRun/runtime/create.ts`
- `apps/cli/src/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol.ts`
- `apps/cli/src/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol.test.ts`
- `apps/cli/src/agent/runtime/session/process/runnerDaemonPluginServices.ts`
- `apps/cli/src/plugins/runtime/resolveExecutablePluginRuntimeRegistry.ts`
- `apps/cli/src/plugins/runtime/invocation/services/exec.ts`
- `apps/cli/src/plugins/runtime/invocation/services/exec.nativeLaunch.test.ts`
- `apps/cli/src/plugins/runtime/invocation/services/production.ts`
- `apps/cli/src/plugins/runtime/invocation/services/types.ts`
- `apps/cli/src/plugins/runtime/invocation/services/unavailable.ts`
- `apps/cli/src/plugins/runtime/context/terminalHost.ts`
- `apps/cli/src/plugins/runtime/context/terminalHost.nativeLaunch.test.ts`
- `apps/cli/src/plugins/runtime/context/terminalHost.creation.test.ts`
- `apps/cli/src/plugins/runtime/lifecycle/manager.targetActivation.test.ts`
- `apps/cli/src/agent/acp/runtime/publicSession/createPublicAcpSession.ts`
- `apps/cli/src/agent/acp/runtime/publicSession/createPublicAcpSession.nativeLaunch.test.ts`
- `apps/cli/src/daemon/workflows/workflowSessionStartup.ts`
- `apps/cli/src/daemon/workflows/workflowSessionContext.ts`
- `apps/cli/src/daemon/workflows/sessionStepExecutor.ts`
- `apps/cli/src/daemon/workflows/sessionStepExecutor.test.ts`
- `apps/cli/src/daemon/workflows/executionRunStepExecutor.ts`
- `apps/cli/src/daemon/workflows/executionRunStepExecutor.test.ts`
- `apps/cli/src/daemon/workflows/invocationRecoveryObserver.ts`
- `apps/cli/src/daemon/workflows/invocationRecoveryObserver.test.ts`
- `apps/cli/src/daemon/workflows/coordinator.ts`
- `apps/cli/src/daemon/workflows/coordinator.projectSetup.test.ts`
- `apps/cli/src/daemon/workflows/recovery.ts`
- `apps/cli/src/daemon/workflows/composedWorkflowHarness.test.ts`
- `packages/plugin-sdk/src/exec.ts`
- `packages/plugin-sdk/src/exec/index.ts`
- `packages/plugin-sdk/src/exec/index.public.ts`
- `packages/plugin-sdk/src/agentRuntime/context.ts`
- `packages/plugin-sdk/src/services/io.ts`
- `packages/plugins/claude/src/agent/runtime/nativeServices.ts`
- `packages/plugins/claude/src/agent/sdk/nativeExec.ts`
- `packages/plugins/claude/src/agent/sdk/nativeExec.test.ts`
- `packages/plugins/claude/src/agent/sdk/query.ts`
- `packages/plugins/claude/src/agent/sdk/types.ts`
- `packages/plugins/codex/src/agent/runtime/appServer/client.ts`
- `packages/plugins/codex/src/agent/runtime/appServer/client.test.ts`
- `packages/plugins/codex/src/agent/runtime/appServer/sharedServer.ts`
- `packages/plugins/codex/src/agent/runtime/appServer/sharedServer.test.ts`

### bc8-active-approval-settlement-owner

BC8 explicitly excluded active ACT-UNIFY decision/settlement/approval-envelope work. Current Action executor, policy, approval request/transition and failure diffs include broader registry/provider/Session/widget changes not attributable to assigned Fork B reports. FX86 consumes existing Account projects.prepare/heldOperationId admission and does not authorize taking these foreign decision-owner changes. Own cold setup-review schema refinement in operations/v1 is dependency-held with retained setup extraction, not evidence that whole approval files are ours.

- `packages/protocol/src/actions/actionExecutor.ts`
- `packages/protocol/src/actions/actionApprovalPolicy.ts`
- `packages/protocol/src/actions/actionApprovalPolicy.test.ts`
- `packages/protocol/src/approvals/approvalRequestV1.ts`
- `packages/protocol/src/approvals/approvalRequestV1.test.ts`
- `packages/protocol/src/approvals/approvalRequestTransition.ts`
- `packages/protocol/src/approvals/approvalRequestTransition.test.ts`
- `packages/protocol/src/approvals/approvalExecutionFailure.ts`
- `packages/protocol/src/actions/blockingApprovalCoordinator.ts`
- `packages/protocol/src/actions/externalActionApi.ts`
- `packages/protocol/src/actions/executor/types.ts`
- `packages/protocol/src/actions/operations/v1.ts`

### fx87-output-checkout-address

Output address helper h3 requires Workspace imports merged in actionOperationDetailPresentation h1 with a new resolveSystemTaskFailureMessage import; h2 uses that error presenter. No FX87 attribution for that new presenter. Services lane rechecked FX89/90 and found no claim, confirming the hold. terminal/workspace.ts h2 openCancelled is foreign; do not take whole file. Other listed output consumer hunks and the stale-fetched-operation regression are individually FX87, but committing them before the authoritative address helper/import and private presentation callback closes breaks the output path.

- `packages/protocol/src/terminal/workspace.ts`
- `packages/protocol/src/terminal/workspace.test.ts`
- `apps/ui/sources/components/inbox/actionOperations/actionOperationDetailPresentation.ts`
- `apps/ui/sources/components/inbox/actionOperations/projectCommandOutputHost.tsx`
- `apps/ui/sources/components/inbox/actionOperations/ProjectCommandOutputPane.tsx`
- `apps/ui/sources/components/projects/detail/surfaces/ProjectTerminalSurface.tsx`
- `apps/ui/sources/components/projects/detail/surfaces/ProjectTerminalSurface.test.tsx`
- `apps/ui/sources/components/sessions/terminal/sessionTerminalActions.ts`
- `apps/ui/sources/components/sessions/terminal/sessionTerminalWorkspaceRuntime.ts`
- `apps/ui/sources/components/sessions/terminal/useSessionEmbeddedTerminalPty.ts`
- `apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts`
- `apps/ui/sources/components/projects/projectSetup/ProjectScriptsBody.test.tsx`

### dependent-documentation

Installed requester/observer/Move and Session/Run/Workflow paragraphs remain coupled to the held runtime verticals. FX87 output-address/zero-step paragraphs remain with those respective source packets. Other Usage/history/provider/terminal/state paragraphs are foreign to assigned scope. Parent documentation lane owns report-by-report hunk adjudication; do not take whole canonical pages.

- `docs/actions.md`
- `docs/encryption.md`
- `docs/cli-architecture.md`
- `docs/runtime-core.md`
- `docs/compatibility.md`

### full Service UI Stop/Retry/observation vertical

FX76/90 bridge and recovery source is attributable, but runtimeActionExecutor h9 merges FX76 successful-control invalidation with unclaimed preview-open transport. Its h1 preview schema import is likewise unclaimed. launcher/sharedStore.test h5 merges Retry and Stop defining cases plus the rpc.machine-to-rpc.launcher publish fixture correction; taking full test needs mixed source h9, dropping h5 while taking later h6 breaks the fixture. Do not force a partial observation packet by silently editing or dropping bodies. Only independent shared-watch demand and UI duplicate IDs selected.

- `apps/ui/sources/sync/domains/local/services/inventory/api.ts`
- `apps/ui/sources/sync/domains/local/services/inventory/machineRpc.ts`
- `apps/ui/sources/sync/domains/local/services/inventory/sharedStore.ts`
- `apps/ui/sources/sync/domains/local/services/inventory/sharedStore.test.ts`
- `apps/ui/sources/sync/domains/local/services/launch/sharedStore.ts`
- `apps/ui/sources/sync/domains/local/services/launch/sharedStore.test.ts`
- `apps/ui/sources/sync/domains/local/services/launch/useLocalServiceLauncherState.ts`
- `apps/ui/sources/components/sessions/localServices/useLocalServiceLiveFeeds.ts`
- `apps/ui/sources/components/sessions/localServices/useLocalServiceLiveFeeds.test.ts`
- `apps/ui/sources/sync/domains/local/services/actions/runtimeActionExecutor.ts`
- `apps/ui/sources/sync/domains/local/services/actions/runtimeActionExecutor.test.ts`
- `apps/ui/sources/sync/ops/actions/defaultRuntimeActionExecutor.ts`

Next deciding action: establish exact preview transport report provenance and its policy/schema dependencies, then select the complete Services owner/test closure

### Service UI Move transport

FX60 report read fully. Its single machineTarget:target line lies inside defaultActionExecutor h15 with foreign machine-owned-plugin admission/review replacement. defaultRuntimeActionExecutor is clean FX60, but committing it alone consumes held Services owner. Move test relies on held complete front-door wiring.

- `apps/ui/sources/sync/ops/actions/defaultActionExecutor.ts`
- `apps/ui/sources/sync/domains/local/services/actions/runtimeActionExecutor.relocation.test.ts`

Next deciding action: parent approval lane adjudicates whole mixed front-door hunk; do not create consumer-only transport

### installed Service routing and Move

FX57/69 own exact remote children and destination status, but harness h7 combines FX57/69 with FX84 worker wrappers; approval/custody/consent changes and signed Move context merge into credentialed binding/route/test hunks. Route h1 introduces requester custody imports with localService result imports; h2/4/6 require moving requester/signed Sync contracts. Protocol child port alone would be a dormant partial. Kept with approval/sync parent lanes, not independently selected.

- `apps/cli/src/session/actions/createCliActionExecutorHarness.ts`
- `apps/cli/src/session/actions/createCliActionExecutorFromCredentials.ts`
- `apps/cli/src/daemon/local/services/actions/projectServiceRelocationRoute.ts`
- `apps/cli/src/daemon/local/services/launch/projectDeclarations.test.ts`
- `packages/protocol/src/actions/executor/types.ts`

Next deciding action: jointly establish signed admission, currentness and FX84 composition closure through parent; current focused declaration owner GREEN still required

### FX88/88b foreground acquisition

Bootstrap h24/h25 jointly own FX88 decoupling and FX88b exact priority. WorkspaceProvider h3 merges route-anchor publication with replacing route query construction by workspaceRouteHref; that newly imported helper is absent HEAD and its uncommitted definition is not claimed by reports. Whole-hunk rule prevents committing only the route effect. New route fixture depends on this workspace owner. Readiness test h11 additionally contains an unclaimed children-prop mechanical rewrite.

- `apps/ui/sources/sync/syncEngine.ts`
- `apps/ui/sources/sync/sync.workspaceReadiness.test.tsx`
- `apps/ui/sources/sync/sync.routeAcquisitionPriority.test.tsx`
- `apps/ui/sources/components/appShell/workspace/WorkspaceProvider.tsx`
- `apps/ui/sources/components/appShell/workspace/workspaceRoutes.ts`
- `apps/ui/sources/components/sessions/shell/view/useSessionSurfaceActivation.ts`
- `apps/ui/sources/sync/domains/session/sessionSurfaceVisibility.ts`

Next deciding action: establish query helper ownership or await owner commit; then join exact route producer/consumer/bootstrap/tests

### origin deferral and machine facts

FX75 deferred readCanExecute h29 mixes storedTarget and machineRejections owned outside these reports. FX88b machine facts can identify clean producer hunks7-13 but consumer simplification h23 merges storedTarget revision changes, and import/selector hunks mix foreign settings target migration. Tests likewise mix selection migration and origin regressions. Do not select a partial fact spine or foreign selection state to repair closure.

- `apps/ui/sources/sync/domains/machines/administration/usePluginExecutionOriginSelection.ts`
- `apps/ui/sources/sync/domains/machines/administration/usePluginExecutionOriginSelection.identity.test.tsx`

Next deciding action: origin authority owner must establish complete same-concept selection changes/provenance before committing these combined hunks

### web Worker runtime

FX88b report says the existing deadline terminates the Worker. Current routing h8 instead bypasses that native deadline for web; current web.test is one entire hunk containing >deadline response, pending cancellation and 500-Artifact scenarios unclaimed in report. encryption.ts hunks1-7 retain successful keys outside FX88b's narrow claimed signal forwarding (only h8/h9). Whole current test cannot be taken without unclaimed mechanisms. Clean source asset producer selected separately.

- `apps/ui/sources/sync/encryption/nativeCryptoWorker/nativeCryptoWorker.web.ts`
- `apps/ui/sources/sync/encryption/nativeCryptoWorker/nativeCryptoWorker.web.test.ts`
- `apps/ui/sources/sync/encryption/nativeCryptoWorker/nativeCryptoWorkerRouting.ts`
- `apps/ui/sources/sync/encryption/nativeCryptoWorker/types.ts`
- `apps/ui/sources/sync/encryption/encryption.ts`

Next deciding action: obtain later deadline/Artifact provenance and currentness/key-retention ownership; preserve all current worktree bytes

### FX89 file trace

FX89 owns opt-in Script/Exec tracing, but source h1 and test h1 also introduce unconditional plugins.list tracing with flag0, absent every assigned report. Cannot edit the hunk body to remove it.

- `apps/cli/src/daemon/externalActions/externalActionPhase.ts`
- `apps/cli/src/daemon/externalActions/externalActionPhase.test.ts`

Next deciding action: establish plugins.list trace authorship/authority or wait for its owning commit

### FX90 offline worker status

Source h18 merges presence-independent status with detachedMachine routing and reviewed Move-child role changes. Guard signature h5/h6 alone is incomplete. Test h2 is exact FX90 regression but requires held source.

- `apps/server/sources/app/api/socket/rpc/registerSocketRpcHandlers.ts`
- `apps/server/sources/app/api/socket/rpc/registerSocketRpcHandlers.authorizationRace.sqlite.composed.integration.spec.ts`

Next deciding action: parent signed/server lane establishes all h18 dependencies and complete hunk provenance

### FX90 own-custodian admission

Delegated to approval lane alongside installed/requester custody and many mixed startup hunks. Only clean FX81b startup h21 selected here. FX90 report explicitly does not prove loaded app UI copy refusal, which bypasses installed wrapper.

- `apps/cli/src/daemon/startup/startDaemonSessionControlRuntime.ts`
- `apps/cli/src/daemon/externalActions/executeExternalAction.filesystemApprovals.test.ts`
- `apps/cli/src/daemon/externalActions/executeExternalAction.filesystemApprovals.testkit.ts`

Next deciding action: approval lane manifest owns exact admission/test hunk decision; no duplicated packet here

### FX89 requester admission and preview

Requester admission delegated to approval lane; Sync preview delegated to sync lane. Sync source h7 depends on h3/h4 projector signature; composed creation h3 includes FX63/72/80+89 and startup/wire seams, so no consumer-only extraction. GATE4 strict schema issue assertion joins that same source/test closure.

- `apps/cli/src/daemon/sessionEncryption/requesterAccountActionProjection.ts`
- `apps/cli/src/api/externalActionExecutionAuthorization.ts`
- `apps/cli/src/rpc/handlers/externalAction.ts`
- `apps/cli/src/daemon/externalActions/executeExternalAction.ts`
- `apps/cli/src/api/machine/rpcHandlers.workspaceSync.ts`
- `apps/cli/src/daemon/startup/createProductionDaemonWorkspaceSyncRuntime.test.ts`
- `apps/cli/src/workspaces/sync/workspaceSyncTargetAuthority.test.ts`

Next deciding action: parent combines approval and Sync lane manifests; current GREEN remains necessary

### unclaimed Service setup deletions

Sync agent observed current filesystem deletions; FX88/88b/90 reports claim no such replacement or deletion. Not credited to any assigned report and not selected.

- `apps/ui/sources/components/sessions/localServices/LocalServiceSetupConsentCard.tsx`
- `apps/ui/sources/components/sessions/localServices/LocalServiceSetupConsentContinuation.test.tsx`

Next deciding action: owning program must supply replacement/removal intent and provenance

### mixed mounted Services test import

FrontDoorRuntimeActionExecute import migration is unclaimed by FX76 and distinct from its exact daemon-event fixture. Keep import hunk uncommitted even if selected fixture hunks2-4 pass.

- `apps/ui/sources/components/sessions/localServices/LocalServicesSurfaceHost.test.tsx`

### mixed approval page tests

Portable replay, Session delete readability, Browser accepted-operation presentation and plugin provenance are not FX90's root-fact regression; only h13 selected.

- `apps/ui/sources/components/approvals/ApprovalDetailScreen.test.tsx`

### generated/evidence/secret exclusions

Generated public asset stays ignored; QA captures/logs/probes are evidence, not source packets; no key or qa credential file read/selected.

- `apps/ui/public/happier-crypto-worker.js`

### apps/ui/sources/sync/ops/actions/frontDoorRuntimeActionExecutor.ts

All 4 hunks held; GATE4 type import/export/return correction mixes in hunk -7 with isPluginSettingsIntentCurrent, assertion change, approval-error reader; final return-type hunk mixes presentation callback changes. No impl-B report names those symbols.

- `apps/ui/sources/sync/ops/actions/frontDoorRuntimeActionExecutor.ts`

### apps/ui/sources/components/projects/workers/WorkspaceWorkerSettings.test.tsx

Entire remaining setup currentAccount/explicit Ask-first hunk not claimed in GATE4 or GATE4b; preserve as unattributed foreign policy fixture work.

- `apps/ui/sources/components/projects/workers/WorkspaceWorkerSettings.test.tsx`

### apps/ui/sources/components/projects/projectSetup/useProjectScriptsController.test.ts

FX86d worker-held Script regression separate from gate parsing corrections; sync owner.

- `apps/ui/sources/components/projects/projectSetup/useProjectScriptsController.test.ts`

### apps/ui/sources/components/projects/projectSetup/ProjectScriptsBody.test.tsx

FX87 output-composition regression; approval owner.

- `apps/ui/sources/components/projects/projectSetup/ProjectScriptsBody.test.tsx`

### apps/ui/sources/components/projects/projectSetup/ProjectSetupSessionReview.test.tsx

GATE4 spy restorations embedded in the FX83 mounted Session regression hunk; sync owner.

- `apps/ui/sources/components/projects/projectSetup/ProjectSetupSessionReview.test.tsx`

### apps/ui/sources/text/translations/ca.ts

Historical GATE4b locale label ownership moved to existing HEAD features locale owner; no label delta remains here. All other locale changes foreign.

- `apps/ui/sources/text/translations/ca.ts`

### apps/ui/sources/text/translations/de.ts

Historical GATE4b locale label ownership moved to existing HEAD features locale owner; no label delta remains here. All other locale changes foreign.

- `apps/ui/sources/text/translations/de.ts`

### apps/ui/sources/text/translations/es.ts

Historical GATE4b locale label ownership moved to existing HEAD features locale owner; no label delta remains here. All other locale changes foreign.

- `apps/ui/sources/text/translations/es.ts`

### apps/ui/sources/text/translations/fr.ts

Historical GATE4b locale label ownership moved to existing HEAD features locale owner; no label delta remains here. All other locale changes foreign.

- `apps/ui/sources/text/translations/fr.ts`

### apps/ui/sources/text/translations/it.ts

Historical GATE4b locale label ownership moved to existing HEAD features locale owner; no label delta remains here. All other locale changes foreign.

- `apps/ui/sources/text/translations/it.ts`

### apps/ui/sources/text/translations/ja.ts

Historical GATE4b locale label ownership moved to existing HEAD features locale owner; no label delta remains here. All other locale changes foreign.

- `apps/ui/sources/text/translations/ja.ts`

### apps/ui/sources/text/translations/pl.ts

Historical GATE4b locale label ownership moved to existing HEAD features locale owner; no label delta remains here. All other locale changes foreign.

- `apps/ui/sources/text/translations/pl.ts`

### apps/ui/sources/text/translations/pt.ts

Historical GATE4b locale label ownership moved to existing HEAD features locale owner; no label delta remains here. All other locale changes foreign.

- `apps/ui/sources/text/translations/pt.ts`

### apps/ui/sources/text/translations/ru.ts

Historical GATE4b locale label ownership moved to existing HEAD features locale owner; no label delta remains here. All other locale changes foreign.

- `apps/ui/sources/text/translations/ru.ts`

### apps/ui/sources/text/translations/zh-Hans.ts

Historical GATE4b locale label ownership moved to existing HEAD features locale owner; no label delta remains here. All other locale changes foreign.

- `apps/ui/sources/text/translations/zh-Hans.ts`

### apps/ui/sources/text/translations/zh-HantOverrides.ts

Historical GATE4b locale label ownership moved to existing HEAD features locale owner; no label delta remains here. All other locale changes foreign.

- `apps/ui/sources/text/translations/zh-HantOverrides.ts`

### apps/cli/src/storage/categories/worktrees.ts

opaqueItemTitle import/default titles, explicit result type, and ownVerdict parent retention are not claimed by MIG-B. These are separate full hunks from its optional conversion. No foreign closure imported into candidate packet.

- `apps/cli/src/storage/categories/worktrees.ts`

### apps/ui/sources/components/settings/plugins/model/pluginMarketplaceModel.ts

Account source-kind mapping, unloaded development-source visibility/presentation, installation Action result projection, and pending-decision Inbox migration are broader plugin work not attributable to assigned MIG-B/GATE mechanical changes. Preserve all.

- `apps/ui/sources/components/settings/plugins/model/pluginMarketplaceModel.ts`

### apps/ui/sources/components/settings/plugins/model/pluginMarketplaceModel.composed.test.ts

Actual filesystem is present despite inherited staged deletion plus untracked replacement. Explicit git show HEAD:path piped to diff against filesystem shows formatting across almost the full file, bundled-manifest fixture replacement, Account source-label assertions, development-source cases and pending-change behavior. Whole default hunks mix meanings and Fork B authorship is unproven; COMMIT-OWN-HUNKS forbids editing hunk bodies. Do not stage the apparent deletion or entire replacement.

- `apps/ui/sources/components/settings/plugins/model/pluginMarketplaceModel.composed.test.ts`

### Web crypto source-asset producer — validation prerequisite unavailable

Disposition: held_validation_prerequisite_unavailable. Required actual shared Worker-builder/password/task/freshness suite never reached TAP. Both AUTO mac3 and authorized serial nl3 attempt remained in canonical runtime publication/dependency preparation. Raw /tmp/bc9-worker-assets-auto.log and /tmp/bc9-worker-assets-nl3.log; each exited130 after parent-authorized cancellation of its verified own pre-payload controller only. No test failure or GREEN claimed.

- `apps/ui/tools/sourceAsset.mjs`
- `apps/ui/tools/password/buildPasswordKdfWorker.mjs`
- `apps/ui/tools/password/buildPasswordKdfWorker.test.mjs`
- `apps/ui/tools/crypto/buildCryptoWorker.mjs`
- `apps/ui/sources/sync/encryption/nativeCryptoWorker/webCryptoWorker.ts`
- `apps/ui/sources/sync/encryption/nativeCryptoWorker/webCryptoWorkerRuntime.ts`
- `apps/ui/tools/postinstall.mjs`
- `apps/ui/tools/resolveUiPostinstallTasks.mjs`
- `apps/ui/tools/resolveUiPostinstallTasks.test.mjs`
- `apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs`
- `apps/ui/scripts/installFreshnessInputs.contract.test.mjs`
- `apps/ui/package.json`
- `apps/ui/.gitignore`

Next deciding action: After canonical dependency/publication prerequisite becomes available: ./apps/stack/bin/hstack-exec --target=nl3 -- node --test apps/ui/tools/password/buildPasswordKdfWorker.test.mjs apps/ui/tools/resolveUiPostinstallTasks.test.mjs apps/ui/scripts/installFreshnessInputs.contract.test.mjs

### Explicitly rejected otherwise-green candidates

- Usage no-op subscriber assertions remain held: current HEAD still invalidates on equivalent Profile/settings references. The current GREEN needs an unattributed `usageQueryInvalidation.ts` change; adding only the test would not be self-consistent.
- Family labels remain held: both semantic families are absent from the committed canonical Action family owner. The additions cannot be certified from current worktree types or generated UI bootstrap strings alone.
- Worker adapter/deadline and its defining test remain held: the current no-deadline web-envelope behavior conflicts with FX88b’s reported existing-dispatch-deadline correction. Whole mixed hunks cannot be edited to manufacture attribution.

### Uncommitted remainders of committed paths

- `packages/protocol/src/sessions/metadata/terminalMetadata.ts`
- `apps/ui/sources/sync/encryption/encryption.ts`
- `apps/ui/sources/components/sessions/shell/useSessionListRenderModels.test.tsx`
- `apps/ui/sources/components/workflows/library/workflowLibraryReads.ts`
- `apps/cli/src/storage/categories/worktrees.ts`
- `apps/ui/sources/components/settings/plugins/model/pluginMarketplaceModel.ts`
- `apps/ui/sources/sync/domains/session/listing/sessionListRenderable.ts`
- `apps/ui/sources/sync/engine/sessions/readSessionLayout1OwnerProjection.test.ts`
- `apps/ui/sources/sync/engine/sessions/readSessionLayout1OwnerProjection.ts`
- `apps/ui/sources/sync/engine/sessions/sessionById.ts`
- `apps/ui/sources/sync/engine/sessions/sessionSnapshot.performance.test.ts`
- `apps/ui/sources/sync/engine/sessions/sessionSnapshot.ts`
- `packages/protocol/src/sessions/metadata/sessionMetadataEnvelopesV1.test.ts`
- `packages/protocol/src/sessions/metadata/sessionMetadataSchemasV1.ts`
- `apps/cli/src/session/actions/createCliActionDeps.ts`
- `apps/ui/sources/components/projects/projectSetup/ProjectSetupReview.tsx`
- `apps/ui/sources/components/projects/projectSetup/ProjectScriptsBody.test.tsx`
- `apps/ui/sources/components/projects/projectSetup/useProjectScriptsController.test.ts`
- `apps/ui/sources/sync/api/account/apiProjectTrust.test.ts`
- `apps/ui/sources/sync/runtime/subscriptions/sharedSubscriptionStore.test.ts`
- `apps/ui/sources/sync/runtime/subscriptions/sharedSubscriptionStore.ts`
- `apps/ui/sources/components/approvals/ApprovalDetailScreen.test.tsx`
- `apps/cli/src/daemon/startup/startDaemonSessionControlRuntime.ts`

## Documentation and excluded material

The inspected canonical documentation delta remains paired with its held owning source vertical. Existing source changes do not automatically establish the authorship of every paragraph. Exact relevant documentation hunks follow; all other inspected documentation hunks were foreign/unattributable and stayed untouched.

### docs/actions.md

- `@@ -124,9 +337,16 @@ config values and binding labels remain target-produced facts. An explicitly`: attributable_attach_to_source_vertical. Original held-operation setup-consent vertical: Protocol heldOperationId + expectedEffectDigest input, daemon actionOperationRunner/createHostActionOperationRuntime, projectFiniteAction, UI projectSetupConsentDecision + ProjectSetupReview/SessionReview + Services continuation.
- `@@ -1630,10 +1927,31 @@ provenance separately from native custody on the source and its current linked`: BC8_held_attributable_dependency_hold. Do not publish independently while paired authority/runtime remains held.
- `@@ -1677,6 +1995,15 @@ copied target before effects. Changed execution inputs fail with`: BC8_held_attributable_dependency_hold. Explicit FX62 docs67/94 claim; attach only when source vertical clears.
- `@@ -1695,6 +2022,22 @@ Sync status's optional lastCleanSyncAtMs records only an actually completed`: BC8_held_attributable_dependency_hold. FX53 docs347 explicit private requester/replay-envelope contract; attach only with full producer/consumer source vertical.

### docs/cli-architecture.md

- `@@ -478,6 +478,17 @@ the preference is not authenticated human consent, a Trust write or an invocatio`: attributable_attach_to_source_vertical. Same retained-target human setup-consent vertical as actions#9.
- `@@ -486,7 +497,9 @@ and rechecks consent afterward; the runner resumes the original retained invocat`: attributable_attach_to_source_vertical. Same setup choice owner across Scripts/Services/Session, with Service Skip declining pending Start.
- `@@ -608,9 +621,25 @@ rather than adopting it as a starter-independent native resource. Optional endpo`: attributable_attach_to_source_vertical. Destination-native Service starter/config hash checks plus retained New Machine Start/Move continuation (WorkerDestinationPicker, useProjectServiceManagedMachine, placement observation/control, launcherStartAction).
- `@@ -701,10 +730,44 @@ namespace, while the installed Agent identity remains separate from that tuple.`: attributable_attach_to_source_vertical. One whole hunk joins cold Project native launch custody (Session startup, native host qualifier/finalizer, Run-controller projection, Account-held decision, Workflow observation) and FX87 finite zero-step deferral. Source packet must include both because hunk bodies may not be edited/split.

### docs/runtime-core.md

- `@@ -1141,6 +1350,24 @@ completes omitted model and credential-route choices before materialization.`: attributable_attach_to_source_vertical. Cold native Project Run custody/retained setup review and Session-hosted pending invocation projection; Account projects.prepare held decision route; attached Machine composite runtime/cleanup.

### docs/compatibility.md

- `@@ -888,6 +894,20 @@ has no terminal/workspace.ts member producer; its absent workspace continues`: attributable_attach_to_source_vertical. Actual accepted output workspace address retained separately from cwd: terminal/workspace Protocol member, canonical readProjectCommandOutputWorkspace, fresh output Action presentation callback, docking/Project/Session terminal consumers.

### docs/surface-states.md

- `@@ -225,12 +230,18 @@ native root and system-background updates remain profile-runtime-owned.`: attributable_attach_to_source_vertical. Core Settings/Profile readiness decoupled from Sessions inventory, pre-readiness workspace route anchor and existing coalesced exact Session/key acquisition priority.

### docs/encryption.md

- `@@ -1305,6 +1338,24 @@ public key, a 24-byte nonce, a 16-byte tag, and the wrapped 32-byte data key —`: mixed_unreported_hold. Most of the hunk matches FX88b web Worker + synchronous retained-envelope validation. However its no-aggregate-deadline paragraph corresponds to current nativeCryptoWorkerRouting.ts bypassing runWithTimeout for webEnvelope, while FX88b report10/23 says existing dispatch deadline terminates held Worker and retains deadline RED/GREEN. Later timeout policy ownership is not established by that report. Whole-hunk procedure prevents taking just the established paragraphs.
- `@@ -2564,6 +2621,48 @@ user. Current source publisher, Session tuple, installation and grant checks`: BC8_held_attributable_dependency_hold. FX56.md130, FX62.md67/94, FX68.md72/95 explicitly claim these exact docs. Entire hunk mixes these related source verticals; publish only with complete cleared producers/consumers.
- `@@ -2574,6 +2673,31 @@ Account mode; neither infers it from keys. A verified API-token root can admit`: BC8_held_attributable_dependency_hold. FX53.md347 and FX70.md49/91 explicitly claim both purposes; attach only with full signed-controller/Move source vertical.

### apps/docs/content/docs/organize/projects-and-worktrees.mdx

- `@@ -229,6 +229,22 @@ occurrence rather than submitting another Run. Long-lived Services are separate`: attributable_attach_to_source_vertical. Same destination-native Service/New Machine acquisition vertical as cli-architecture#3; development-only availability and integrated/live/native qualification caveats retained.

- FX67.md remains held for blank EOF; FX77.md remains held for quoted patch/trailing/EOF whitespace. Evidence bodies were not normalized.
- Older/unscoped impl-B report/procedure corpus, moving tracking documents, QA captures, credentials, binaries, ignored `apps/ui/public/happier-crypto-worker.js` and first-party `.happier-plugin/plugin.json` outputs were excluded. No credential file was read to perform an audit.
- The ignored Plan-20 amendment remains held with BC8’s provenance/base-plan issue; sibling native source is outside this checkout. No sibling mutation or branch creation occurred.

## Adversarial reconciliation and remaining gate

The in-place self-check changed the result: it found semantic dependencies behind the Usage test and family labels despite clean imports; retained the observer/native launch verticals when full import hunks merged foreign authority/transcript work; separated an inherited staged deletion from the present marketplace test; kept failed mounted fixtures out; and recovered completed commits at the synchronization step. WeakMap identity, credential mutation, returned-key copying, null/changed/malformed envelopes, row publication locality and existing child recovery were exercised through the selected owner tests. No new fallback, policy owner, runtime limit, registry or source workaround was introduced by this lane.

Before this report commit: 3991 insertions / 221 deletions across the exact 35 BC9 commits; 138 unique paths. The source mirror remained moving. The audit compared all selected paths against their recorded source basis and explicitly reports the 6 later differences; details live at /tmp/bc9-audit.json.

Residual risk: unresolved mixed authorship and missing committed dependencies prevent the held source verticals from landing safely; failed public package gates prevent integrated clearance; source test GREEN is not loaded-runtime or release acceptance. Main must resolve the exact owning hunks, rerun their focused checks and public gates, then run the already-owned composed live journey after its authorized reload. BC9 performs no reload.

STATUS: BLOCKED
