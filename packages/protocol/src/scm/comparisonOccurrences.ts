import { buildScmComparisonSourceKey, type ScmChangeOccurrence, type ScmComparison, type ScmComparisonFile, type ScmComparisonSource } from './comparison.js';
import { formatHunk, parseUnifiedDiffHunks, type Hunk } from '../diff/hunks.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export type LocatedOccurrence = Readonly<{ file: ScmComparisonFile; occurrence: ScmChangeOccurrence; hunkIndex: number | null }>;
export type ComparisonOccurrences = Readonly<{
  located: ReadonlyMap<string, LocatedOccurrence>;
  hunksByPath: ReadonlyMap<string, readonly string[]>;
}>;
export function isMetadataOccurrence(occurrence: ScmChangeOccurrence): boolean {
  return occurrence.before.startLine === 0 && occurrence.before.lineCount === 0
    && occurrence.after.startLine === 0 && occurrence.after.lineCount === 0;
}
export const REVIEW_UNIT_GRANULARITY = 'run' as const;
export type ReviewUnit = Readonly<{ hunkIndex: number; runIndex: number; key: string; hunk: Hunk }>;
function contentHash(value: unknown): string { return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value)))); }

/** Change content excludes context and coordinates; duplicate ordinals are local to the file/layer. */
export function buildReviewUnits(path: string, layer: ScmChangeOccurrence['layer'] | null | undefined, unifiedDiff: string): readonly ReviewUnit[] {
  const duplicates = new Map<string, number>();
  return parseUnifiedDiffHunks(unifiedDiff).flatMap(hunk => {
    const runs: { start: number; end: number }[] = [];
    for (let index = 0; index < hunk.lines.length;) {
      if (hunk.lines[index]!.kind === 'context') { index += 1; continue; }
      const start = index;
      while (index < hunk.lines.length && hunk.lines[index]!.kind !== 'context') index += 1;
      runs.push({ start, end: index });
    }
    let cursor = 0;
    let oldOffset = hunk.oldLines ? hunk.oldStart - 1 : hunk.oldStart;
    let newOffset = hunk.newLines ? hunk.newStart - 1 : hunk.newStart;
    return runs.map((run, runIndex) => {
      const changed = hunk.lines.slice(run.start, run.end);
      // A final LF is changed content too; a newline-only edit must invalidate Keep.
      const descriptor = [path, layer ?? 'combined', changed.filter(line => line.kind === 'remove').map(line => line.text + (line.noEol ? '' : '\n')),
        changed.filter(line => line.kind === 'add').map(line => line.text + (line.noEol ? '' : '\n'))];
      const identity = JSON.stringify(descriptor);
      const ordinal = duplicates.get(identity) ?? 0;
      duplicates.set(identity, ordinal + 1);
      // Share the anchoring responsibility, not the line spans. This makes selecting two runs
      // compatible with the engine's all-or-none overlap refusal.
      const start = runIndex === 0 ? 0 : Math.ceil((runs[runIndex - 1]!.end + run.start) / 2);
      const end = runIndex + 1 === runs.length ? hunk.lines.length : Math.ceil((run.end + runs[runIndex + 1]!.start) / 2);
      for (; cursor < start; cursor++) {
        const line = hunk.lines[cursor]!;
        if (line.kind !== 'add') oldOffset++;
        if (line.kind !== 'remove') newOffset++;
      }
      const lines = hunk.lines.slice(start, end);
      const oldLines = lines.filter(line => line.kind !== 'add').length;
      const newLines = lines.filter(line => line.kind !== 'remove').length;
      const unit: Hunk = runs.length === 1 ? hunk : { ...hunk, oldStart: oldOffset + (oldLines ? 1 : 0),
        newStart: newOffset + (newLines ? 1 : 0), oldLines, newLines,
        lines, firstChange: run.start - start, lastChange: run.end - start - 1 };
      return { hunkIndex: hunk.index, runIndex, key: contentHash([...descriptor, ordinal]), hunk: unit };
    });
  });
}

// Captured comparisons are immutable evidence; stops/rows and Account echoes reuse this table.
const comparisonChangeKeys = new WeakMap<ScmComparison, ReadonlyMap<string, readonly string[]>>();
/** Captured layers share one displayed file; preserve its global hunk ordinals and per-layer keys. */
export function buildScmFileReviewUnits(file: ScmComparisonFile): readonly ReviewUnit[] {
  const byLayer = new Map<ScmChangeOccurrence['layer'], { hunk: Hunk; globalIndex: number }[]>();
  const hunks = parseUnifiedDiffHunks(file.evidence.unifiedDiff ?? '');
  let position = 0;
  for (const occurrence of file.occurrences) {
    if (isMetadataOccurrence(occurrence)) continue;
    const globalIndex = position++;
    const hunk = hunks[globalIndex];
    if (!hunk) continue;
    const group = byLayer.get(occurrence.layer) ?? [];
    group.push({ hunk, globalIndex });
    byLayer.set(occurrence.layer, group);
  }
  const units: ReviewUnit[] = [];
  for (const [layer, group] of byLayer) {
    for (const unit of buildReviewUnits(file.path, layer, group.map(({ hunk }) => formatHunk(hunk)).join('\n'))) {
      const hunkIndex = group[unit.hunkIndex]!.globalIndex;
      units.push({ ...unit, hunkIndex, hunk: { ...unit.hunk, index: hunkIndex } });
    }
  }
  return units.sort((a, b) => a.hunkIndex - b.hunkIndex || a.runIndex - b.runIndex);
}
/** Each captured occurrence is reviewed only when all its content runs are reviewed. */
export function buildScmChangeKeys(comparison: ScmComparison): ReadonlyMap<string, readonly string[]> {
  const previous = comparisonChangeKeys.get(comparison);
  if (previous) return previous;
  const keys = new Map<string, readonly string[]>();
  for (const file of comparison.inventory.files) {
    const byHunk = new Map<number, string[]>();
    for (const unit of buildScmFileReviewUnits(file)) {
      const selected = byHunk.get(unit.hunkIndex) ?? [];
      selected.push(unit.key);
      byHunk.set(unit.hunkIndex, selected);
    }
    let position = 0;
    for (const occurrence of file.occurrences) {
      if (isMetadataOccurrence(occurrence)) {
        keys.set(occurrence.id, [contentHash([file.path, file.previousPath ?? null, file.changeKind, 'metadata'])]);
        continue;
      }
      keys.set(occurrence.id, byHunk.get(position++) ?? []);
    }
  }
  comparisonChangeKeys.set(comparison, keys);
  return keys;
}

export function buildScmReviewScopeId(input: Readonly<{ repositoryRootPath: string; source: ScmComparisonSource }>): string {
  return contentHash([input.repositoryRootPath, buildScmComparisonSourceKey({ cwd: input.repositoryRootPath, source: input.source })]);
}
export function locateComparisonOccurrences(comparison: ScmComparison): ComparisonOccurrences {
  const located = new Map<string, LocatedOccurrence>();
  const hunksByPath = new Map<string, readonly string[]>();
  for (const file of comparison.inventory.files) {
    const hunks = parseUnifiedDiffHunks(file.evidence.unifiedDiff ?? '').map((hunk) => formatHunk(hunk).replace(/\n$/, ''));
    hunksByPath.set(file.path, hunks);
    let hunkIndex = 0;
    for (const occurrence of file.occurrences) {
      const textual = !isMetadataOccurrence(occurrence) && hunkIndex < hunks.length;
      located.set(occurrence.id, { file, occurrence, hunkIndex: textual ? hunkIndex : null });
      if (textual) hunkIndex++;
    }
  }
  return { located, hunksByPath };
}
