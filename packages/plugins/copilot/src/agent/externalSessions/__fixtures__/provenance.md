# Copilot event schema v1

`copilot-v1-events.jsonl` is a sanitized characterization vector from GitHub's
own event declarations at `github/copilot-sdk@374b77380700e550a39847445656369412f4005f`,
`nodejs/src/generated/session-events.ts` (StartData.version, UserMessageData.content,
AssistantMessageData.content, ToolExecutionCompleteResult.detailedContent).
The CLI artifact examined is `@github/copilot-linux-x64@1.0.100`; its binary
was downloaded but not executed. The vector is not a native 1.0.100 capture.

The retained root user/assistant envelope also matches the sanitized captured
prompt-mode fixture in `rimio-ai/rimz@897b1e367f3f954bba6e197b2392b1e82f3c327a`,
`crates/rimz/src/agents/adapters/copilot/tests/fixtures/events.jsonl` and its
README (1.0.70/1.0.71 capture provenance). IDs, timestamps, paths, prompts and
replies here are synthetic replacements. Delta/tool/compaction/resume cases
come from the pinned official schema rather than claiming native capture.

The decoder accepts only event format version 1. Compaction is a context change;
the visible historical timeline remains. Snapshot rewind is ephemeral in the
official schema and persisted rewinds rewrite the source; prefix verification
invalidates prior readers instead of appending abandoned content.

Release check: an installed Copilot CLI creates an ordinary local Session,
then direct search → Open/Find, compaction/resume, append and native indexing
removal are exercised without export or starting a turn merely to read.
