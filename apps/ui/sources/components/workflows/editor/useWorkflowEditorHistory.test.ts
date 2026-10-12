import { describe, expect, it } from 'vitest';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { createWorkflowDefinitionFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { buildWorkflowEditorDraftFromDefinition } from '@/sync/domains/workflows/workflowAuthoring';
import { workflowEditorSnapshotsEqual } from './useWorkflowEditorHistory';

function draftWithSchema(schema: PluginJsonSchemaV2) {
    return buildWorkflowEditorDraftFromDefinition({ draftId: 'schema-order', name: 'Gather changes',
        definition: createWorkflowDefinitionFixture({ blocks: [{ kind: 'step', id: 'gather',
            document: { text: 'Gather changes', references: [], attachments: [] }, input: [],
            result: { kind: 'json', schema } }] }) });
}

describe('workflow editor snapshot equality', () => {
    const beforeFields = { issues: { type: 'string' }, commits: { type: 'string' } } satisfies NonNullable<PluginJsonSchemaV2['properties']>;
    const afterFields = { commits: { type: 'string' }, issues: { type: 'string' } } satisfies NonNullable<PluginJsonSchemaV2['properties']>;

    it.each(['nested array', 'local reference', 'composition'] as const)('retains presentation-bearing order inside a %s schema', (kind) => {
        const schema = (properties: NonNullable<PluginJsonSchemaV2['properties']>): PluginJsonSchemaV2 => {
            const object: PluginJsonSchemaV2 = { type: 'object', properties };
            if (kind === 'nested array') return { type: 'object', properties: { rows: { type: 'array', items: object } } };
            if (kind === 'local reference') return { $ref: '#/$defs/row', $defs: { row: object } };
            return { anyOf: [object, { type: 'null' }] };
        };
        const before = draftWithSchema(schema(beforeFields));
        const after = draftWithSchema(schema(afterFields));
        expect(pluginJsonValuesEqual(before, after)).toBe(true);
        expect(workflowEditorSnapshotsEqual(before, after)).toBe(false);
        expect(workflowEditorSnapshotsEqual({ draft: before }, { draft: after })).toBe(false);
    });

    it('keeps schema keyword order and literal JSON defaults semantic', () => {
        const before = draftWithSchema({ type: 'object', properties: beforeFields,
            default: { properties: { issues: 'one', commits: 'two' } } });
        const after = draftWithSchema({ default: { properties: { commits: 'two', issues: 'one' } },
            properties: beforeFields, type: 'object' });
        expect(workflowEditorSnapshotsEqual(before, after)).toBe(true);
        expect(workflowEditorSnapshotsEqual(before, null)).toBe(false);
        expect(workflowEditorSnapshotsEqual(null, null)).toBe(true);
    });
});
