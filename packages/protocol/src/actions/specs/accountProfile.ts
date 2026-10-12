import { z } from 'zod';
import {
  AccountNameUpdateRequestV1Schema, AccountNameUpdateResponseV1Schema,
  AccountUsernameUpdateRequestV1Schema, AccountUsernameUpdateResponseV1Schema,
  AccountSelfProfileV1Schema,
} from '../../account/profile.js';
import { homeDomainActionRow, homeDomainApprovalField } from './homeDomainRow.js';

/** Self-only profile intents; the answering Home owns policy and the authenticated Account. */
export const ACCOUNT_PROFILE_ACTION_SPECS_V1 = Object.freeze([
  homeDomainActionRow({
    id: 'account.profile.get', approval: {result: 'required'}, title: 'Read your profile',
    description: 'Read your own name, username and avatar on this Home.',
    safety: 'safe', sideEffectClass: 'read', cliPath: ['account', 'profile', 'get'],
    method: 'GET', path: '/v1/account/profile', inputSchema: z.object({}).strict(),
    outputSchema: AccountSelfProfileV1Schema,
  }),
  homeDomainActionRow({
    id: 'account.name.set', approval: {result: 'required'}, title: 'Set your name',
    description: 'Set what people should call you on this Home. Empty clears the name.',
    safety: 'danger', sideEffectClass: 'write', cliPath: ['account', 'name', 'set'],
    path: '/v1/account/profile', inputSchema: AccountNameUpdateRequestV1Schema,
    outputSchema: AccountNameUpdateResponseV1Schema,
    inputHints: { fields: [homeDomainApprovalField('name', 'Name', { required: true })] },
  }),
  homeDomainActionRow({
    id: 'account.username.set', approval: {result: 'required'}, title: 'Set your username',
    description: 'Set your own username when this Home’s Friends policy permits it.',
    safety: 'danger', sideEffectClass: 'write', cliPath: ['account', 'username', 'set'],
    path: '/v1/account/username', inputSchema: AccountUsernameUpdateRequestV1Schema,
    outputSchema: AccountUsernameUpdateResponseV1Schema,
    inputHints: { fields: [homeDomainApprovalField('username', 'Username', { required: true })] },
  }),
]);
