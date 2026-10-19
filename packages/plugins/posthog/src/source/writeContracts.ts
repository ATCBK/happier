import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import {
    TriageConfiguredSourceConnectedAccountInstanceV1Schema,
    TriageSourceEntryLocalRefV1Schema,
} from '@happier-dev/triage-protocol/v1';

const target = {
    v: defineProtocolLiteral(1),
    instance: TriageConfiguredSourceConnectedAccountInstanceV1Schema,
    localRef: TriageSourceEntryLocalRefV1Schema,
};
export const PosthogIssueWriteInputV1Schema = defineProtocolObject(target, { policy: 'closed' });
export const PosthogIssueAssignInputV1Schema = defineProtocolObject({
    ...target,
    assignee: defineProtocolUnion([
        defineProtocolObject({ type: defineProtocolLiteral('user'), id: defineProtocolNumber({ integer: true, minimum: 1 }) }, { policy: 'closed' }),
        defineProtocolObject({ type: defineProtocolLiteral('role'), id: defineProtocolString({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }) }, { policy: 'closed' }),
    ]),
}, { policy: 'closed' });
