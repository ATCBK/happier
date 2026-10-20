import { describe, expect, it } from 'vitest';
import { combineChangedFilesAttribution } from '@happier-dev/protocol/sessions/changes/mergeTurnChangeSets';
import type { TurnChangeSet } from '@happier-dev/protocol/sessions/changes/types';
import { selectLatestAttributedFileTurn } from './filePageAttribution';

describe('latest attributed File-page turn', () => {
    it('uses Protocol chronology rather than late evidence arrival, and refuses unknown authorship', () => {
        const turn = (turnId: string, seq: number, derivedAt: number): TurnChangeSet => ({
            sessionId: 's', turnId, seqRange: { startSeqInclusive: seq, endSeqInclusive: seq + 1 },
            status: 'completed', provider: 'agent', derivedAt,
            files: [{ filePath: 'src/a.ts', changeKind: 'modified', source: 'provider_tool', confidence: 'exact',
                provider: 'agent', oldText: 'a', newText: 'b' }],
        });
        const older = turn('older', 1, 100);
        const newer = turn('newer', 3, 20);
        const changeSet = combineChangedFilesAttribution({ sessionId: 's', turns: [newer, older], rolledBackTurnIds: [] });
        expect(selectLatestAttributedFileTurn(changeSet, 'src/a.ts')?.turnId).toBe('newer');
        expect(selectLatestAttributedFileTurn(changeSet, 'missing')).toBeNull();
        expect(selectLatestAttributedFileTurn({ ...changeSet, files: changeSet.files.map(file => ({ ...file,
            attribution: { confidence: 'unknown', reason: 'unavailable' },
        })) }, 'src/a.ts')).toBeNull();
    });
});
