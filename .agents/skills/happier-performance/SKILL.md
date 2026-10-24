---
name: happier-performance
description: Performance invariants, anti-pattern checks, cost-contract tests and live measurement for Happier. Use when implementing, planning, testing or reviewing anything on a user-facing, sync, transcript, terminal, provider, server or daemon path that runs per arrival, per request, per render or at idle; when profiling or optimizing; or when a change adds a read, publication, subscription, timer, poll, cache, guard, pool, batch or dynamic import.
---

# Happier Performance

Performance is a product requirement here (root `AGENTS.md`, "Product priorities"). This skill owns _how_ to keep paths cheap. `happier-implement`, `happier-testing`, `happier-review` and `happier-plan` defer to it for performance. It doesn't replace their workflow, TDD, mock or owner rules.

These rules come from the PERF-E2E program (2026-10-20 → 23). Three days of fixes traced back to one habit: work triggered by "something may have changed" or "we might need this" instead of "a consumer needs this changed fact", with no test measuring cost at real scale. Evidence: `.project/plans/2026-10-20-performance-program/status-2026-10-23.md`.

## 1. Five invariants

A violation is a defect even when every correctness test passes.

1. **Work ∝ real change.** A producer publishes only facts that changed and keeps the identity of unchanged nested values. Nothing is republished just because a cursor, `observedAt`, revision carrier or array was rebuilt, or because two projections of the same fact disagree.
2. **Reads ∝ need.** A narrow question gets a narrow read: exact id or kind selection at the query owner, bodies only for open or visible items. Never page a whole inventory to find a few items. Never fetch what an existing canonical owner already holds; reuse its admitted rows (one loader per resource).
3. **Idle ≈ 0.** On a settled Home, server or daemon, nothing runs except **named liveness**: a presence heartbeat, a real deadline, an opted-in alert, each with its contract written beside it. Closed surfaces don't load. Never-presented tabs don't mount. Hidden documents don't animate.
4. **Fix the producer; don't guard the consumer.** An equality guard, compare-before-publish, memo, cache, WeakMap reuse, digest, `setImmediate`/yield, coalescing timer, retry or slower interval is a **band-aid** unless the producer has been shown to emit only real changes. Fix the producer, then delete the guard.
5. **Bounds come from real boundaries.** Pool sizes, batch sizes, page sizes and limits are derived from an external contract: the DB `connection_limit`, Postgres's 32,767 bind parameters, a platform limit, a protocol budget. Never from host core count, a nearby number or a guess. Root `AGENTS.md` "Risk-weighted execution" owns the rules for any new limit.

## 2. Twelve patterns to check, with where each one bit us

Use these as search prompts in the code you touch and its neighbours. A static hit is a lead. Confirm reachability before calling it a defect.

| #   | Pattern                                                                                | Incident (2026-10)                                                                                                                                                        | Root fix shape                                                                                                        |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | Unbounded `IN (...)` or bind list from an inventory- or caller-sized id set            | P2035: every Artifact list returned 500 on Postgres. P2029: a 35k-id read failed every 15–30 s.                                                                           | Bound demand first. Then a single array parameter, or chunking derived from the DB limit, inside one authorized read. |
| 2   | Whole-inventory scan or page loop to find a few items by kind or id                    | Prompt stack paged every Artifact for one header. Roles decrypted 22k bodies (127 s). Inbox drained 500 headers.                                                          | Exact id or kind selection at the list or query owner, shared by UI and daemon. For E2EE data, move the non-content selector (kind, state, ids, relationships, timestamps) into a server-visible field, as Sessions do; never content, titles or user text. |
| 3   | Producer re-emits equal values or fresh objects                                        | Artifact audience/provenance flips (92–138/min). Availability carrier. Whole `items` array passed to every Session row. Inventory refresh rebuilt rows from an empty map. Account-settings consumers re-derived "did my key change" on every unrelated write (memory worker, three daemon loops, Provider catalog). | Emit only changed facts; pass the baseline; keep per-row identity keyed, not positional.                              |
| 4   | Consumer equality guard, memo or compare-before-publish hiding pattern 3               | AppShell compare-before-publish. Whole-fleet signature compare.                                                                                                           | Delete after fixing the producer.                                                                                     |
| 5   | Clock or timer above its only consumer, with no consumer, or running while hidden      | Home planet 500 ms clock re-rendered four parent components 602× per 300 s. Quota polls. Timers for empty stores.                                                         | Clock in the leaf that displays it; schedule the real next deadline; only while visible.                              |
| 6   | Module-global strong Map or cache retaining superseded full objects                    | Session reachability retainer.                                                                                                                                            | Retain the compact projection only, or nothing.                                                                       |
| 7   | Eager activation, imports or prefetch for closed or never-presented surfaces           | SCM runtimes activated on describe. Details tabs mounted. Plugin activation at daemon start (174 MiB code+strings).                                                       | Activate or load on first real use; descriptor only until presented.                                                  |
| 8   | One logical read split into N requests across an `await`, or N reads per arrival       | 32 singleton Artifact POSTs. Per-row profile reads. Machine-access N+1.                                                                                                   | Gather before the await; set reads.                                                                                   |
| 9   | Process-global env mutation or host-core-sized pools                                   | Prisma engine and Iroh each ran 128 Tokio workers at idle.                                                                                                                | Size explicitly from the owning contract; set once, at the owner.                                                     |
| 10  | Lazy `import()` whose shipped-bundle interop differs from source                       | `import('undici')` had no `Agent` in compiled guests, so Sessions couldn't start.                                                                                         | Compiled-bundle import check for every lazy site.                                                                     |
| 11  | Yield, timeout or retry loop hiding expensive work; a failed batch re-firing on a loop | `setImmediate` per row in Artifact projection. Failed 35k batch re-fired every 15–30 s.                                                                                   | Remove the expensive work; failures settle with a typed result, no hot retry.                                         |
| 12  | Re-validating already-admitted values                                                  | Double warm-cache admission. Repeated Zod and strict-JSON passes (server Zod 53 s per 300 s). Stored-declaration reparse.                                                 | Admit once at ingress; carry the admitted type. Keep real ingress validation.                                         |

## 3. Landing checks for a perf-relevant change

- **Cost contract in the RED.** Assert a count, never wall time, at the owner boundary: renders or commits per arrival, SQL statements per request, requests per idle minute, bodies fetched per open, inventory pages per operation, timer fires per settled minute. It must fail on the old code for the intended reason. These are observable performance contracts, not the "incidental call counts" that `happier-testing` forbids. Assert the contract (N unrelated arrivals → 0 renders of unaffected rows), not how often an internal helper is called.
- **Scale-shaped fixture** whenever N matters: thousands of Artifacts, about 1k Sessions, 100+ Machines (`packages/tests/src/testkit/stress`). Assert that work stays O(changed), not O(total).
- **Real Postgres** for any query or ORM shape change. A SQLite pass is not evidence for Postgres limits or plans.
- **Compiled-bundle check** for any added or changed dynamic import or interop-sensitive dependency.
- **Consumer inventory:** apply the writer/reader and twin sweep in [happier-implement §4](../happier-implement/SKILL.md#4-select-the-smallest-coherent-systemic-change) before changing a seam contract. The spawn_new terminal-result change broke 17 tests across two programs.
- **Delete what the fix makes obsolete** (guards, caches, timers, yields) in the same change, and say so in the report.
- **Never trade freshness, approvals, revocation or currentness for speed** (performance plan R8). A required fresh check stays. Make it cheap; don't skip it.

## 4. Measure before and after

Every optimization claim needs a measured before and after, or an explicit reason measurement wasn't feasible. Recipes, pitfalls and the CI tiers are in [references/measurement.md](references/measurement.md). In short:

- count-based contracts gate;
- timings, heap and CPU are reported, not gated, until calibrated;
- profile a real loaded runtime identity;
- turn our own telemetry sampler off;
- run timing milestones on an export build, not the dev bundle.

## 5. Review output

For each finding, give:

- the verdict: **ROOT** (removes the cause), **MITIGATION** (reduces the symptom; name the root and its owner), **BAND-AID** (masks it), **OVER-ENGINEERED** (machinery without a real requirement; deletion test) or **REGRESSION RISK**;
- `file:line`;
- the producer or owner;
- the user-facing effect (an idle tab using cores, a list re-rendering, a slow first open, a never-settling Home);
- the simplest root fix, often a deletion.

Then list **same-pattern leads** elsewhere in the tree, with their reachability. A fix is incomplete while the same reachable pattern remains in its corridor (root `AGENTS.md`, "Scope-preserving solution economy").
