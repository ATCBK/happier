import { FriendsMutationInputSchema, FriendsMutationResponseSchema } from '../../social/friends.js';
import { homeDomainActionRow, homeDomainApprovalField } from './homeDomainRow.js';

/** Relationship changes remain decided by the existing authenticated Home writers. */
export const FRIENDS_ACTION_SPECS = Object.freeze([
  {
    ...homeDomainActionRow({
      id: 'friends.add', approval: { result: 'required', flow: 'deferred' },
      title: 'Request or accept friendship',
      description: 'Send a friend request or accept an incoming request on this Home.',
      safety: 'danger', sideEffectClass: 'write', approvalPolicy: { uiConfirmation: 'direct' },
      cliPath: ['friends', 'add'], mcp: true, path: '/v1/friends/add',
      inputSchema: FriendsMutationInputSchema, outputSchema: FriendsMutationResponseSchema,
      inputHints: { fields: [homeDomainApprovalField('uid', 'Account id', { required: true })] },
    }),
    bindings: { mcpToolName: 'friends_add' },
  },
  {
    ...homeDomainActionRow({
      id: 'friends.remove', approval: { result: 'required', flow: 'deferred' },
      title: 'Remove or decline friendship',
      description: 'Remove a friend, decline an incoming request or cancel your outgoing request on this Home.',
      safety: 'danger', sideEffectClass: 'write', cliPath: ['friends', 'remove'], mcp: true,
      path: '/v1/friends/remove', inputSchema: FriendsMutationInputSchema,
      outputSchema: FriendsMutationResponseSchema,
      inputHints: { fields: [homeDomainApprovalField('uid', 'Account id', { required: true })] },
    }),
    bindings: { mcpToolName: 'friends_remove' },
  },
]);
