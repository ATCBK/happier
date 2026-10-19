import { describe, expect, it } from 'vitest';
import {
    TriageSourceEntrySnapshotV1Schema,
    TriageSourceDescriptorV1Schema,
    TriageSourcesContributionProtocolV1,
    TriageTaskCreateInputV1Schema, TriageTaskEditInputV1Schema, TriageTaskWriteResultV1Schema,
    triageTaskStatusCategoryV1,
} from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';

describe('public external Task source contract', () => {
    it('retains active stage and live relationship facts without another task identity', () => {
        const parent = { source: { pluginId: 'example.tracker', localId: 'source' }, kindId: 'issue', collisionScope: 'team', entryId: '1' };
        const snapshot = {
            v: 1, title: 'Implement parser', scopeLabel: 'Team', facts: [],
            state: { presentation: 'active', stage: 'started' },
            relations: { parent, blockedBy: [parent], children: { total: 2, completed: 1 } },
        };
        expect(TriageSourceEntrySnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
    });

    it('accepts a task kind declaring its source-native edits and transitions', () => {
        const descriptor = {
            v: 1, purpose: 'tracker', displayName: 'Tracker', kinds: [{
                id: 'issue', workflowSubject: 'issue', displayName: 'Issue', task: true,
                taskCapabilities: { editFields: ['title', 'body'], transitions: [{
                    id: 'begin', label: 'In progress', state: { presentation: 'active', stage: 'started' },
                }] },
            }],
        };
        expect(TriageSourceDescriptorV1Schema.parse(descriptor)).toEqual(descriptor);
    });

    it('admits optional writes through the same contribution contract as reads', () => {
        expect(Object.keys(TriageSourcesContributionProtocolV1.operations)).toEqual(expect.arrayContaining(['create', 'edit', 'transition']));
    });

    it('maps legacy and refined states through one pure category owner', () => {
        expect(triageTaskStatusCategoryV1({ presentation: 'active' })).toBe('unstarted');
        expect(triageTaskStatusCategoryV1({ presentation: 'active', stage: 'backlog' })).toBe('backlog');
        expect(triageTaskStatusCategoryV1({ presentation: 'active', stage: 'started' })).toBe('started');
        expect(triageTaskStatusCategoryV1({ presentation: 'resolved' })).toBe('completed');
        expect(triageTaskStatusCategoryV1({ presentation: 'closed', completionReason: 'canceled' })).toBe('canceled');
        expect(triageTaskStatusCategoryV1({ presentation: 'unknown', nativeLabel: 'New native state' })).toBeNull();
        expect(triageTaskStatusCategoryV1({ presentation: 'suppressed' })).toBeNull();
    });

    it('keeps write inputs/outcomes closed and accepts meaningful document bodies', () => {
        const fixture = createTriageSourceV1Fixture();
        const input = { v: 1, instance: fixture.configuredInstance, kindId: 'issue', fields: { title: 'Task', body: 'First line\n\nSecond line' } };
        expect(TriageTaskCreateInputV1Schema.parse(input)).toEqual(input);
        expect(TriageTaskCreateInputV1Schema.safeParse({ ...input, fields: { body: 'Missing title' } }).success).toBe(false);
        expect(TriageTaskCreateInputV1Schema.safeParse({ ...input, fields: { ...input.fields, command: 'unexpected' } }).success).toBe(false);
        expect(TriageTaskCreateInputV1Schema.safeParse({ ...input, retry: true }).success).toBe(false);
        const edit = { v: 1, instance: fixture.configuredInstance, localRef: fixture.getInput.localRef, fields: { body: '', assigneeIds: [], parent: null } };
        expect(TriageTaskEditInputV1Schema.parse(edit)).toEqual(edit);
        expect(TriageTaskWriteResultV1Schema.parse({ kind: 'uncertain' })).toEqual({ kind: 'uncertain' });
        expect(TriageTaskWriteResultV1Schema.safeParse({ kind: 'applied' }).success).toBe(false);
        expect(TriageTaskWriteResultV1Schema.safeParse({ kind: 'uncertain', retry: true }).success).toBe(false);
    });

    it('admits the full provider scope rather than applying an entity-id ceiling to a repository path', () => {
        const fixture = createTriageSourceV1Fixture();
        const scopeId = `${'o'.repeat(39)}/${'r'.repeat(100)}`;
        expect(TriageTaskCreateInputV1Schema.parse({
            v: 1, instance: fixture.configuredInstance, kindId: 'issue', fields: { title: 'Task', scopeId },
        }).fields.scopeId).toBe(scopeId);
    });

    it('carries declared dependency edits and provider-native priority ids without another mutation channel', () => {
        const fixture = createTriageSourceV1Fixture();
        const blockedBy = [{ source: fixture.configuredInstance.instance.source, ...fixture.getInput.localRef }];
        const fields = { blockedBy, priority: 'high-priority-id' };
        expect(TriageTaskEditInputV1Schema.parse({
            v: 1, instance: fixture.configuredInstance, localRef: fixture.getInput.localRef, fields,
        }).fields).toEqual(fields);
    });
});
