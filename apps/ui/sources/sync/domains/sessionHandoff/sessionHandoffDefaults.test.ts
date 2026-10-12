import { describe, expect, it } from 'vitest';
import { normalizeSessionHandoffDefaults } from './sessionHandoffDefaults';

describe('stored handoff defaults', () => {
    it('retains saved choices while discarding retired source material', () => {
        expect(normalizeSessionHandoffDefaults({ v: 1, workspaceSyncMode: 'copy_once', includeIgnoredMode: 'exclude',
            ignoredIncludeGlobs: [], directTargetMode: 'keep_direct', retiredSource: { sourcePath: '/retired/path' },
        })).toEqual({ v: 1, workspaceSyncMode: 'copy_once', includeIgnoredMode: 'exclude',
            ignoredIncludeGlobs: [], directTargetMode: 'keep_direct' });
    });
});
