import { defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { TriageSourceConnectedAccountBindingV1Schema, TriageSourceInstanceConfigurationV1Schema, TriageSourceFailureV1Schema } from '@happier-dev/triage-protocol/v1';

const id = defineProtocolString({ minLength: 1, pattern: '^\\d+$' });
const text = defineProtocolString({ minLength: 1 });
export const JiraConfigurationSchema = defineProtocolObject({
    v: defineProtocolLiteral(1), projectId: id,
    involvement: defineProtocolUnion([defineProtocolLiteral('mine'), defineProtocolLiteral('assignee'),
        defineProtocolLiteral('author'), defineProtocolLiteral('subscribed'), defineProtocolLiteral('all')]),
    issueTypeId: id.optional(),
}, { policy: 'closed' });
export type JiraConfiguration = ReturnType<typeof JiraConfigurationSchema.parse>;

// The shared editor owns draft lifecycle; this Action reads only provider choices.
export const JiraIssueTypesInputSchema = defineProtocolObject({ binding: TriageSourceConnectedAccountBindingV1Schema,
    localInstanceKey: text, configuration: TriageSourceInstanceConfigurationV1Schema,
}, { policy: 'closed' });
export const JiraIssueTypesResultSchema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('complete'),
        issueTypes: defineProtocolArray(defineProtocolObject({ id, name: text }, { policy: 'closed' })),
    }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('failed'), failure: TriageSourceFailureV1Schema }, { policy: 'closed' }),
]);
export type JiraIssueTypesResult = ReturnType<typeof JiraIssueTypesResultSchema.parse>;
