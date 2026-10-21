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
multiple SQL statements). `db.transaction.*` phases are counted separately,
not added to those operation attempts; total DB phase records remain available.
Server spans correlate by diagnostic request ID.
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

Round-4 collector details:

- Failed steps finalize available CPU/network/React/store/socket evidence and
  write a `FAILED`, ineligible bundle plus the original phase in `failure.json`.
  Failed bundles enter neither comparison means nor percentiles. Disconnected
  sources are recorded, not replaced by zero counters.
- `cleanup.json` separates setup/cleanup CDP phase/kind failures from saved-window
  status. Raw browser errors remain suppressed. SIGINT keeps the observer alive
  through finalization. After failure/abort, cleanup reloads the owned page with
  a temporary timing override and records actual fresh-document OFF/OFF, or an
  explicit failure. Removing injection alone cannot turn an initialized store OFF.
- Periodic counts summaries use the existing emitter's `nativeLoggingHook`
  branch and one CDP binding: export Babel removes `console.info`. Console echoes
  are not counted. Every emitted delta is summed once, including identical
  deltas; the terminal flush is only the remainder and retains the end marker.
  No product telemetry change or new export is needed for this delivery repair.
- Network starts are bracket-filtered. Records retain safe Chromium failure
  codes/cancellation/blocking/CORS identifiers, actual returned request ID,
  request/send/header/response/completion times and TTFB. Pending-at-end requests
  stay pending there even if they complete during finalization. Observed bytes
  are separate from bytes completed within the window; no extra grace timeout
  is added. `observedThroughMs` is the observation cutoff, not capture end.
  Route classes exclude fixed `active`/`metadata-upgrades` Session paths from
  exact-row comparisons. Equal fingerprints do not prove equal authority/waste.
- Prefixed multiline server traces retain scalar `transactionClass`, status/code
  and SQLSTATE; Session IDs, error messages, parameters, SQL and nested bags stay
  excluded. Browser IDs join only equal returned server request IDs. Missing
  relay mappings are not invented from proximity or independent UUIDs.
- Server/daemon collection starts a continuous source-side `tail -F` observer
  before capture through the existing configured executor/control-stdin owner.
  It reuses the same safe parser as standalone snapshots and sends projected
  records only, never raw log lines. Closing the observer drains and confirms
  its owned tails before map loading. Large maps and slow remote command setup
  must not push log reads past the debug log's short rotation horizon. Process
  samples use this same observer channel. The existing Pino emitter timestamp
  takes precedence over the later Stack tee receipt timestamp.
- `--viewport=390x844` (or a declaration's `viewport` object) sets and verifies
  CSS dimensions before capture and after each step. Observations are recorded
  even without a declaration. A declaration's `readiness` describes its actual
  ready selector; the default Home selector means shell presence only. Journey
  lanes still own hydration, fixture and full-membership scroll assertions.
- `sameWindowProcessSamples` records interior endpoints after capture begins and
  before it ends; wider outer brackets remain separately labeled. Sampling adds
  automation overhead. Shared process samples include all clients, not per-lane
  CPU/RSS, peaks or allocated DB backends. Suppressed pings cannot establish
  poll rates; missing operation/constructor counts remain unavailable.
- Current bundles use schema 4. Comparisons keep schema versions separate as
  well as journey/cache/UI/instrumentation mode: legacy unbracketed requests,
  terminal-only telemetry and delayed rotating-log reads cannot be silently
  pooled with corrected captures. Fixed/exact Session route-class metrics are
  included in comparisons; a missing legacy metric stays unavailable.
- Clock mapping uses only coherent native `Network.requestWillBeSent`
  `wallTime`/`timestamp` pairs, including preparation traffic. There is no
  renderer `Date.now()` / `Performance.getMetrics` calibration: a queued renderer
  response is not a simultaneous sample. A request's start is its native wall
  time; its response/completion uses that request's own offset, so later pairs
  cannot shift its lifetime. Socket timestamps use the preceding native pair
  (the first pair for earlier frames), and are buffered until a pair is known.
  Missing pairs are explicit collection errors, never epoch-zero fallback.
  Network records retain original native wall/monotonic timestamps; bundle
  `clock.nativePairs` retains the raw numeric evidence and unmapped counts.
  Schema-2/3 clock-dependent membership/correlation is not certified and cannot
  generally be repaired: filtered-out starts and original native walls were not
  retained. Redo the cohort; do not pool it with schema 4. Controller shell
  durations and profile-wide CPU remain distinct from exact-window evidence.

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
