import type { ActionsService, PluginActionInputById, PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import { isPluginActionApprovalRequestCreated } from '@happier-dev/plugin-sdk/actions';

const target = { serverId: 'home', machineId: 'machine' };
const input = { ...target, principal: { kind: 'account', accountId: 'recipient' }, level: 'view' } satisfies PluginActionInputById['machines.access.grant.set'];

export async function machineSharing(actions: ActionsService) {
  const result = await actions.execute('machines.access.grants.list', target);
  if (isPluginActionApprovalRequestCreated(result)) return;
  const access: PluginActionResultById['machines.access.grants.list'] = result;
  if (!('kind' in access)) {
    const status: 'ready' | 'key_pending' | 'refused' = access.access.accessState;
    void status;
  }
  await actions.execute('machines.access.grant.set', input);
  await actions.execute('machines.access.leave', target);
  await actions.execute('machines.access.prepareKeys', target);
  const terminal = { ...target, terminalKey: 'member', workspace: {
    ...target, workspaceId: 'accepted', rootPath: '/repo',
  } } satisfies PluginActionInputById['machines.terminal.open'];
  await actions.execute('machines.terminal.open', terminal);
  await actions.execute('machines.terminal.list', target);
  await actions.execute('machines.terminal.restart', terminal);
  await actions.execute('machines.terminal.read', { ...target, terminalId: 'pty', byteOffset: 0 });
  await actions.execute('machines.terminal.write', { ...target, terminalId: 'pty', event: { t: 'text', text: 'pwd\r' } });
  await actions.execute('machines.terminal.close', { ...target, terminalId: 'pty' });
  // @ts-expect-error Requester custody is stamped by the trusted host, not an author.
  await actions.execute('machines.terminal.open', {
    ...terminal,
    requesterAccountId: 'forged',
  });
  // @ts-expect-error Public grants cannot accept physical recipient ciphertext.
  await actions.execute('machines.access.grant.set', {
    ...input,
    recipientKeyEnvelopes: [],
  });
  // @ts-expect-error An author cannot supply an admission or grant proof.
  await actions.execute('machines.access.grants.list', {
    ...target,
    admission: { role: 'manage' },
  });
}
