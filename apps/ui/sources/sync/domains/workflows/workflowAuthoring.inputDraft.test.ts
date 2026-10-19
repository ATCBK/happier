import { describe, expect, it } from 'vitest';
import { buildWorkflowRunStartInputs, projectWorkflowRunInputFields } from './workflowAuthoring';

describe('workflow run raw input drafts', () => {
    it('rejects a malformed typed Session value instead of treating all JSON as a Session choice', () => {
        const fields = projectWorkflowRunInputFields({
            inputs: [{ name: 'reviewSession', valueType: 'json', required: true,
                inputType: { hostType: 'session' }, defaultFrom: 'origin_session' }],
            values: { reviewSession: { sessionId: 'missing-home' } },
            originSession: { serverId: 'home', sessionId: 'origin' },
        });
        expect(fields[0].errorCode).toBe('invalid_input');
        expect(fields[0].blocking).toBe(true);
    });
    it('keeps a malformed explicit Session draft blocking rather than replacing it with the origin default', () => {
        const fields = projectWorkflowRunInputFields({
            inputs: [{ name: 'reviewSession', valueType: 'json', required: true,
                inputType: { hostType: 'session' }, defaultFrom: 'origin_session' }],
            values: {}, rawTextValues: { reviewSession: '{unfinished' },
            originSession: { serverId: 'home', sessionId: 'origin' },
        });
        expect(fields[0].errorCode).toBe('invalid_input');
        expect(fields[0].blocking).toBe(true);
        expect(buildWorkflowRunStartInputs(fields)).toBeUndefined();
    });
    it('rejects non-JSON numbers even when JSON.parse accepts their overflow', () => {
        const fields = projectWorkflowRunInputFields({
            inputs: [{ name: 'config', valueType: 'json', required: true }],
            values: {}, rawTextValues: { config: '{"count":1e400}' },
        });
        expect(fields[0].blocking).toBe(true);
    });
    it('refuses malformed JSON without treating the raw buffer as a JSON string', () => {
        const fields = projectWorkflowRunInputFields({
            inputs: [{ name: 'config', valueType: 'json', required: true }],
            values: { config: { previous: true } },
            rawTextValues: { config: '{unfinished' },
        });
        expect(fields[0].errorCode).toBe('invalid_input');
        expect(fields[0].blocking).toBe(true);
    });
    it('parses valid raw JSON and keeps a seeded semantic string distinct from a raw buffer', () => {
        const inputs = [{ name: 'config', valueType: 'json' as const, required: true }];
        expect(buildWorkflowRunStartInputs(projectWorkflowRunInputFields({
            inputs, values: {}, rawTextValues: { config: '{"enabled":true}' },
        }))).toEqual({ config: { enabled: true } });
        expect(buildWorkflowRunStartInputs(projectWorkflowRunInputFields({
            inputs, values: { config: 'a semantic JSON string' },
        }))).toEqual({ config: 'a semantic JSON string' });
    });
    it('refuses an intermediate number rather than submitting its previously valid value', () => {
        const fields = projectWorkflowRunInputFields({
            inputs: [{ name: 'version', valueType: 'number', required: true }],
            values: { version: 1 }, rawTextValues: { version: '1e' },
        });
        expect(fields[0].blocking).toBe(true);
    });
});
