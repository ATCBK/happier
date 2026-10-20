import { defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { TriageGetResultV1Schema, TriageSourceFailureV1Schema } from '@happier-dev/triage-protocol/v1';

const text = defineProtocolString({});
export const JiraDetailResultSchema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('detail'), observation: TriageGetResultV1Schema,
        body: text, fields: defineProtocolArray(defineProtocolObject({ label: text, value: text }, { policy: 'closed' })),
    }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('failed'), failure: TriageSourceFailureV1Schema }, { policy: 'closed' }),
]);
export type JiraDetailResult = ReturnType<typeof JiraDetailResultSchema.parse>;
