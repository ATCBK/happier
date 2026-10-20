import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '../sessions/messages/sessionStoredMessageContent.js';
import { ResourceRecipientKeyEnvelopesV1Schema } from '../teams/resourceGrantAccessV1.js';
import { DiscussionAccessRecipientCensusResponseV1Schema } from './access.js';
import { DiscussionIdSchema } from './content.js';

const Content = StrictSessionStoredMessageContentEnvelopeSchema;
const Message = lazyZodSchema(() => z.strictObject({ id: z.string().check(z.minLength(1)), content: Content }));
export const DiscussionAccountEncryptionInventoryV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(z.strictObject({
    discussionId: DiscussionIdSchema,
    titleContent: Content,
    dataEncryptionKey: z.string().check(z.minLength(1)),
    messages: z.array(Message),
    recipients: DiscussionAccessRecipientCensusResponseV1Schema,
  })),
}));
export type DiscussionAccountEncryptionInventoryV1 = z.infer<typeof DiscussionAccountEncryptionInventoryV1Schema>;

/** Complete source/target census shares the incumbent signed atomic request. */
export const AccountEncryptionMigrateDiscussionsDirectiveV1Schema = lazyZodSchema(() => z.strictObject({
  items: z.array(z.strictObject({
    discussionId: DiscussionIdSchema,
    expectedDataEncryptionKey: z.string().check(z.minLength(1)),
    dataEncryptionKey: z.string().check(z.minLength(1)),
    expectedTitleContent: Content,
    titleContent: Content,
    messages: z.array(z.strictObject({ id: z.string().check(z.minLength(1)), expectedContent: Content, content: Content })),
    recipientKeyEnvelopes: ResourceRecipientKeyEnvelopesV1Schema,
  })),
}));
export type AccountEncryptionMigrateDiscussionsDirectiveV1 = z.infer<typeof AccountEncryptionMigrateDiscussionsDirectiveV1Schema>;
