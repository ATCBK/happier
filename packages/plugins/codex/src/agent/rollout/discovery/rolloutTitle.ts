import { isChangeTitleToolNameAlias } from '@happier-dev/plugin-sdk/sessions';
import { isPluginError, isRecord } from '@happier-dev/plugin-sdk';
import { readSessionInputPromptUserTextV1 } from '@happier-dev/plugin-sdk/sessions/external';
import { readJsonlFileForwardLines } from '@happier-dev/plugin-sdk/sessions/file-stores';

import {
  createCodexExternalSessionJsonlScannerFileSystem,
  throwIfCodexExternalSessionInvocationStopped,
  type CodexExternalSessionInvocationBounds,
} from '../../surfaces/sessions/external/invocationBounds.js';
import { mapCodexRolloutEventToActions } from '../projection/actions.js';
import { classifyCodexSessionThread, type CodexSessionThread } from './sessionThread.js';

const CODEX_TITLE_SCAN_CHUNK_MAX_BYTES = 128 * 1024;
const CODEX_TITLE_SCAN_CHUNK_MAX_ITEMS = 64;
const CODEX_TITLE_MAX_CHARS = 120;

/**
 * The largest single rollout record the reader will consider as a title.
 *
 * A session started through this harness opens with a preamble of very large
 * records — a `<recommended_plugins>` listing, a `# Session title` instruction
 * block, a world-state snapshot — measured at 49-89 KB each and ~395 KB in
 * total before the first genuine message. The reader rejects every one of them,
 * so charging their bytes to the budget spends it on records it was never going
 * to accept and stops the read short of the message it wants. A record this
 * large is a harness payload or a pasted dump, not a session title, so it is
 * traversed rather than considered: its bytes count against
 * `maxTraversedBytes` and never against `maxConsideredBytes`.
 */
const CODEX_TITLE_MAX_RECORD_BYTES = 32 * 1024;
const CODEX_TITLE_BOILERPLATE_PATTERNS = [
  '<environment_context>',
  '<instructions>',
  '<turn_aborted>',
  '# agents.md instructions',
] as const;

/**
 * How far into a rollout the single title reader may look. A session's title is
 * its first genuine message, so it is always near the head; the budget exists
 * only to bound the harness boilerplate a real rollout leads with.
 *
 * The two byte bounds are deliberately different quantities:
 * `maxConsideredBytes` is charged for the records the reader actually inspects
 * as a title, while `maxTraversedBytes` is the hard cost bound on the read and
 * covers everything in the way, including oversized records skipped
 * unconsidered. Charging one budget for both is what made a harness preamble
 * able to starve the read of the message it was looking for.
 */
export type CodexRolloutTitleReadBudget = Readonly<{
  maxConsideredBytes: number;
  maxConsideredItems: number;
  maxTraversedBytes: number;
}>;

/**
 * The selected-row budget: one bounded read for a candidate the caller already
 * decided to return.
 */
export const CODEX_ROLLOUT_TITLE_FULL_BUDGET: CodexRolloutTitleReadBudget = {
  maxConsideredBytes: 1024 * 1024,
  maxConsideredItems: 512,
  maxTraversedBytes: 4 * 1024 * 1024,
};

/**
 * The scan budget: one bounded head read. The bounded corpus scan performs this
 * for every row it returns, so its per-row cost has to stay a head read rather
 * than a walk toward the middle of a long transcript.
 *
 * Worst case for one row: 512 KB traversed, of which at most 128 KB across at
 * most 64 records is considered. A rollout whose first genuine message is past
 * that head — or whose head is a single record larger than the remaining
 * traversal budget — stays identifier-only rather than reading further.
 */
export const CODEX_ROLLOUT_TITLE_HEAD_BUDGET: CodexRolloutTitleReadBudget = {
  maxConsideredBytes: CODEX_TITLE_SCAN_CHUNK_MAX_BYTES,
  maxConsideredItems: CODEX_TITLE_SCAN_CHUNK_MAX_ITEMS,
  maxTraversedBytes: 512 * 1024,
};

/**
 * The single normalization rule for a Codex candidate title: collapse
 * whitespace, clamp length, and reject harness boilerplate rather than
 * presenting it as a session title.
 */
export function readCodexExternalSessionTitleCandidate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = readSessionInputPromptUserTextV1(value).replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const title = normalized.length <= CODEX_TITLE_MAX_CHARS
    ? normalized
    : normalized.slice(0, CODEX_TITLE_MAX_CHARS - 3).trimEnd() + '...';
  const lowerTitle = title.toLowerCase();
  if (CODEX_TITLE_BOILERPLATE_PATTERNS.some((pattern) => lowerTitle.includes(pattern))) {
    return null;
  }
  return title;
}

function readTitleFromCodexTitleToolInput(input: unknown): string | null {
  return readCodexExternalSessionTitleCandidate(isRecord(input) ? input.title : null);
}

export type CodexRolloutHead = Readonly<{
  title: string | null;
  cwd?: string;
  /** From line 1's `session_meta`, which this read traverses anyway. */
  thread: CodexSessionThread | null;
}>;

/**
 * The one Codex rollout title reader. Both the bounded corpus scan (which
 * carries the title on the row it emits) and the selected-candidate build use
 * it against the same earliest rollout file, so a row cannot change its title
 * by being served through a different route.
 */
export async function readCodexSessionTitleFromRollout(
  filePath: string,
  bounds: CodexExternalSessionInvocationBounds,
  budget: CodexRolloutTitleReadBudget = CODEX_ROLLOUT_TITLE_FULL_BUDGET,
): Promise<string | null> {
  return (await readCodexRolloutHead(filePath, bounds, budget)).title;
}

/**
 * The title read plus the thread classification of the rollout's first
 * record. The corpus scan performs this one head read per returned row, so
 * classifying there costs no additional file open.
 */
export async function readCodexRolloutHead(
  filePath: string,
  bounds: CodexExternalSessionInvocationBounds & Readonly<{ includeTitles?: boolean }>,
  budget: CodexRolloutTitleReadBudget = CODEX_ROLLOUT_TITLE_FULL_BUDGET,
): Promise<CodexRolloutHead> {
  let thread: CodexSessionThread | null = null;
  let cwd: string | undefined;
  let firstRecord = true;
  let fallbackUserText: string | null = null;
  let offsetBytes = 0;
  let traversedBytes = 0;
  let consideredBytes = 0;
  let consideredItems = 0;

  while (
    traversedBytes < budget.maxTraversedBytes
    && consideredBytes < budget.maxConsideredBytes
    && consideredItems < budget.maxConsideredItems
  ) {
    throwIfCodexExternalSessionInvocationStopped(bounds);
    const remainingTraversalBytes = budget.maxTraversedBytes - traversedBytes;
    const pageMaxBytes = Math.min(CODEX_TITLE_SCAN_CHUNK_MAX_BYTES, remainingTraversalBytes);
    const page = await readJsonlFileForwardLines({
      filePath,
      offsetBytes,
      maxBytes: pageMaxBytes,
      maxItems: bounds.includeTitles === false ? 1 : CODEX_TITLE_SCAN_CHUNK_MAX_ITEMS,
      // One native read per advisory page, through the shared scanner owner.
      chunkBytes: pageMaxBytes,
      // A single record may never cost more than what is left of the traversal
      // budget. Without this the scanner follows one multi-megabyte line for up
      // to its own 8 MB oversize allowance, which is the whole read's cost bound
      // escaping through one pathological record.
      maxOversizeLineBytes: remainingTraversalBytes,
      signal: bounds.signal,
      fileSystem: createCodexExternalSessionJsonlScannerFileSystem(bounds),
    }).catch((error: unknown) => {
      if (!isPluginError(error) || error.code !== 'JSONL_RECORD_TOO_LARGE') throw error;
      // This is advisory metadata, not a transcript completion claim.
      console.warn(`[codex] Rollout title scan stopped: ${error.message}`);
      return null;
    });
    throwIfCodexExternalSessionInvocationStopped(bounds);
    if (!page) break;

    for (const line of page.items) {
      throwIfCodexExternalSessionInvocationStopped(bounds);
      if (line.value === null) continue;
      if (firstRecord) {
        firstRecord = false;
        if (isRecord(line.value) && line.value.type === 'session_meta') {
          thread = classifyCodexSessionThread(line.value.payload);
          if (isRecord(line.value.payload) && typeof line.value.payload.cwd === 'string' && line.value.payload.cwd.trim()) cwd = line.value.payload.cwd;
        }
        // Index ingestion needs source classification, not a display title.
        // Keep the same decoder and native head budget for large metadata rows.
        if (bounds.includeTitles === false) return { title: null, thread, ...(cwd ? { cwd } : {}) };
      }
      if (
        consideredBytes >= budget.maxConsideredBytes
        || consideredItems >= budget.maxConsideredItems
      ) {
        break;
      }
      const recordBytes = line.endOffsetBytes - line.startOffsetBytes;
      // Traversed, not considered: see CODEX_TITLE_MAX_RECORD_BYTES.
      if (recordBytes > CODEX_TITLE_MAX_RECORD_BYTES) continue;
      consideredBytes += recordBytes;
      consideredItems += 1;
      for (const action of mapCodexRolloutEventToActions(line.value, { debug: false })) {
        if (action.type === 'tool-call' && isChangeTitleToolNameAlias(action.name)) {
          const title = readTitleFromCodexTitleToolInput(action.input);
          if (title) return { title, thread, ...(cwd ? { cwd } : {}) };
        }
        if (action.type === 'user-text' && fallbackUserText === null) {
          fallbackUserText = readCodexExternalSessionTitleCandidate(action.text);
        }
      }
    }

    if (page.reachedEnd || page.nextOffsetBytes <= offsetBytes) break;
    traversedBytes += Math.max(0, page.nextOffsetBytes - offsetBytes);
    offsetBytes = page.nextOffsetBytes;
  }

  return { title: fallbackUserText, thread, ...(cwd ? { cwd } : {}) };
}
