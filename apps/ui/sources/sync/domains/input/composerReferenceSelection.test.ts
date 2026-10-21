import { describe, expect, it } from 'vitest';

import { buildComposerFileReferenceSelection, buildComposerSessionReferenceSelection } from './composerReferenceSelection';
import { buildStructuredInputMetaOverrides } from '@/components/sessions/agentInput/structuredInputMentions';

describe('composer reference selections', () => {
    it('writes identity-bearing inline tokens with the selected labels', () => {
        expect(buildComposerFileReferenceSelection('src/a.ts', 'a.ts')).toMatchObject({
            label: 'a.ts', ref: 'file:src/a.ts', token: '[a.ts](happier-ref:file:src/a.ts)',
        });
        expect(buildComposerSessionReferenceSelection({ id: 'session-1', title: 'Auth fix' })).toMatchObject({
            label: 'Auth fix', ref: 'session:session-1', token: '[Auth fix](happier-ref:session:session-1)',
        });
        const selection = buildComposerFileReferenceSelection('docs/read me%.md', 'read me%.md');
        const meta = buildStructuredInputMetaOverrides({ text: selection.token, mentions: [{ ...selection.payload,
            tokenText: selection.token, start: 0, end: selection.token.length }] });
        expect(meta).toMatchObject({ happierStructuredInputV1: { mentions: [expect.objectContaining({
            token: '[read me%.md](happier-ref:file:docs/read%20me%25.md)', ref: 'file:docs/read%20me%25.md',
        })] } });
    });
});
