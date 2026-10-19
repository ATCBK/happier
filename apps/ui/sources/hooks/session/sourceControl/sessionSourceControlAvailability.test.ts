import { describe, expect, it } from 'vitest';

import { resolveSessionSourceControlAvailability } from './sessionSourceControlAvailability';

describe('resolveSessionSourceControlAvailability', () => {
    it('hides source control for a managed non-repository and restores it when the folder becomes a repository', () => {
        expect(resolveSessionSourceControlAvailability({ directoryKind: 'managed', isRepo: null })).toBe(false);
        expect(resolveSessionSourceControlAvailability({ directoryKind: 'managed', isRepo: false })).toBe(false);
        expect(resolveSessionSourceControlAvailability({ directoryKind: 'managed', isRepo: true })).toBe(true);
    });

    it('keeps source control available for ordinary path sessions', () => {
        expect(resolveSessionSourceControlAvailability({ directoryKind: 'path', isRepo: null })).toBe(true);
    });
});
