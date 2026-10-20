import type { SessionChangeSet, TurnChangeSet } from '@happier-dev/protocol/sessions/changes/types';
import { compareTurnChangeSetChronology } from '@happier-dev/protocol/sessions/changes/mergeTurnChangeSets';

/** Use Protocol's reconciled attribution and chronology, never transcript arrival order. */
export function selectLatestAttributedFileTurn(changeSet: SessionChangeSet | null, filePath: string): TurnChangeSet | null {
    const file = changeSet?.files.find(file => file.filePath === filePath);
    if (!changeSet || !file || file.attribution.confidence === 'unknown') return null;
    const turnIds = new Set(file.turns);
    return changeSet.turns.reduce<TurnChangeSet | null>((latest, turn) =>
        !turnIds.has(turn.turnId) || (latest && compareTurnChangeSetChronology(latest, turn) > 0) ? latest : turn, null);
}
