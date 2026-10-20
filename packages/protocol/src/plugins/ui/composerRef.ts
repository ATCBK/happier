import { ComposerInstanceIdProtocolSchema } from '../../runtime/input/composerInstanceId.js';
import { PendingLocalIdProtocolSchema } from '../../sessions/pending/pendingLocalId.js';
import { DiscussionIdSchema, SessionIdSchema } from '../../sessions/idsV1.js';
import { WorkflowBlockIdProtocolSchema } from '../../workflows/workflowBlockIdProtocol.js';
import {
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolUnion,
} from '../actions/protocolComposableSchema.js';

const ComposerOpaqueLiveInstanceIdV1Schema = ComposerInstanceIdProtocolSchema;

/**
 * One exact host-owned composer scope. The live instance arms are opaque
 * identities, never Session IDs or author-controlled routing fields.
 *
 * It is authored as a validator-neutral composable because a feature protocol
 * must be able to embed this exact scope in its own closed launch input and
 * publish the result as portable JSON Schema. The incumbent Zod parents in
 * `composer.ts` compose this same value through one `asProtocolZod` bridge;
 * there is one parser, not two.
 *
 * This grammar has its own leaf module — rather than living beside the rest of
 * the Composer protocol in `composer.ts` — because it is the only Composer
 * value projected onto the browser-safe public authoring surface
 * (`@happier-dev/plugin-sdk/protocol`). Publishing it from `composer.ts` would
 * pull that module's renderer, token, attachment, media, session-creation and
 * voice graph into every feature-protocol browser bundle.
 */
export const ComposerRefV1Schema = defineProtocolUnion([
  defineProtocolObject({
    kind: defineProtocolLiteral('session'),
    sessionId: SessionIdSchema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('discussion'),
    discussionId: DiscussionIdSchema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('newSession'),
    instanceId: ComposerOpaqueLiveInstanceIdV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('pendingMessage'),
    sessionId: SessionIdSchema,
    localId: PendingLocalIdProtocolSchema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('participantMessage'),
    sessionId: SessionIdSchema,
    instanceId: ComposerOpaqueLiveInstanceIdV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('automationAuthoring'),
    sessionId: SessionIdSchema,
    instanceId: ComposerOpaqueLiveInstanceIdV1Schema,
  }, { policy: 'closed' }),
  defineProtocolObject({
    kind: defineProtocolLiteral('workflowAuthoring'),
    draftId: ComposerOpaqueLiveInstanceIdV1Schema,
    blockId: WorkflowBlockIdProtocolSchema,
    instanceId: ComposerOpaqueLiveInstanceIdV1Schema,
  }, { policy: 'closed' }),
]);
type DeepReadonly<T> = T extends readonly (infer TItem)[]
  ? readonly DeepReadonly<TItem>[]
  : T extends object
    ? { readonly [TKey in keyof T]: DeepReadonly<T[TKey]> }
    : T;

export type ComposerRefV1 = DeepReadonly<ReturnType<typeof ComposerRefV1Schema.parse>>;

/** Host-private transcript-admission metadata key for exact detached Composer source custody. */
export const COMPOSER_SOURCE_REF_PRIVATE_META_FIELD_V1 = '__happierComposerSourceRefV1';

/** Stable internal presentation/storage key for one exact Composer address. */
export function composerRefV1Key(ref: ComposerRefV1): string {
  switch (ref.kind) {
    case 'session':
      return JSON.stringify([ref.kind, ref.sessionId]);
    case 'discussion':
      return JSON.stringify([ref.kind, ref.discussionId]);
    case 'newSession':
      return JSON.stringify([ref.kind, ref.instanceId]);
    case 'pendingMessage':
      return JSON.stringify([ref.kind, ref.sessionId, ref.localId]);
    case 'participantMessage':
    case 'automationAuthoring':
      return JSON.stringify([ref.kind, ref.sessionId, ref.instanceId]);
    case 'workflowAuthoring':
      return JSON.stringify([ref.kind, ref.draftId, ref.blockId, ref.instanceId]);
  }
}

/** The sole equality decision for exact Composer addresses. */
export function composerRefsV1Equal(left: ComposerRefV1, right: ComposerRefV1): boolean {
  return composerRefV1Key(left) === composerRefV1Key(right);
}
