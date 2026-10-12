import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  createProtocolStoredReadSchema, defineProtocolArray, defineProtocolJsonValue,
  defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

const text = defineProtocolString({ minLength: 1 });
const transport = defineProtocolObject({ pluginId: text, contributionId: text }, { policy: 'closed' });
const configurationFields = {
  mailbox: text,
  trustStrategy: defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('exchangeOrganization'), authSource: text }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('authenticationResults'), authservId: text }, { policy: 'closed' }),
  ]),
  allowedDomains: defineProtocolArray(text).optional(),
  quotedHistory: defineProtocolUnion([
    defineProtocolLiteral('stripKnown'), defineProtocolLiteral('always'), defineProtocolLiteral('never'),
  ]).optional(),
  stripSignatures: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]).optional(),
  bodyFormat: defineProtocolUnion([defineProtocolLiteral('markdown'), defineProtocolLiteral('text')]).optional(),
};

export const EMAIL_SETUP_INPUT_SCHEMA = defineProtocolObject({
  ...configurationFields,
  transport: transport.optional(),
  transportConfig: defineProtocolJsonValue().optional(),
  credentialRef: QualifiedConnectedAccountRefSchema,
}, { policy: 'closed' });

export const EMAIL_CONFIG_SCHEMA = defineProtocolObject({
  ...configurationFields, transport, transportConfig: defineProtocolJsonValue(),
}, { policy: 'closed' });
export const EMAIL_STORED_CONFIG_SCHEMA = createProtocolStoredReadSchema(EMAIL_CONFIG_SCHEMA);
export type EmailConfig = ReturnType<typeof EMAIL_CONFIG_SCHEMA.parse>;
