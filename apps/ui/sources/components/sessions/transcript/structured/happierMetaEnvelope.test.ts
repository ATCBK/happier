import { describe, expect, it } from 'vitest';

import { parseHappierMetaEnvelope } from './happierMetaEnvelope';

describe('parseHappierMetaEnvelope', () => {
    it('returns null when meta does not contain a happier envelope', () => {
        expect(parseHappierMetaEnvelope(undefined)).toBeNull();
        expect(parseHappierMetaEnvelope({})).toBeNull();
        expect(parseHappierMetaEnvelope({ happier: null })).toBeNull();
    });

    it('accepts a payload-free internal marker through the shared envelope', () => {
        expect(parseHappierMetaEnvelope({ happier: { kind: 'claude_jsonl_consumed_marker.v1' } }))
            .toEqual({ kind: 'claude_jsonl_consumed_marker.v1' });
    });

    it('returns kind + payload when meta contains a valid envelope', () => {
        const parsed = parseHappierMetaEnvelope({
            happier: { kind: 'review_comments.v1', payload: { ok: true } },
        });
        expect(parsed).toEqual({ kind: 'review_comments.v1', payload: { ok: true } });
    });

    it('projects a built-in execution-run completion input into the structured renderer envelope', () => {
        const completion = {
            v: 1,
            runId: 'run_1',
            status: 'succeeded',
            finishedAtMs: 42,
            canInspect: true,
            summary: 'Done',
        };

        expect(parseHappierMetaEnvelope({
            happierStructuredInputV1: { v: 1, executionRunCompletion: completion },
        })).toEqual({ kind: 'execution_run_completion.v1', payload: completion });
    });

    it('does not fall back when an invalid primary envelope is explicitly present', () => {
        const meta = { happierStructuredInputV1: { executionRunCompletion: { runId: 'run-1' } } };
        for (const happier of [undefined, null, {}, { kind: 1 }, { kind: '', payload: {} }]) {
            expect(parseHappierMetaEnvelope({ ...meta, happier })).toBeNull();
        }
        expect(parseHappierMetaEnvelope(meta, 'custom')).toBeNull();
    });

    it('preserves optional qualified resource refs while accepting historical envelopes without them', () => {
        expect(parseHappierMetaEnvelope({
            happier: {
                kind: 'acme.preview/v1',
                payload: { ok: true },
                resources: ['preview-icon', { pluginId: 'acme.shared', localId: 'logo' }],
            },
        })).toEqual({
            kind: 'acme.preview/v1',
            payload: { ok: true },
            resources: ['preview-icon', { pluginId: 'acme.shared', localId: 'logo' }],
        });
        expect(parseHappierMetaEnvelope({
            happier: { kind: 'acme.preview/v1', payload: { ok: true } },
        })).toEqual({ kind: 'acme.preview/v1', payload: { ok: true } });
    });

    it('projects retained envelope identity fields without erasing its opaque payload', () => {
        const payload = { native: { arbitraryField: { retired: true } } };
        const resource = { pluginId: 'acme.shared', localId: 'logo' };
        const origin = { v: 1, channel: 'agent_thread', modality: 'text', source: { pluginId: 'acme.shared', contributionId: 'review' } };
        const happier = { kind: 'review_comments.v1', payload, resources: [{ ...resource, retired: true }],
            conversationTurnOriginV1: { ...origin, retired: true, source: { ...origin.source, retired: true } } };
        expect(parseHappierMetaEnvelope({ happier })).toEqual({
            kind: happier.kind, payload, resources: [resource], conversationTurnOriginV1: origin,
        });
        expect(parseHappierMetaEnvelope({ happier: { ...happier, conversationTurnOriginV1: {
            ...happier.conversationTurnOriginV1, modality: 'voice',
        } } })).toBeNull();
    });
});
