# PERF-E2E journey capture (development tooling)

Use the existing UI performance audit entry point. Its `journey` and `compare`
modes delegate cross-process capture to this Stack-owned directory. The older
UI stress scenarios remain available through that entry point; both modes use
the same CDP transport and sync telemetry report owner.

The orchestrator owns `agent-qa-perf` lifecycle. This tool attaches to the
browser returned by `dev-targets browser start`; it never launches a browser,
server, daemon, Expo or Metro. Retain the browser command's TTY handle and send
it SIGINT after the round, then verify its terminal cleanup result.
Close the controller's matching `agent-browser --session <lane> --cdp <endpoint>
close` session too; warm repetitions may deliberately reuse it within the round.

```sh
node apps/ui/scripts/perf/agentBrowserUiPerfAudit.mjs journey J13 \
  --session=P0-H --cdp=http://127.0.0.1:PORT --url=RETURNED_BROWSER_URL \
  --home-selector='[data-testid="session-list-view-options-trigger"]' \
  --cache=warm --ui-mode=export --capture-mode=counts --out=.happier/qa/perf/P0-H/J13-warm-1
```

Use the current loaded Home's stable test ID if its composition differs from
that example. `--page-id=ID` is required when CDP has several page targets. Each
output directory must be new. A cold J1 needs a freshly launched, anonymous QA
browser; this tool does not delete authentication or Account state to reset it.
Validate restore with dummy stdin first. Then feed the approved dev test key
straight from its file into the command with shell stdin redirection and
`--restore-stdin`; never put the value in arguments, environment, a JSON batch,
an agent-browser fill command, or evidence. The restore subprocess is adapted
from the approved providers audit helper, suppresses locator diagnostics and
clears the field on failure. J1 warm measures authenticated reload and skips
restore. Recreate only the owned QA browser between cold repetitions.

`J13` prepares authenticated Home outside its window, then records exactly five
minutes without interaction. Cold means the browser HTTP cache is disabled and
cleared; it does not imply an empty server cache or database. Warm leaves the
browser cache enabled. Neither mode changes freshness, approvals or revocation.

Every journey explicitly selects `--capture-mode=timing|counts`. Timing sets a
pre-document diagnostic override at the canonical telemetry owner and leaves the
React fiber hook OFF. Counts turns store telemetry and the fiber hook ON. Both
record CPU/network/long-task observations; count-run durations are never timing
evidence. The bundle records requested mode and observed enablement. An older UI
that cannot attest enablement fails with `RELOAD NEEDED`; only the orchestrator
refreshes the export. Use fresh cold browsers for five timing J1 repetitions,
then a separate count run for component/store attribution. Each bundle includes
B1–B8 declared report-status snapshots and actual host load before/after; report
status is not proof that another lane was actively capturing. Concurrent runs
are not a quiet-host baseline, even when percentiles can be computed.

Production captures require the stack to report `sourceUi=export` and both
server/daemon identities to have nonempty matching selected/loaded values and
live stack-owned PIDs. Configure `HAPPIER_UI_EXPORT_SOURCE_MAPS=1` before the
orchestrator's export start for original module/symbol attribution. The export
producer includes that option in its existing reuse decision. Source maps are
read after the capture, so their fetch/decoding is outside its counts/profile.
For component-name investigation, the orchestrator can select borrowed dev UI
and the lane uses `--ui-mode=dev`; dev timings never enter production comparison.

Bundles contain a CPU profile and mapped/generated summary, component commit
and render counts, canonical store/selector telemetry, safe network records
(initiator stacks, endpoint, body/transfer byte counts and overlapping duplicate
candidates), Socket.IO names/RPC method identifiers and frames per second,
long tasks, host load, and request/query/daemon diagnostics for the window.
The hook records its own overhead. It promotes PERF10's corrected alternate
identity rule, avoiding stale `PerformedWork` flags on unchanged children.
Store telemetry stays in `syncPerformanceTelemetry`; the canonical Zustand
storage hook reports actual notifications and per-selector evaluations/output
identity changes without changing subscription equality or storing values.
Selector events aggregate by function name, never by per-render function ids.
Anonymous inline selectors share an explicit anonymous bucket. Minified names
can change between exports and name collisions coalesce; use CPU source maps
and component evidence for callsite-level conclusions. Output identity-change
fields remain per-closure observations, not a count of component renders.

No headers, bodies, SQL parameters, auth state or socket argument values are
saved. The protocol owns capability-path redaction. A salted per-run digest
compares full request URLs/bodies without exposing them. A candidate means
overlapping equal requests, not proof of wasted work; unknown request bodies
cannot establish equality. Network transfer bytes include protocol overhead.

Server query counts are Prisma operation attempts from existing `db.*` latency
spans, not PostgreSQL physical-query counts (one Prisma operation may emit
multiple SQL statements). Server spans correlate by diagnostic request ID.
UI/server correlation uses returned request IDs where present, otherwise the
time window. Daemon diagnostics expose control completions, external Action
stages and latency spans; these are distinguished from browser RPC calls and
must not be counted as one RPC per stage. Daemon successful `/ping` probes are
intentionally suppressed by the existing logger, so their count is unavailable
from that source. Use endpoint/frame counts and the B7 investigation for intent.

Host CPU/RSS endpoint samples bracket the browser capture and include remote
command overhead; the bundle records their actual wider interval. RSS is not a
peak or retained heap. Daemon time-only log timestamps use the file date, local
timezone and observed midnight rollovers; long silent gaps spanning days cannot
be reconstructed from time-only lines. Missing sources produce explicit gaps
and an `INCOMPLETE` bundle with exit 2. A failed phase writes `failure.json` and
exits 1. No partial run supplies timing evidence. The caller still owns browser
SIGINT/cleanup after either result.

Other lanes add small JSON journey files with `id`, `intent`, `prepare` and
`steps`. Operations are `open` (optional path), `home`, `idle` (milliseconds),
`browser` (non-secret agent-browser argument array) and `restore`. `when` selects
`cold` or `warm`. Pass `--journey=PATH` for an external definition. Use real
control clicks and test IDs; keep mutation authority with the lane's brief.

```sh
node apps/ui/scripts/perf/agentBrowserUiPerfAudit.mjs compare BEFORE_DIRECTORY AFTER_DIRECTORY
```

Comparison keeps journey, cold/warm, export/dev and capture-mode groups separate. Counts are
per-run means. Timing p50/p95 use nearest rank and require at least five complete
export timing-mode runs with both instruments observed OFF on each side;
otherwise they are unavailable. Legacy unspecified-mode bundles never qualify. Inspect captured host
load and gaps before treating any comparison as a performance result.
