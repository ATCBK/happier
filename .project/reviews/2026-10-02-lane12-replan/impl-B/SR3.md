| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| SR3-1 | medium | The privately admitted worker-status child publishes requester Project rows into the daemon's global Account projection. | CONFIRMED; repair the private read at its existing owner before clearing FX112. |

Independent Lane 12 Fork B SR3 security review: **one confirmed medium finding**. The cross-Machine factory exception itself has no confirmed authorization bypass in the inspected corridor. **Validation limits:** four normal suites passed together (154 tests); two independent, in-memory isolation probes deliberately failed on the reproduced defect. Four additional regression commands were cancelled after worker-admission waits, without test-runner results. This report does not clear package, loaded-runtime, native-platform, or release gates.

## Basis and scope

Read SR3-BRIEF.md completely, FX112.md, SR1.md and SR2.md. Used happier-review, verify-claims, happier-testing, attack-conclusion, remote-work and handoff-report guidance. Earlier reports supplied hypotheses; the conclusions below come from current source and this review's executions. This reviewer did not author FX112.

Observed HEAD initially `51dbed9d42e2cbdd4901aa043b4a93da8e5efe17`, finally `b178d466cd63da7c6989a219a61e890310692f1b`. The startup owner has staged/unstaged edits; worker and relocation owners have unstaged edits. These are shared current bytes, not an authorship claim about whole-file diffs. Reopened all three target predicates and the deciding row-publication branch before reporting; the finding remains present. No source, test, configuration, Git index, database, or product-runtime lifecycle was changed. Test probes transformed test modules only in Vite memory; no on-disk test or implementation mutation was made. Only this report is authored.

Scope: the three security targets in SR3-BRIEF, their canonical RPC/Home/requester/row-reader corridor, and relevant SR1/SR2 guards. FX112's UI observation/copy changes, broad plan completeness, historical LV22 diagnosis and release/predecessor compatibility are outside this bounded review.

## SR3-1 — private status observation escapes its invocation

**Location:** `apps/cli/src/workspaces/execution/projectWorkerAction.ts:65`–`:67`.

**Observed mechanism:**

1. The new branch extracts the admitted requester's raw credentials and passes them to `readWorkspaceSyncWorkerTargetSnapshot`, without its existing `authorization` option.
2. That helper selects the ordinary credential path in `apps/cli/src/workspaces/sync/workspaceSyncPreparation.ts:38`–`:44`.
3. `readProjectAccountRows` returns through `acceptSnapshot` at `apps/cli/src/workspaces/projectAccountRows.ts:299`. The private/public distinction is explicit at `:135`–`:137`: authorization/session-custody reads return a private snapshot; raw-credential reads call the global publisher. That publisher replaces `active` and notifies subscribers (`:64`–`:81`).
4. Request cleanup disposes private custody at `apps/cli/src/api/rpc/RpcHandlerManager.ts:925`–`:927`; it does not undo this global publication.

**Concrete misuse/consequence:** a legitimate SOURCE-bound Move status child reaches a keyless installed worker using a different requester token for the same Account. Instead of remaining a passive invocation observation, its read replaces the daemon's retained Project snapshot with requester-scoped, decrypted rows, including organization data unrelated to the status response. A different token changes the snapshot's scope key. The storage census then returns unavailable because its captured installed scope no longer matches (`apps/cli/src/daemon/startDaemon.ts:2786`–`:2789`). The production Sync runtime also subscribes to this global publication and feeds its relationships into reconciliation (`apps/cli/src/daemon/startup/createDaemonWorkspaceSyncRuntime.ts:300`–`:313`, `:330`).

The global publication and scope replacement were **observed** in the real installed RPC/factory/worker path. The storage refusal is **derived** from that observed scope mismatch and the exact census predicate; a live storage request was not executed. Sync subscriber reachability was inspected; arbitrary native execution, cross-Account disclosure, and data loss were not demonstrated or claimed. Medium reflects limited but concrete invocation-isolation and availability impact, recoverable by the daemon's ordinary Account refresh.

**Deciding reproduction:** an in-memory Vite transform extended the two existing SOURCE-bound status-child cases at `executeExternalAction.filesystemApprovals.test.ts:38`. It captured `getActiveProjectAccountRowsSnapshot()`, subscribed immediately before `status()`, retained the existing successful eligibility/output-contract assertions, then asserted that the private read preserved the daemon snapshot. Both plain and protected cases failed that new assertion:

```text
protectedInput=false: publications=1, replaced=true, retainedOrganizations=1
protectedInput=true:  publications=1, replaced=true, retainedOrganizations=1
```

A second run varied only the synthetic requester credential at the existing credential-admission fixture boundary, keeping the decoded Account identity unchanged. Both cases still reached eligible=true, then reported `scopeChanged=true` and failed the isolation assertion. This distinguishes a credential-scope overwrite from harmless pointer churn. These are product-contract failures, not setup/compilation failures.

**Minimal coherent fix:** consume the topology helper's existing private `authorization` option using the admitted carrier, rather than erasing custody to raw credentials. Its existing requester HTTP/cipher ports already support Move reads. Preserve the current before/after currentness checks and ordinary local behavior. Do not add another global cache, publication gate, authority or credential format.

The same-concept private raw reads at `apps/cli/src/api/externalActionExecutionAuthorization.ts:88` and `apps/cli/src/daemon/local/services/actions/projectServiceRelocationRoute.ts:49`, `:86` deserve the same correction in this touched Move corridor; they are pre-existing instances of the same bypass, not separate new authorities. The SOURCE Sync composition already demonstrates an existing private alternative with `sessionCustody` at `createProductionDaemonWorkspaceSyncRuntime.ts:886`–`:889`. The canonical row reader owns publication; callers must retain its custody distinction.

**Regression required:** extend the existing installed-child pair to assert successful eligibility while the daemon snapshot and scope remain unchanged, including a distinct requester credential and protected rows. Include retirement during an awaited read so a refused response cannot leave a global publication behind. Reuse the real row reader and existing HTTP/network boundary harness.

**Additional examined side effect, not a separate finding:** the raw path can enter prompt-rule migration at `projectAccountRows.ts:289`–`:295`, whereas private reads skip it. I did not prove an unauthorized durable write: `createCliPromptLibraryStore` has its own active-settings-scope/lifetime guard (`apps/cli/src/settings/prompts/promptLibraryStore.ts:40`–`:51`). The finding does not depend on assuming that guard can be bypassed.

## Remaining brief targets and attacks

| Attack / target | Result and deciding evidence |
| --- | --- |
| Arbitrary Action, method, purpose or changed input rides the factory exception | No bypass found in inspected code. `startDaemonSessionControlRuntime.ts:14790`–`:14801` requires the Move root, local admitted Machine/installation/actor, fresh admission, exact recipient RPC method, same token/binding/envelope and the shared reviewed-child predicate. RPC ingress additionally binds packet effect, method and actual params at `RpcHandlerManager.ts:389`–`:401`, then checks the decrypted child at `:831`–`:837`. Protocol's closed mapping rejects other effects; worker status requires service-start, the reviewed workspace and exact destination (`packages/protocol/src/workspaces/projectServiceRelocationV1.ts:28`–`:58`). |
| Root approved for Service A or Project A is spent on B | No cross-Service/Project substitution found. Status is a Machine/workspace eligibility read and contains no Service selector. Native Stop must equal the reviewed currentTarget; native Start must preserve declaration selection and the derived target identity (`projectServiceRelocationV1.ts:65`–`:81`). Receiver topology checks further bind current destination WorkspaceRef/root (`externalActionExecutionAuthorization.ts:88`–`:104`). Existing real-Home tests reject another workspace/effect/signer at `externalActionExecutionAuthorization.sqlite.integration.spec.ts:793`–`:800` and another managed Service at `:1222`–`:1230`; that extra integration run did not obtain a result here. |
| Receiver trusts the sender's root or installation claim | Refuted by the inspected production chain. `RpcHandlerManager.ts:674`–`:689` invokes authorization before opening private requester custody; `:810`–`:817` retains a fresh exact-packet recheck. `machineRpcAuthorization.ts:335`–`:346` sends the receiving installation's signed proof to Home. `registerMachineAdmissionRoutes.ts:48`–`:75` authenticates that installed receiver and independently invokes the canonical root verifier. `apps/server/sources/app/auth/externalActionExecutionAuthorization.ts:1561`–`:1602` verifies Home token/full binding, original-envelope digest, SOURCE signature, principal currentness, SOURCE admission and destination access/installation. V2 input is then opened and compared at the receiver, rather than trusted as plaintext from the sender. |
| Requester credentials fabricated, transported as local ports, or borrowed from another Account | Private material requires the host Symbol (`requesterAccountActionProjection.ts:239`–`:245`), exact recipient/purpose and a real opener (`:492`–`:524`). Account profile, encryption mode and key fingerprint are checked at `:285`–`:300`; plain Accounts require null material. Currentness surrounds the successful worker observation (`projectWorkerAction.ts:62`, `:106`). No raw token/key serialization or disk persistence was found in the changed adapter. **The decrypted global-row escape is SR3-1.** |
| Destination refusal or cancellation still saves placement/stops the incumbent | No bypass found. Distinct-target admission and cancellation checks precede placement persistence at `projectServiceRelocation.ts:80`–`:90`; Stop follows a fresh exact incumbent reread at `:101`–`:123`. The same-target branch only saves placement and returns unchanged. Later admission checks remain after Stop/preparation. The complete coordinator suite passed within the 154-test batch, including refusal preserving running state and cancellation retaining an already-confirmed Stop. |
| Session SOURCE relay altered by the new exception | The scoped HEAD diff shows the prior Session relay block retained, with the reviewed-Move exception inserted before it. Non-Move mismatches still require the same Session source Machine/installation, target, Action/request identity and current Session caller at `startDaemonSessionControlRuntime.ts:14802`–`:14825`. No separate loaded Session relay journey was run. |

### Replay, root settlement and cancellation

**Observed:** the receiver's fresh checks validate credentials, installed identities, exact packet/root and current access. The Move-child verifier at `externalActionExecutionAuthorization.ts:1568`–`:1602` does not consult the relocation operation store or approval Artifact's terminal state. RPC request-id state is removed at completion (`RpcHandlerManager.ts:933`–`:935`); disposal retires that invocation's private context, not the signed root globally.

**Derived:** sequential reuse of the same still-valid child packet can remain admissible after a root operation settles or is cancelled; settlement alone is not a revocation signal in the inspected verifier. In-flight cancellation is separately enforced by the request signal and coordinator checkpoints. Cross-root/input/installation substitution is still refused. The new status-child allowance does not establish globally consumed packets or immediate Artifact-based revocation.

This is the same explicit contract limitation identified in SR2, not evidence of a newly introduced exactly-once violation. No blanket single-use requirement was established by the brief/current owners, and this review does not recommend a consumption ledger. **Not executed:** captured-child resubmission after a real root cancellation/settlement, or repeated native Start. Such a refusal must not be claimed as verified by this review.

## SR1/SR2 regression and simpler-design assessment

- **FX103:** re-derived the exact finite other-Machine GET branch and private custody/token/binding/currentness restrictions at `apps/cli/src/api/externalActionExecutionAuthorization.ts:512`–`:521`, `:574`–`:578`. The complete requester-projection and RPC-manager suites passed. No weakening of those guards was found; this does not excuse SR3-1's separate row-publication bypass.
- **FX99:** the exemption still requires iroh/workspace_sync, Machine initiator, singleton workspace.sync, maxCalls=1, no Session and the matching singleton single-use list (`mintDirectRouteGrantV1.ts:280`–`:291`). No changed grant scope/consumer was found in this target. Its extra issuer/daemon regression commands were cancelled, so no new execution clearance is supplied. SR1's same-current-operation retry limitation remains explicit.
- **FX108:** terminal transport still requires exact root custodian/Machine/installation, excludes runner/PAT custody, checks socket credential currentness and reruns the canonical SOURCE verifier before delivery (`registerSocketRpcHandlers.ts:1682`–`:1711`). This predicate was reread; the additional real-Home regression command was cancelled.
- **Subtraction/split-brain attack:** removing the factory exception restores the legitimate SOURCE-bound receiver refusal. Reusing the existing reviewed-child owner is appropriate; introducing a second child authorizer or rebinding the root would be worse. The requester credential correction is necessary, but stripping private custody before a row read is unnecessary: the existing private row path already supplies the simpler complete behavior. No new reliability, persistence or coordination machinery is needed.

## Independent validation and sensitivity

All executions used `./apps/stack/bin/hstack-exec` AUTO and its synchronization barrier, against continuously moving mirrors. Source/Git stayed local. Remote compute followed the brief's standing authorization.

| Handle / target | Command or probe | Terminal result |
| --- | --- | --- |
| 8317 / nl3 | `env NODE_OPTIONS=--conditions=happier-source corepack yarn --cwd apps/cli vitest run --config vitest.config.ts src/workspaces/execution/projectWorkerAction.test.ts src/workspaces/execution/projectServiceRelocation.test.ts src/daemon/sessionEncryption/requesterAccountActionProjection.test.ts src/api/rpc/RpcHandlerManager.test.ts --maxWorkers=1 --reporter=dot` | Exit 0; **154 passed / 4 files**, 70.34s. |
| 3394 / mac2-linux | `env NODE_OPTIONS=--conditions=happier-source node --input-type=module -e <in-memory Vitest probe described below>`; existing SOURCE-bound status pair | Exit 1; **2 intended isolation failures / 129 filtered**, 91.71s. Both original eligibility/output assertions passed before the added failure. Linux, not native macOS. |
| 56249 / nl3 | Same probe plus distinct synthetic requester token at the credential boundary | Exit 1; **2 intended isolation failures / 129 filtered**, 58.99s. Both cases showed publications=1, replaced=true, scopeChanged=true. |
| 66100 / windows2-linux | CLI filesystem approval file; filter `SOURCE-bound Service Move\|reviewed child of a V2 Move\|protected Service Move\|reviewed Service Move\|refuses portable worker execution\|does not lend the installed Account relationship` | Cancelled; exit 130, **no test-runner result**. |
| 7207 / windows2-linux | Server integration config, `sources/app/api/routes/actions/externalActionExecutionAuthorization.sqlite.integration.spec.ts`; filter `admits only the reviewed Move destination status\|moves the reviewed Service\|retains the worker-bound` | Cancelled; exit 130, **no test-runner result**. |
| 35591 / windows2-linux | Server `sources/app/machines/peer/mediation/mintDirectRouteGrantV1.spec.ts` | Cancelled; exit 130, **no test-runner result**. |
| 98157 / windows2-linux | CLI unit config, `src/daemon/peer/iroh/machineCarrier.test.ts src/daemon/peer/mediation/verifyDirectRouteGrant.test.ts src/workspaces/projectAccountRows.test.ts` | Cancelled; exit 130, **no test-runner result**. |

The four cancelled commands used the same NODE_OPTIONS, public Yarn vitest entry point, maxWorkers=1 and dot reporter. Filter bars above are literal regex alternation in argv. They reported worker-admission queue waits; later waits produced no test output. Only their four identified review-owned controller process groups were terminated, and all four tool handles returned 130. No product-process termination or product timeout diagnosis is inferred.

**Probe reconstruction:** use the installed Vitest `startVitest('test', [file], options, viteOverrides)` API, with root=apps/cli, its existing config, run=true, maxWorkers=1 and testNamePattern='SOURCE-bound Service Move'. Supply one Vite pre-transform plugin affecting only the existing filesystem-approval test module. Extend its existing projectAccountRows import with the getter/subscriber and insert:

```ts
// Immediately before the existing "const result = await status().catch..." line:
const before = getActiveProjectAccountRowsSnapshot();
let publications = 0;
const release = subscribeActiveProjectAccountRowsSnapshot(() => publications++);

// After the existing successful assertActionOutputContract(...):
release();
console.log({
  protectedInput, publications,
  replaced: getActiveProjectAccountRowsSnapshot() !== before,
  scopeChanged: getActiveProjectAccountRowsSnapshot()?.scopeKey !== before?.scopeKey,
  retainedOrganizations: getActiveProjectAccountRowsSnapshot()?.organizations.length,
});
expect(getActiveProjectAccountRowsSnapshot(),
  'admitted child must preserve daemon Account snapshot').toBe(before);
```

For the second run, the same pre-transform also changes only the testkit's `admitRequesterAccountActionContext` credential argument at `executeExternalAction.filesystemApprovals.testkit.ts:800` from `protectedMoveCredentials ?? credentials` to `{ ...(protectedMoveCredentials ?? credentials), token: credentials.token + '-sr3-independent-requester' }`. The synthetic JWT payload/Account remains unchanged; the mocked Home credential boundary admits it. No production function, admission policy or internal domain logic is mocked or changed by these transforms. The existing harness substitutes HTTP/network/native boundaries; it is not a fully real Home/network or loaded-daemon experiment.

Mutation thinking from inspected assertions, **not production-source mutation execution**:

- Removing the new factory exception makes the SOURCE-bound success pair fail before eligibility; replacing requester material with installed keyless credentials makes the protected positive fail.
- Removing shared reviewed-input/destination constraints is challenged by the V2 changed-envelope/material/destination tests and real-Home wrong-workspace/effect/signer cases. The missing-packet/changed-input pair primarily tests RPC binding; it does **not** independently isolate every factory conjunct.
- Moving destination admission back after Stop fails the passing coordinator assertion that the incumbent remains running with no Stop/copy/start effects. The new refusal test does not separately instrument placement persistence, so source ordering supplies that part of the conclusion.
- Existing positive cases miss the private-publication defect: the added in-memory assertions expose it despite successful eligibility. Root-settlement replay, wrong-purpose, every wrong-installation/Home variant and native Start Service substitution are not claimed individually mutation-proven here.

The probes emitted existing connected-services reconciler-unavailable and root-overlap reconciliation warnings. Their severity is unattributed; neither warning is used as proof of SR3-1. Two exploratory routed searches returned exit 2 for guessed test paths; corrected explicit source paths supplied the evidence, and no absence claim relies on those errors.

## Adversarial closeout and residual risk

The alternative explanation of harmless snapshot identity churn was tested with a distinct requester token: the global scope changed. The row-reader's private branch, storage census predicate and Sync subscriber independently establish why that difference matters. The prompt-library guard constrained the initial concern about unrelated writes; no unproved durable-write or cross-Account exploit is promoted into the finding. Neighboring plain/protected Accounts, denied destination, post-Stop cancellation, changed Project/Service inputs, root signature/installation currentness and the retained Session relay were examined.

**Not run/cleared:** package typecheck/build, the four cancelled extra suites, loaded SOURCE/worker reload and Move journey, captured-packet replay after root settlement/cancellation, native cross-host transfer, Windows/macOS-native execution, UI/device QA or release certification. The security decision is bounded to the inspected current-source corridor and produced evidence; implementation reports' earlier package/live blockers are not waived.

Residual risk and next action: repair SR3-1 through the existing private row-read path across its reached Move consumers, add the discriminating installed-child isolation regression, and rerun that pair plus the cancelled adjacent authorization suites. The integration owner still owns public package gates and identifying/replaying the corrected loaded runtime. Do not describe this review as approval of global one-use packets, root-settlement revocation, full native/platform behavior, or FX112 completion.
STATUS: DONE
