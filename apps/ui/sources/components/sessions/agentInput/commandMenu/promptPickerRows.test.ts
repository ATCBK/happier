import { describe, expect, it } from 'vitest';
import type { PromptInvocationEntryV1 } from '@happier-dev/protocol/prompts/library/promptInvocationsV1';
import { buildPromptPickerRows } from './promptPickerRows';

describe('qualified prompt picker document association', () => {
    it('searches and names sent messages by readable labels while preserving the insertion source', () => {
        const text = 'Read [Auth](happier-ref:session:s1)';
        const input = { serverId: 'home', documents: [], invocations: [], builtIns: [],
            history: [{ serverId: 'home', sessionId: 's', messageId: 'm', seq: 1, createdAtMs: 1, text }], sessionId: 's', query: 'Auth' };
        const row = buildPromptPickerRows(input)[0]!;
        expect(row.title).toBe('Read Auth');
        expect(row.kind === 'history' && row.entry.text).toBe(text);
        expect(buildPromptPickerRows({ ...input, query: 'happier-ref' })).toEqual([]);
    });

    it('does not associate a foreign invocation with an identical current-Home Artifact id', () => {
        const invocations: PromptInvocationEntryV1[] = ['alpha', 'bravo'].map(serverId => ({ id: serverId, token: `/${serverId}`, title: serverId,
            target: { kind: 'doc', artifactId: 'same-id', serverId }, behavior: 'insert', allowArgs: false, availableIn: 'global' }));
        const input = { serverId: 'alpha', documents: [{ artifactId: 'same-id', title: 'Alpha document', tags: [], favorite: false, folderId: null, updatedAtMs: 1 }],
            invocations, builtIns: [], history: [], sessionId: null, query: '' };
        const rows = buildPromptPickerRows(input);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.tokens).toEqual(['/alpha']);
        expect(buildPromptPickerRows({ ...input, query: '/bravo' })).toEqual([]);
    });
});
