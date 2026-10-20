import { afterEach, describe, expect, it, vi } from 'vitest';
import * as machineTransport from '@/session/transport/rpc/machineRpc';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createCliActionExecutor } from './createCliActionExecutor';
import { createCliActionDeps } from './createCliActionDeps';
import { getActionSpec, ProjectWorkerActionInputSchemasV1, type ActionExecuteResult } from '@happier-dev/protocol';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionMachineBootstrapV1Schema, ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import axios, { AxiosHeaders } from 'axios';
import { createProjectWorkerAction } from '@/workspaces/execution/projectWorkerAction';
import { createProjectWorkerAdmission } from '@/workspaces/execution/projectWorkerAdmission';
import { createDaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

const input = { workspace: { serverId: 'home', refId: 'checkout' },
  destination: { kind: 'machine' as const, machineId: 'worker' }, purpose: 'finite' as const };
const params = { token: 'requester-token', credentials: { token: 'requester-token', encryption: null },
  sessionId: 'cli-global', mode: 'plain' as const, ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://home.test' };
const installedSettings = { getActionsSettings: () => normalizeActionsSettingsV1({ v: 1,
  approvalWaivedSurfaces: { 'projects.worker.copy.retire': ['cli', 'agent', 'mcp'] } }), getAccountSettings: () => null };
afterEach(() => vi.restoreAllMocks());

function mockOriginalWorkerStatusHome() {
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 1,
    provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.signature`;
  const admittedParams = { ...params, token, credentials: { token, encryption: null }, serverIdentityId: 'srv_worker_home' };
  const installed = ExternalActionMachineBootstrapV1Schema.parse({ id: 'worker', installationId: 'worker-installation',
    kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
    access: { custodian: { accountId: 'requester', displayName: 'Requester' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } });
  const reply = (data: unknown) => ({ status: 200, data, statusText: 'OK', headers: {},
    config: { headers: new AxiosHeaders() } });
  // Original CLI reads enter Home admission before delivery. Substitute only
  // that HTTP boundary, retaining the real requester and output validation.
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    expect(config?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
    if (url === 'https://home.test/v1/account/encryption') return reply({ mode: 'plain', updatedAt: 1 });
    if (url === 'https://home.test/v1/machines') return reply([installed]);
    expect(url).toBe('https://home.test/v1/machines/worker');
    return reply({ machine: installed });
  });
  const receive = vi.fn<() => ActionExecuteResult>();
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
    expect(config?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
    const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
    expect(request.machineId).toBe(installed.id);
    expect(envelope).toMatchObject({ target: { kind: 'machine', machineId: installed.id }, input });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-issued-worker-status', binding: {
      accountId: 'requester', custodianAccountId: 'requester', authentication: { kind: 'terminal', tokenEpoch: 1 },
      serverIdentityId: admittedParams.serverIdentityId, machineId: installed.id, installationId: installed.installationId,
      accountEncryptionMode: 'plain', actionId: 'projects.worker.status', requestId: envelope.requestId,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target,
    } });
    if (url === `https://home.test${bindExternalActionExecutionAuthorizationHttpPathV1('projects.worker.status')}`) {
      return reply(authorization);
    }
    expect(url).toBe('https://home.test/v1/actions/projects.worker.status');
    expect(request.executionAuthorization).toEqual(authorization);
    return reply(ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.worker.status',
      requestId: envelope.requestId, execution: receive() }));
  });
  return { admittedParams, receive };
}

describe('worker Actions through requester CLI composition', () => {
  it.each(['cli', 'agent', 'mcp'] as const)('keeps installed worker status/retire, Sync inspection and Account preferences composed on %s', async surface => {
    const request = ProjectWorkerActionInputSchemasV1['projects.worker.copy.inspect'].parse(
      JSON.parse(getActionSpec('projects.worker.copy.inspect').examples!.voice!.argsExample!),
    );
    const preview = { ok: true, preview: { targetMachineId: request.targetMachineId,
      workspaceRefId: request.targetWorkspaceRefId, rootFingerprint: 'b'.repeat(64), sizeBytes: 42 } };
    // Exact Machine RPC and Account HTTP are the only substituted boundaries.
    const transport = vi.spyOn(machineTransport, 'callExactMachineRpc').mockResolvedValue(preview);
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      if (config.url === 'https://home.test/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      expect(config.url).toBe('https://home.test/v1/projects/execution/config/read');
      expect(config.data).toEqual({ address: request.workspace });
      return { status: 200, data: { status: 'absent' } };
    });
    const installed = createProjectWorkerAction({ machineId: request.machineId, serverId: 'home',
      serverHttpBaseUrl: 'https://home.test', credentials: params.credentials,
      admission: createProjectWorkerAdmission({ machineId: request.machineId, admissionDrain: createDaemonAdmissionDrain(),
        readPolicy: async () => ({ status: 'unavailable' }) }), isFiniteExecutionLive: () => false });
    const owner = createCliActionExecutor({ ...params, accountServerActionDeps: createAccountServerActionDeps(params),
      pluginActionExecutionOwner: 'current_process', projectWorkerAction: installed, actionsSettingsProvider: installedSettings });
    const context = { surface, authority: 'present_user' as const };
    expect(await owner.execute('projects.worker.status', { ...input, destination: { kind: 'machine', machineId: request.machineId } }, context))
      .toMatchObject({ ok: true, result: { eligible: false, explanation: 'unsupported' } });
    expect(await owner.execute('projects.worker.copy.inspect', request, context)).toEqual({ ok: true, result: preview });
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ machineId: request.machineId,
      method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT, request }));
    expect(await owner.execute('projects.worker.copy.retire', { workspace: request.workspace, machineId: request.machineId,
      expectedRelationship: request.expectedRelationship }, { ...context,
      presentUserConfirmation: { actionId: 'projects.worker.copy.retire' } }))
      .toMatchObject({ ok: false, errorCode: 'workspace_sync_unavailable' });
    expect(await owner.execute('projects.worker.preferences.get', { workspace: request.workspace }, context))
      .toMatchObject({ ok: true, result: { status: 'ready', revision: 'absent' } });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('reads the current exact-copy removal identity through the public Action and refuses another target', async () => {
    const retirement = JSON.parse(getActionSpec('projects.worker.copy.retire').examples!.voice!.argsExample!);
    const request = { ...retirement, kind: 'preview', targetMachineId: 'worker', targetWorkspaceRefId: 'copy' };
    const preview = { ok: true, preview: { targetMachineId: 'worker', workspaceRefId: 'copy', rootFingerprint: 'b'.repeat(64), sizeBytes: 42 } };
    const transport = vi.spyOn(machineTransport, 'callExactMachineRpc').mockResolvedValueOnce(preview);
    const owner = createCliActionExecutor({ ...params, accountServerActionDeps: createAccountServerActionDeps(params) });
    expect(await owner.execute('projects.worker.copy.inspect', request, { surface: 'agent' }))
      .toEqual({ ok: true, result: preview });
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'controller',
      method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT, request }));
    transport.mockResolvedValueOnce({ ...preview, preview: { ...preview.preview, workspaceRefId: 'unrelated' } });
    expect(await owner.execute('projects.worker.copy.inspect', request, { surface: 'cli' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    transport.mockResolvedValueOnce({ ok: false, errorCode: 'workspace_copy_not_owned' });
    expect(await owner.execute('projects.worker.copy.inspect', request, { surface: 'cli' }))
      .toEqual({ ok: true, result: { ok: false, errorCode: 'workspace_copy_not_owned' } });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('uses exact Machine transport even when Account preference ports are installed and retains unknown load', async () => {
    const status = { eligible: true, candidate: { serverId: 'home', machineId: 'worker' }, load: { kind: 'unknown' }, explanation: 'load_unknown' };
    const addressedHomes: string[] = [];
    const transport = vi.spyOn(machineTransport, 'callExactMachineRpc').mockImplementation(async () => {
      addressedHomes.push(resolveServerHttpBaseUrl());
      return status;
    });
    const owner = createCliActionExecutor({ ...params, accountServerActionDeps: createAccountServerActionDeps(params) });
    const signal = new AbortController().signal;
    expect(await owner.execute('projects.worker.status', input, { surface: 'agent', authority: 'account_automation',
      signal, actionRequestId: 'status-request' })).toEqual({ ok: true, result: status });
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'worker', method: 'projects.worker.status',
      request: input, signal, requestId: 'status-request', authorityCeiling: 'account_automation' }));
    expect(addressedHomes).toEqual(['https://home.test']);
    transport.mockClear();
    expect(await owner.execute('projects.worker.status', { ...input, workspace: { ...input.workspace, serverId: 'other' } },
      { surface: 'cli' })).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('retains receiving access refusal and refuses malformed or mismatched status instead of inventing eligibility', async () => {
    const { admittedParams, receive } = mockOriginalWorkerStatusHome();
    const owner = createCliActionExecutor({ ...admittedParams, accountServerActionDeps: createAccountServerActionDeps(admittedParams) });
    const context = { surface: 'cli' as const, authority: 'account_automation' as const };
    const failure = { ok: false as const, errorCode: 'project_worker_access_denied', error: 'project_worker_access_denied' };
    receive.mockReturnValueOnce(failure);
    expect(await owner.execute('projects.worker.status', input, context)).toEqual(failure);
    receive.mockReturnValueOnce({ ok: true, result: { eligible: true, candidate: { serverId: 'home', machineId: 'other' }, load: { kind: 'unknown' }, explanation: 'load_unknown' } });
    expect(await owner.execute('projects.worker.status', input, context))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    receive.mockReturnValueOnce({ ok: true, result: { eligible: true, candidate: null, load: { kind: 'unknown' }, explanation: 'eligible' } });
    expect(await owner.execute('projects.worker.status', input, context))
      .toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
    expect(receive).toHaveBeenCalledTimes(3);
  });

  it('does not replay an unobserved retirement or discard a confirmed retirement when cancellation arrives with its receipt', async () => {
    const request = ProjectWorkerActionInputSchemasV1['projects.worker.copy.retire'].parse(
      JSON.parse(getActionSpec('projects.worker.copy.retire').examples!.voice!.argsExample!),
    );
    const transport = vi.spyOn(machineTransport, 'callExactMachineRpc');
    const owner = createCliActionDeps(params).projectWorkerAction!;
    const controller = new AbortController();
    const args = { actionId: 'projects.worker.copy.retire' as const, input: request,
      context: { surface: 'cli' as const, authority: 'account_automation' as const }, signal: controller.signal };
    transport.mockResolvedValueOnce({ status: 'possibly_retired' });
    expect(await owner(args)).toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
    expect(transport).toHaveBeenCalledTimes(1);
    transport.mockImplementationOnce(async () => { controller.abort(); return { status: 'retired' }; });
    expect(await owner(args)).toEqual({ status: 'retired' });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('still withdraws a cancelled status read after the receiving Machine responds', async () => {
    const { admittedParams, receive } = mockOriginalWorkerStatusHome();
    const controller = new AbortController();
    receive.mockImplementationOnce(() => {
      controller.abort();
      return { ok: true, result: { eligible: true, candidate: { serverId: 'home', machineId: 'worker' }, load: { kind: 'unknown' }, explanation: 'load_unknown' } };
    });
    const owner = createCliActionDeps(admittedParams).projectWorkerAction!;
    await expect(owner({ actionId: 'projects.worker.status', input, signal: controller.signal,
      context: { surface: 'cli', authority: 'account_automation' } })).rejects.toMatchObject({ name: 'AbortError' });
    expect(receive).toHaveBeenCalledTimes(1);
  });
});
