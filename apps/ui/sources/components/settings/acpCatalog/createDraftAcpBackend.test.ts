import { describe, expect, it } from 'vitest';
import { applyAcpBackendUpsertV1 } from '@happier-dev/protocol/acp/catalog/catalogMutationsV1';

import { createDraftAcpBackend } from './createDraftAcpBackend';

describe('createDraftAcpBackend', () => {
    it('authors a command launch accepted by the current catalog writer', () => {
        const draft = createDraftAcpBackend(1);
        const args = ['  exact argument  ', ''];
        const result = applyAcpBackendUpsertV1({
            settings: { v: 2, backends: [] },
            backend: { ...draft, id: 'review', name: 'review', title: 'Review',
                launch: { kind: 'command', command: 'review-agent', args } },
            nowMs: 2,
        });
        expect(result).toMatchObject({ ok: true, backend: {
            launch: { kind: 'command', command: 'review-agent', args },
        } });
        if (!result.ok) throw new Error('The authoring draft must reach the canonical catalog writer');
        expect(result.backend).not.toHaveProperty('command');
        expect(result.backend).not.toHaveProperty('args');
    });
});
