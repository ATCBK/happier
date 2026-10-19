import { expect, it } from 'vitest';
import { RpcHandlerManager } from './RpcHandlerManager';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';

it.each(['account', 'terminal'] as const)('preserves the %s root authority when admitting exact-machine terminal observation', async kind => {
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-home-root', binding: {
    accountId: 'actor', custodianAccountId: 'owner', authentication: { kind, tokenEpoch: 1 },
    accountEncryptionMode: 'plain', serverIdentityId: 'home', machineId: 'machine', installationId: 'installation',
    actionId: 'machines.terminal.list', requestId: 'original-request', requestEnvelopeDigest: 'a'.repeat(43),
    target: { kind: 'machine', machineId: 'machine' },
  } });
  const authority = kind === 'account' ? 'present_user' as const : 'account_automation' as const;
  const rpc = new RpcHandlerManager({ scopePrefix: 'machine', localMachineId: 'machine', encryptionMode: 'plain', logger: () => {},
    // Authenticated Home admission is the network boundary; local matching stays real.
    authorizeRequest: async () => ({ ok: true }) });
  rpc.registerHandler(RPC_METHODS.DAEMON_TERMINAL_LIST, (_input, context) => ({ authority: context?.callerAuthority, terminals: [] }));
  const request = { method: `machine:${RPC_METHODS.DAEMON_TERMINAL_LIST}`, params: {},
    callerAuthority: authority, callerInputAuthorization: root,
    machineAdmission: { actorAccountId: 'actor', custodianAccountId: 'owner', machineId: 'machine',
      installationId: 'installation', role: 'manage' as const, encryptionMode: 'plain' as const } };
  expect(await rpc.handleRequest(request)).toMatchObject({ authority, terminals: [] });
  expect(await rpc.handleRequest({ ...request, callerAuthority: kind === 'account' ? 'account_automation' : 'present_user' }))
    .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
  expect(await rpc.handleRequest({ ...request, machineAdmission: { ...request.machineAdmission, installationId: 'replaced' } }))
    .toMatchObject({ errorCode: RPC_ERROR_CODES.FORBIDDEN });
});
