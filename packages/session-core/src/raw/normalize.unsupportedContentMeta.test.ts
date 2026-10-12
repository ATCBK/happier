import { describe, expect, it } from 'vitest';
import { readReleasedOutputNonTranscriptRecordTypes } from '@happier-dev/agents';

import { normalizeRawMessage } from "./normalize.js";
import { readUnsupportedContentMeta } from "../messages/unsupportedContentMeta.js";

describe('normalizeRawMessage unsupported-content meta marking', () => {
    it('hides released output bookkeeping declared by the generated agent definitions', () => {
        // cli-v0.2.11@98ea8fb wraps the entire Claude JSONL body in this output envelope.
        expect(readReleasedOutputNonTranscriptRecordTypes().has('queue-operation')).toBe(true);
        expect(normalizeRawMessage('released-queue', null, 1000, {
            role: 'agent', content: { type: 'output', data: { type: 'queue-operation' } },
        })).toBeNull();
    });
    it('marks a Zod parse failure for a user record as unparsed-user-message', () => {
        const raw = {
            role: 'user',
            // `content.type` outside the known 'output' | 'event' | 'codex' | 'acp' union fails schema validation.
            content: { type: 'totally-unknown-content-type' },
        };

        const normalized = normalizeRawMessage('msg-1', null, 1000, raw);
        expect(normalized).not.toBeNull();
        if (!normalized) return;
        expect(normalized.role).toBe('user');
        expect(readUnsupportedContentMeta(normalized.meta)).toBe('unparsed-user-message');
    });

    it('quietly skips a future agent content envelope', () => {
        const raw = {
            role: 'agent',
            content: { type: 'totally-unknown-content-type' },
        };

        const normalized = normalizeRawMessage('msg-2', null, 1000, raw);
        expect(normalized).toBeNull();
    });

    it('quietly skips a future top-level agent event kind', () => {
        expect(normalizeRawMessage('future-event', null, 1000, {
            role: 'agent', content: { type: 'event', id: 'future-event', data: { type: 'future-event', value: 'opaque' } },
        })).toBeNull();
    });

    it.each([
        { type: 'event', id: 'broken-event', data: { type: 'worker-update' } },
        { type: 'acp', agentId: 'claude', data: { type: 'event', id: 'broken-event', data: { type: 'worker-update' } } },
        { type: 'event', id: 'broken-event', data: {} },
        { type: 'acp', data: { type: 'message', message: 'answer' } },
    ])('keeps malformed known agent records visible: %j', (content) => {
        const normalized = normalizeRawMessage('broken', null, 1000, { role: 'agent', content });
        expect(normalized?.role).toBe('agent');
        expect(readUnsupportedContentMeta(normalized?.meta)).toBe('unparsed-agent-message');
    });

    it('keeps malformed known user text visible', () => {
        const normalized = normalizeRawMessage('broken-user', null, 1000, { role: 'user', content: { type: 'text' } });
        expect(normalized?.role).toBe('user');
        expect(readUnsupportedContentMeta(normalized?.meta)).toBe('unparsed-user-message');
    });

    it('quietly skips an unrecognized output payload', () => {
        const raw = {
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'some_future_output_type' },
            },
        };

        const normalized = normalizeRawMessage('msg-3', null, 1000, raw);
        expect(normalized).toBeNull();
    });

    it('quietly skips an unrecognized ACP data payload', () => {
        const raw = {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'some-provider',
                // `agentId` is required by this repo's ACP envelope. Without it the record fails the
                // shared schema and is marked `unparsed-agent-message` before the ACP branch runs,
                // so the fixture would assert the wrong contract.
                agentId: 'agent-1',
                data: { type: 'some_future_acp_type' },
            },
        };

        const normalized = normalizeRawMessage('msg-4', null, 1000, raw);
        expect(normalized).toBeNull();
    });

    it('reads committed host WorkerUpdates in the canonical ACP event carrier', () => {
        // The runtime commitRuntimeSessionEvent -> prepareCommittedAgentMessageViaPort path.
        const update = { v: 1, workerKind: 'session', workerId: 'worker', ownerState: 'settled',
            wake: 'finished', headline: 'Payment smoke tests', result: 'Verified retry behavior', canInspect: true };
        const normalized = normalizeRawMessage('host-update', 'wake-1', 1000, {
            role: 'agent', content: { type: 'acp', agentId: 'claude',
                data: { type: 'event', id: 'wake-1', data: { type: 'worker-update', update } } },
        }, { seq: 13, messageRole: 'event' });
        expect(normalized).toMatchObject({ role: 'event', id: 'host-update', localId: 'wake-1', seq: 13,
            content: { type: 'worker-update', update } });
    });

    it('reads known fields from host event history while silently skipping future event kinds', () => {
        const wrap = (data: unknown) => ({ role: 'agent', content: { type: 'acp', agentId: 'claude',
            data: { type: 'event', id: 'wake-1', data } } });
        expect(normalizeRawMessage('ready', null, 1000, wrap({ type: 'ready', futureField: true })))
            .toMatchObject({ role: 'event', content: { type: 'ready' } });
        expect(normalizeRawMessage('future', null, 1000, wrap({ type: 'future-event', value: 'opaque' }))).toBeNull();
    });
});
