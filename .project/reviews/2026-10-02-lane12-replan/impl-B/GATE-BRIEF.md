# GATE lane brief (Sol, 2026-10-15)
Report: impl-B/GATE.md (append; last line `STATUS: DONE` or `STATUS: BLOCKED`). Final message ≤ 20 lines.
Read first: root AGENTS.md (in your context), apps/cli/AGENTS.md, apps/server/AGENTS.md, apps/ui/AGENTS.md, .agents/skills/happier-testing, plans 20/21/22/24/25/30/31/32 under .project/plans (Lane 12 Fork B) only where a failing test touches them.
Inputs: impl-B/FX53.md (tail, "named unrelated failures"), FX56.md (12 `projectDeclarations.test.ts` caller/fixture assertions; managedServicesOwner.test.ts undeclared `gateway` ~789), FX57.md (6 CLI + 17 UI broader failures), FX59.md (foreign `closeOwnedSessionTerminals.ts:109` uses `.nullable()` on a zod/mini schema).

## Goal
Make the union of Fork B's corridor tests GREEN and produce package evidence, then rule on reload safety.
1. Re-run each named failing file on current bytes (hstack-exec, detached runs with unique logs). Attribute every failure: Fork B owner bug, stale fixture, zod-mini migration consumer, or foreign/unattributed.
2. Fix at the canonical owner: production bug → RED→GREEN; stale fixture → align fixture to the real producer (no new internal mocks, no deleted assertions that guard a contract). Zod Mini consumer breaks (e.g. `.nullable()`/`.optional()`/`.extend` on mini schemas, including closeOwnedSessionTerminals.ts) → mechanical conversion to the mini functional form, minimal, build-only.
3. Run package typecheck for packages/protocol, apps/cli, apps/server (and apps/ui diffed against the baseline by error location; UI has ~1300 pre-existing errors) through the public `typecheck` scripts via hstack-exec. Fix errors in Fork B hunks; list foreign ones with file:line.
4. Reload ruling for FX53+FX56+FX57 closure (server + nl1 daemon, matched set): read each RELOAD NEEDED table and say concretely whether a stack restart is safe, and what precondition applies (e.g. "stop all running managed Services on the QA Machine first"). Do not demand Main D50 certification as a precondition if your own typecheck/test evidence covers the hunks; name any real blocker.
Split-brain rule: reuse/extend existing owners; no second path, no new mechanism, no limits.

## Must not
No git stash/reset/restore/checkout/clean/switch, no staging or commits, no QA stack start/stop/reload, no edits to other programs' production behavior beyond the mechanical mini conversions above, no `--local` heavyweight commands, never print secrets. Report unattributable failures as unattributed — never manufacture a clean tree.
