# FX89d — remaining Script/Approve serial work

Implemented and tested daemon preparation deduplication and a redundant server Artifact-query removal. The ordinary primary Script reproduction falls from eight preparation HTTP requests to five; an exact Artifact read falls from three Artifact queries to two, including fresh readmission. **Acceptance remains blocked:** public CLI typechecking failed in shared UI dependencies; the existing server trace cannot distinguish per-request DB contention from scheduling/crypto costs; no changed runtime was reloaded or replayed. The reported 475-second authorization delay is not explained or reproduced by this lane.

## Delivered owners and boundaries

- `apps/cli/src/workspaces/projectSetup/projectFiniteAction.ts:269` now shares the dequeue placement policy with command preparation at the existing finite owner. Initial acceptance, dequeue, final native admission, consent wake, and a real worker copy retain their distinct freshness decisions. The worker path deliberately rereads after Sync rather than reusing policy across a potentially long copy.
- The same owner retains the resolved primary association through a no-op Sync preparation (`:655`). Actual setup effects revalidate it through `beforeSetupEffect` (`:786`); final native admission still resolves current association. This removes the primary no-op read without allowing a withdrawn checkout to launch setup or the requested command.
- A setup result of `no_launch` reuses its command review (`:811`). Actual setup execution still gets its subsequent review. Final review after native authorization remains because environment/tool preparation can change the facts being authorized. Consent retries retain their refreshed invocation, not an earlier review.
- `apps/cli/src/workspaces/projectSetup/projectFiniteAction.test.ts:571` exercises current tombstones before real setup/command effects. Its registered-RPC/Action-executor/operation/admission/terminal composition at `:603` counts the actual Home HTTP boundary by phase. Internal finite, policy, parser, custody and operation logic remains real; Home/socket and OS boundaries are substituted.
- `apps/server/sources/app/artifacts/artifactAccessService.ts:230` captures access/header/body/revision facts in one Artifact query, then uses the existing header/body projection owners. Previously the body was fetched separately within the same snapshot. `readSnapshotWithCurrentAdmission` and `readmitArtifactContentInTx` are unchanged: a second fresh admission still precedes disclosure.
- `apps/server/sources/app/artifacts/artifactExactRead.sqlite.integration.spec.ts` composes the public read service, real Prisma/SQLite, snapshot owner, stored-content/encryption projection and readmission. Plain/E2EE bytes and revisions survive; an outsider is refused; changing Account mode after capture closes refuses content. The DB delegate instrumentation preserves Prisma's bound receiver.

No renderer, shared UI component, style, layout or copy changed. The design-round effect is potential responsiveness only; no visible improvement has been observed. UI-craft's rendered-change workflow is not applicable. No canonical product documentation update is needed because the public wire, storage, consent and lifecycle contracts are unchanged.

## Counted daemon preparation

The existing ordinary primary/native Script fixture has no setup process and an already observed Account mode. These counts cover this composed preparation path, not every signed approval/custody round trip on a loaded daemon.

| Phase | Final execution-config HTTP | Final Project-row HTTP |
| --- | ---: | ---: |
| Initial association | 0 | 1 |
| Initial placement | 1 | 0 |
| Dequeue placement | 1 | 0 |
| Primary Sync preparation | 0 | 0 |
| First command review | 0 | 0 |
| No-effect setup execution | 0 | 0 |
| Native authorization | 0 | 0 |
| Final association | 0 | 1 |
| Final command review | 1 | 0 |
| Total | 3 | 2 |

The final test asserts no additional GETs or POSTs. Before the correction the same reproduction performed five config reads and three Project-row reads. Command reviews fall from three to two. No request count is converted into an assumed live time saving. Native authorization, current requester custody, final placement/currentness, setup consent, worker-copy checks and signed finite settlement remain with their existing owners.

The supplied LV14 traces establish that command review includes setup/provenance review plus config HTTP; workspace resolution reaches the Account-row HTTP owner. They do not isolate each Home request inside those spans. Thus the repeats are proven unnecessary work, but neither all 2–8 seconds of command review nor the 5.2-second sum of workspace resolves is assigned exclusively to HTTP. SCM/provenance and real native preparation remain alternative contributors.

## Sanitized server profile

Read-only source: `/home/leeroy.guest/.happier/stacks/agent-qa-l12-b/logs/run.1792197834778.log`. The parser emitted only closed endpoint/phase categories, mapped sample numbers, counts and timings. It retained no request bodies, commands, paths from requests, environment values, credentials or content. The final projection is `/tmp/happier-fx89d-server-samples.json`; parser: `/tmp/happier-fx89d-profile.mjs`.

Observed window: **2026-10-17 01:10:00.002–01:14:59.998 UTC**, covering the three supplied LV14 samples. 173,917 parsed records; 5,943 incoming and 5,904 completed records. Only requests with a matching incoming/completion id inside this window enter endpoint distributions. These are shared-Home observations, not exclusive attribution to LV14's initiating caller. The loaded historical runtime is the LV14 basis, not the modified current source.

| Endpoint | Matched count | Median ms | p95 ms | Maximum ms |
| --- | ---: | ---: | ---: | ---: |
| Exact Machine GET | 375 | 49.04 | 619.07 | 3390.75 |
| Exact Artifact GET | 118 | 82.40 | 1884.41 | 2934.73 |
| Artifact recipient-census GET | 92 | 116.86 | 572.43 | 3317.37 |
| Exact Artifact update POST | 10 | 678.61 | 4789.62 | 4789.62 |
| Artifact inventory GET | 55 | 545.34 | 2932.00 | 3968.13 |
| Artifact selected-batch POST (`/v1/artifacts/read`) | 11 | 14808.69 | 19754.07 | 19754.07 |

The earlier broad Artifact category mixed exact updates with selected-batch reads; the table above supersedes that grouping. Exact sample-Artifact joins also show update maxima of 3539.73 / 4789.62 / 2034.98 ms for samples 1/2/3. Those joins identify the Artifact, not the initiating caller or a unique approval subphase.

Observed DB/phase distributions in the same window: `Artifact.findFirst` median 3.76 ms, p95 11.42 ms, max 1543.32 ms; `Machine.findUnique` median 3.53 ms, p95 30.58 ms, max 2779.01 ms. Transaction callback maximum is 15.536 s and attempt maximum 15.707 s. Authentication-principal and Home-environment phases reach 3.920 s and 4.180 s respectively. These nested/shared distributions must not be summed or treated as exclusive costs.

**Conclusion: not proven to be shared-DB contention only.** Most measured point queries are short, while transactions/authentication and endpoints have long tails. Wall-clock query spans include scheduling delays; the available trace does not join these Artifact/Machine HTTP requests to their individual DB/crypto subphases. There is no isolated crypto measurement or DB-wait evidence that decides the alternative causes. No timeout, connection-pool change, cache, guard relaxation or DB mutation was justified.

Verified source waste is the extra exact-content query removed above. A separate reachable bulk cost remains: `readArtifactBatchForCaller` loops over requested ids through the existing canonical read/census owners. The slow batch observations and that source loop warrant its existing batch owner/test follow-up, but do not prove the exact input size or exclusive cause of a particular live request. No competing batch decision-maker or parallel reader was added.

## Validation and setbacks

All source validation and broad repository retrieval used `./apps/stack/bin/hstack-exec`, principally pinned to `linux1`, against the continuously moving synchronized mirror. The brief explicitly authorizes remote computation/workspace transfer under the user's standing **2026-10-10 authorization**. No `--local` or local compiler was used. Required ignored review documents and machine-local QA logs were read locally; `.project/reviews` is absent from the remote mirror. Early AUTO retrieval selected other configured workers; deciding checks below ran on linux1.

| Check | Terminal evidence |
| --- | --- |
| Daemon regression RED | Handle 55748, exit 1: five config reads versus three; three Project-row reads versus two. `/tmp/happier-fx89d-red.log`. |
| Focused daemon GREEN | Handle 28959, exit 0, one selected case. `/tmp/happier-fx89d-green.log`. |
| Dequeue policy wiring omission RED | Handle 19461, exit 1: removing the source-policy argument restores an extra config HTTP request in the first command-review phase. The argument was restored. `/tmp/happier-fx89d-wiring-red.log`. |
| Final daemon adjacent composition | Handle 38538, exit 0: three files, **93 passed**. Finite Actions, setup execution and finite RPC registration. Includes queue changes, copies, native environment/currentness, consent wake, Stop and both association-withdrawal controls. `/tmp/happier-fx89d-cli-final.log`. |
| Final complete preparation HTTP boundary | Handle 89881, exit 0: one selected case; exact phase counts, all POSTs accounted for, no additional GETs. `/tmp/happier-fx89d-http-final.log`. |
| Public CLI typecheck | Handle 50766, **exit 2**, 77 diagnostics in shared UI dependencies; first is `destinationRoute.tsx(55,72)`, followed by Automation composer diagnostics. No diagnostic names this lane's paths. This is a failed gate, not a pre-existing-failure certification. `/tmp/happier-fx89d-cli-typecheck.log`. |
| Server storage RED | Handle 82778, exit 1: Plain and E2EE bytes/revisions succeed, but three Artifact queries occur instead of two. `/tmp/happier-fx89d-server-owner-red2.log`. |
| Server storage GREEN | Handle 2942, exit 0: two cases, including mode changes between snapshots. `/tmp/happier-fx89d-server-owner-green.log`. |
| Final server storage GREEN | Handle 32103, exit 0: **2 passed**, additionally refusing an outsider. `/tmp/happier-fx89d-server-final.log`. |
| Adjacent stored-content/classification | Handle 28527, exit 0: two files, **6 passed**. `/tmp/happier-fx89d-server-adjacent.log`. |
| Public server typecheck | Handle 47954, **exit 0**: `corepack yarn --cwd apps/server -s typecheck`. `/tmp/happier-fx89d-server-typecheck.log`. |
| Scoped diff hygiene | `git diff --check` passed for all four delivered source/test files after final changes. |

The first broader daemon run had two invalid withdrawal fixtures: missing rows are retained by the Account-row projection, while actual deletion uses a newer tombstone. Correcting that exposed fixture scope contamination from the previous case's tombstone. Unique credential scopes fixed the harness; production was not weakened. That intermediate run was 91 passed / 2 failed; the final complete run above passed all 93.

Server route attempts on nl3 and linux1 without source conditions were cancelled before the deciding tests, exit 130, behind dependency/package preparation. The source-conditioned route attempt reached Vitest but remained idle during module collection; it was cancelled, exit 130. Exact runner/worker PIDs 804809/804844 were subsequently verified absent. Only the lane's own test handles were interrupted. The initial lightweight DB attempt used an unbound spy and failed at content admission; it is not valid RED. The final bound-delegate harness produced the intended query-count RED before the production change.

Automatic approval review rejected two proposed diagnostic commands because their output could expose filtered raw log content or arbitrary private-log field labels. Neither rejected command ran. The successful replacement uses a strict allowlist and emits only categories, mapped sample ids and timings; no additional approval remains pending.

No full server HTTP route suite, Postgres contention experiment, loaded-runtime replay, native Windows/macOS execution or UI/device QA passed in this lane. The server proof is composed real storage/readmission, not a claimed successful HTTP route run. No production/shared/repo-local retained database was changed; the canonical test harness used its own disposable remote SQLite database. All lane-owned validation handles are terminal or explicitly cancelled.

## Response for diag-403 (six lines; ready for the board owner)

The reported ~475 s launch authorization is not causally explained by the available traces; LV14's three Approve-to-native samples are 29.6–38.4 s.
The daemon reproduction exposed five config and three Project-row HTTP requests; the correction reduces those preparation reads to three and two, preserving distinct effect/currentness checks.
Exact Artifact reads also duplicated a content query; the server correction removes it while retaining fresh readmission, mode checks and access refusal.
QA exact Artifact updates have a 679 ms median and 4.79 s maximum; selected-batch reads are a separate 10.4–19.8 s hotspot.
The trace cannot distinguish per-request DB contention, scheduling and crypto costs, so this is not evidence of shared-DB contention alone or a measured live speedup.
Reload the changed daemon/server through their owners, replay the same signed Script, and correlate HTTP/DB/auth phases before assigning the remaining or historical delay.

[blocked] Actual board posting: no board transport or authoritative location for `diag-403` was supplied or available among callable tools. The six-line response above is delivered for the orchestrator to post; no external message was sent.

## Self-check and remaining work

The compact attack changed the result: worker policy is not reused across real Sync; primary setup effects gained their explicit current-association check rather than spending freshness on a no-op; withdrawal fixtures now use real tombstones and independent scopes; exact updates are separated from bulk reads; and server query instrumentation preserves the real Prisma receiver. Mode-change and foreign-caller checks attack removal of admission rather than only the happy-path query count.

Split-brain audit: finite preparation remains `createProjectFiniteAction`-owned, config decisions still use the canonical config client/resolver, association admission still uses `resolveProjectSetupAcceptedWorkspace`, and setup/native effects keep their established owners. No second cache, TTL, registry, grant, lifetime or resolver was introduced. Initial/dequeue/final policy decisions, real-copy revalidation and consent wake are intentionally retained distinct boundaries. Server HTTP, socket, batch and mutation callers continue using the canonical Artifact read/projection owner; fresh readmission and the existing bulk loop remain, rather than a new caller-owned shortcut. FX95's operation-store settlement and concurrent consent/tracing hunks were preserved.

[blocked] Integrated CLI validation needs the shared UI dependency diagnostics resolved and the public CLI typecheck rerun. Server package validation is green. [blocked] Runtime performance acceptance requires the orchestrator's permitted reload and fresh original Script/Approve capture; this lane has no lifecycle authority. Per-request server attribution additionally needs correlated DB/auth/crypto evidence. Native platforms remain unmeasured.

Residual risk: the deterministic reductions do not establish live latency, a first-output target, an under-five-second launch, elimination of the bulk hotspot, or the cause of the reported 475-second delay. Historical logs describe the loaded earlier runtime; the source corrections have not been observed in QA.

RELOAD NEEDED: daemon — apps/cli/src/workspaces/projectSetup/projectFiniteAction.ts; server — apps/server/sources/app/artifacts/artifactAccessService.ts. No reload performed.
STATUS: BLOCKED
