import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { createCanonicalJsonSigningInput, defineComposerAttachment } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolNumber, defineProtocolString, defineProtocolUnion, defineProtocolLiteral } from '@happier-dev/plugin-sdk/protocol';
import type { SessionSendAttachment } from '@happier-dev/plugin-sdk/sessions';
import { ConversationMessageAttachmentV1Schema, type ConversationObservationV1 } from '@happier-dev/channels-protocol/v1';

/** Portable value contract shared by the declaration and daemon resolver. */
export const ChannelFileValueV1Schema = defineProtocolObject({
  connectionId: defineProtocolString({ minLength: 1 }),
  connectionAuthorityEpoch: defineProtocolNumber({ integer: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  messageId: defineProtocolString({ minLength: 1 }),
  descriptor: ConversationMessageAttachmentV1Schema,
  contentProvenance: defineProtocolUnion([defineProtocolLiteral('original'), defineProtocolLiteral('forwarded'), defineProtocolLiteral('viaBot')]),
}, { policy: 'closed' });
export type ChannelFileValueV1 = ReturnType<typeof ChannelFileValueV1Schema.parse>;

/** Descriptors only: the existing Session input identity owns admission and replay. */
export function channelFileSessionAttachments(input: Readonly<{
  connectionId: string;
  connectionAuthorityEpoch: number;
  observation: ConversationObservationV1;
}>): SessionSendAttachment[] {
  return (input.observation.message.attachments ?? []).map(descriptor => ({
    attachmentLocalId: 'channel-file',
    value: {
      key: bytesToHex(sha256(utf8ToBytes(createCanonicalJsonSigningInput({
        connectionId: input.connectionId, messageId: input.observation.message.id, attachmentId: descriptor.attachmentId,
      })))),
      value: {
        connectionId: input.connectionId,
        connectionAuthorityEpoch: input.connectionAuthorityEpoch,
        messageId: input.observation.message.id,
        descriptor,
        contentProvenance: input.observation.message.contentProvenance,
      },
      // The complete filename stays in the descriptor. The host presentation
      // has its own bounded label contract, independent of provider filenames.
      presentation: { label: 'Channel file', icon: 'file' },
    },
  }));
}

/** The executable plugin owner attaches the daemon runtime before projection. */
export const CHANNEL_FILE_ATTACHMENT = defineComposerAttachment({
  title: 'Channel file', icon: 'file', cardinality: 'many', display: { kind: 'badge' },
  value: ChannelFileValueV1Schema,
});
