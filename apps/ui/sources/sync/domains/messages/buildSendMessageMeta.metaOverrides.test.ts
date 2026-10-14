import { describe, expect, it } from 'vitest';

import { buildSendMessageMeta } from './buildSendMessageMeta';
import { RawRecordSchema } from '@happier-dev/session-core/raw';

describe('buildSendMessageMeta metaOverrides', () => {
    it('preserves nested metaOverrides while adding Claude reasoningEffort from session override metadata', () => {
        const meta = buildSendMessageMeta({
            sentFrom: 'e2e',
            permissionMode: 'default',
            appendSystemPrompt: '',
            displayText: 'Review comments (1)',
            agentId: 'claude',
            settings: {},
            session: {
                id: 's1',
                metadataLayoutVersion: 0,
                metadata: {
                    machineId: 'claude-machine',
                    sessionConfigOptionOverridesV1: {
                        v: 1,
                        updatedAt: 12,
                        overrides: {
                            reasoning_effort: {
                                updatedAt: 12,
                                value: 'low',
                            },
                        },
                    },
                },
            },
            metaOverrides: {
                happier: {
                    kind: 'review_comments.v1',
                    payload: { sessionId: 's1', comments: [] },
                },
            },
        });

        expect(meta.happier?.kind).toBe('review_comments.v1');
        // Check the real declaration interpreter before the persisted RawRecord
        // projection, so a fixture/producer failure cannot impersonate codec RED.
        expect(meta.reasoningEffort).toBe('low');
        expect(meta.displayText).toBe('Review comments (1)');
        expect(meta.sentFrom).toBe('e2e');
        const record = RawRecordSchema.parse({
            role: 'user', content: { type: 'text', text: 'Review comments' }, meta,
        });
        expect(record.meta?.reasoningEffort).toBe('low');
    });
});
