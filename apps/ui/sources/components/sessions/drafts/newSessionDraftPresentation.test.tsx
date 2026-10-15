import { describe, expect, it } from 'vitest';
import { NewSessionDraftDocumentV2Schema } from '@happier-dev/protocol/drafts/sessionDraftsV2';

import type { NewSessionDraftProjection } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { resolveNewSessionDraftAgentId } from './newSessionDraftPresentation';

function draft(agentTarget: unknown): NewSessionDraftProjection {
    return {
        draftId: '00000000-0000-4000-8000-000000000014',
        document: NewSessionDraftDocumentV2Schema.parse({
            v: 2,
            composer: {
                text: { mutationId: '00000000-0000-4000-8000-000000000001', value: 'Review the project settings' },
                mentions: { mutationId: '00000000-0000-4000-8000-000000000002', value: [] },
                attachments: { mutationId: '00000000-0000-4000-8000-000000000003', value: [] },
            },
            target: {
                kind: 'newSession',
                authoring: agentTarget === undefined ? {} : {
                    agentTarget: { mutationId: '00000000-0000-4000-8000-000000000004', value: agentTarget },
                },
            },
            extensions: {},
        }),
        status: 'clean',
        conflict: null,
        createdAt: 0,
        updatedAt: 0,
        localSupplement: {},
    };
}

describe('new Session draft Agent presentation', () => {
    it('resolves an authored bundled Agent without crashing the Session list', () => {
        expect(resolveNewSessionDraftAgentId(draft({
            kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
        }))).toBe('claude');
    });

    it.each([undefined, null])('keeps a draft without an Agent unmarked (%s)', (target) => {
        expect(resolveNewSessionDraftAgentId(draft(target))).toBe('');
    });
});
