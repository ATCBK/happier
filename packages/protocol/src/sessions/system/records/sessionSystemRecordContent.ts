import {
  StrictSessionStoredMessageContentEnvelopeSchema,
  type StrictSessionStoredMessageContentEnvelope,
} from '../../messages/sessionStoredMessageContent.js';

export const SessionSystemRecordContentSchema: typeof StrictSessionStoredMessageContentEnvelopeSchema = StrictSessionStoredMessageContentEnvelopeSchema;
export type SessionSystemRecordContent = StrictSessionStoredMessageContentEnvelope;
