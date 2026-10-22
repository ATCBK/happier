import * as React from 'react';

import { createChangedFilesReviewDiffStateSource } from '@/components/workspaces/scm/review/ChangedFilesReviewDiffStore';
import {
  useChangedFilesReviewFind,
  type ChangedFilesReviewFindModel,
  type ReviewFindTarget,
} from '@/components/workspaces/scm/review/useChangedFilesReviewFind';

import type { WalkthroughReading } from './walkthroughReading';

/**
 * Find across a walkthrough's captured code, through the Files review's Find owner. Each place the reading
 * shows code is one Find key: a stop's hunks of one file, or a file's hunks left outside every stop. Keys keep
 * reading order, so stepping walks the stops and then the other changes.
 */
const SEPARATOR = '\u0000';
export function walkthroughStopFindKey(stopId: string, path: string): string {
  return `stop${SEPARATOR}${stopId}${SEPARATOR}${path}`;
}
export function walkthroughOtherFindKey(path: string): string {
  return `other${SEPARATOR}${path}`;
}
export function isWalkthroughOtherFindKey(key: string): boolean { return key.startsWith(`other${SEPARATOR}`); }
function filePathOf(key: string): string {
  return key.slice(key.lastIndexOf(SEPARATOR) + 1);
}

type Connection = Parameters<ChangedFilesReviewFindModel['connect']>[0];

function walkthroughFindInput(
  reading: WalkthroughReading,
  reveal: (target: ReviewFindTarget | null) => void,
): Connection {
  const source = createChangedFilesReviewDiffStateSource();
  const keys: string[] = [];
  const add = (key: string, diff: string, unavailableReason: string | null) => {
    keys.push(key);
    // Captured evidence is already here; code the reading cannot show counts against Find's coverage.
    source.setDiffState(
      key,
      diff
        ? { status: 'loaded', diff, error: null }
        : {
            status: 'error',
            diff: '',
            error: unavailableReason ?? 'unavailable',
          },
    );
  };
  for (const stop of reading.stops)
    for (const file of stop.files)
      add(
        walkthroughStopFindKey(stop.id, file.path),
        file.unifiedDiff,
        file.unavailableReason,
      );
  for (const other of reading.others)
    add(
      walkthroughOtherFindKey(other.path),
      other.unifiedDiff,
      other.unavailableReason,
    );
  return { paths: keys, diffStateSource: source, reveal, filePathOf };
}

/** Connects the canonical review Find model to one reading (tests and the view use the same projection). */
export function connectWalkthroughFind(
  model: ChangedFilesReviewFindModel,
  reading: WalkthroughReading,
  reveal: (target: ReviewFindTarget | null) => void,
): () => void {
  return model.connect(walkthroughFindInput(reading, reveal));
}

export function useWalkthroughFind(
  reading: WalkthroughReading,
  reveal: (target: ReviewFindTarget | null) => void,
): ChangedFilesReviewFindModel {
  const input = React.useMemo(
    () => walkthroughFindInput(reading, reveal),
    [reading.stops, reading.others, reveal],
  );
  return useChangedFilesReviewFind(input);
}
