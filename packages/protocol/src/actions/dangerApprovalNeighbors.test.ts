import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import type { ActionId } from './actionIds.js';
import { describeApprovalRequestFields, resolveApprovalRequestApproveAdmission } from './actionApprovalPresentation.js';
import { ApprovalRequestV2Schema } from '../approvals/approvalRequestV1.js';
import { decideApprovalRequestTransition, settleApprovalRequestActionArgs } from '../approvals/approvalRequestTransition.js';
import { skillFileFromBytesV1 } from '../prompts/library/skills/skillZipV1.js';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import type { ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { createPluginInstallationReviewFixture } from '../testing/pluginInstallationReviewFixture.js';

const file = skillFileFromBytesV1('SKILL.md', new TextEncoder().encode('Review the complete skill instructions.'), 0o755);
const cases: readonly (readonly [ActionId, unknown, string])[] = [
  ['skills.create', { name: 'review', files: [file] }, 'files'],
  ['skills.update', { skillId: 'skill-a', expectedRevision: '1:1', files: [{ kind: 'upsert', file }, { kind: 'remove', path: 'obsolete.md' }] }, 'files'],
  ['skills.install', { source: { kind: 'upload', files: [file] }, selectPaths: ['review'] }, 'source'],
  ['skills.install', { source: { kind: 'link', url: 'https://example.test/skill' }, dryRun: true }, 'source'],
  ['skills.install', { source: { kind: 'registry', sourceId: 'registry-a', itemId: 'review', version: '1.0.0' } }, 'source'],
  ['skills.duplicate', { skillId: 'skill-a' }, 'skillId'],
  ['skills.delete', { skillId: 'skill-a', expectedRevision: '1:1' }, 'expectedRevision'],
  ['skills.found.adopt', { machineId: 'machine-a', items: [{ name: 'review', path: '/skills/review' }] }, 'items'],
  ['skills.updates.apply', { skillId: 'skill-a', expectedRevision: '1:1', choices: { 'SKILL.md': 'mine', 'README.md': 'theirs' } }, 'choices'],
  ['skills.machine.install', { skillId: 'skill-a', machineId: 'machine-a', agents: ['codex'] }, 'agents'],
  ['skills.machine.uninstall', { skillId: 'skill-a', machineId: 'machine-a', force: true }, 'force'],
  ['registries.sources.create', { url: 'https://example.test/registry', title: 'Tools', kinds: ['skill', 'agent'] }, 'url'],
  ['registries.sources.token.set', { sourceId: 'registry-a', token: null }, 'token'],
  ['registries.sources.delete', { sourceId: 'registry-a' }, 'sourceId'],
  ['agents.acp.backends.upsert', { backend: { id: 'agent-a', name: 'agent-a', title: 'Review agent', launch: { kind: 'npm', package: 'review-agent', version: '1.0.0', args: [] } } }, 'backend.launch'],
  ['agents.acp.backends.delete', { backendId: 'agent-a' }, 'backendId'],
  ['agents.acp.backends.installFromRegistry', { fromRegistry: { sourceId: 'registry-a', itemId: 'agent-a', version: '1.0.0' }, installOn: ['machine-a'] }, 'installOn'],
  ['machines.agents.install', { machineId: 'machine-a', agentId: 'custom-acp', definitionId: 'agent-a', intent: 'update', consent: { vendorRecipe: true } }, 'intent'],
  ['machines.agents.uninstall', { machineId: 'machine-a', agentId: 'custom-acp', definitionId: 'agent-a' }, 'definitionId'],
  ['machines.agents.install.cancel', { machineId: 'machine-a', jobId: 'job-a' }, 'jobId'],
  ['machines.agents.signIn.start', { machineId: 'machine-a', agentId: 'codex' }, 'agentId'],
  ['machines.agents.signIn.cancel', { machineId: 'machine-a', agentId: 'codex', terminalId: 'terminal-a' }, 'terminalId'],
  ['machines.agents.signIn.restart', { machineId: 'machine-a', agentId: 'codex', terminalId: 'terminal-a' }, 'terminalId'],
  ['session.capabilities.set', { sessionId: 'session-a', kind: 'skill', id: 'skill-a', state: 'off', reason: 'Not needed' }, 'state'],
  ['plugins.install', { machineId: 'machine-a', source: { kind: 'marketplace', sourceId: 'registry-a', pluginId: 'review-plugin', version: '1.0.0' } }, 'source'],
  ['plugins.install', { machineId: 'machine-a', path: '/plugins/review', kind: 'path', force: true }, 'path'],
];

function requestFor(actionId: ActionId, raw: unknown) {
  const spec = getActionSpec(actionId);
  const input = spec.inputSchema.parse(raw);
  const observation = spec.projectObservationInput?.(input) ?? input;
  return ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'cli' }, actionId, actionArgs: spec.approvalInputCustody === 'live_only' ? observation : input,
    preview: { actionId, actionArgs: observation,
      ...(actionId === 'plugins.install' ? { pluginInstall: { permissionsDisclosure: 'daemonEvaluated', pendingReview: {
        kind: 'reviewRequired', reviewKind: 'installation', pendingChangeId: 'neighbor-plugin-install',
        reason: 'firstInstall', currentVersion: null, authorityExpansion: [],
        review: createPluginInstallationReviewFixture(),
      } } } : {}) }, summary: spec.title,
    executionOriginV1: { v: 1, authority: 'account_automation', caller: { kind: 'host' }, requestId: 'neighbor-request',
      surface: 'cli', serverId: 'home', actionId } });
}

describe('non-MCP dangerous capability approvals', () => {
  it('creates the ACP private preview through the real executor without copying replay secrets into review or settled history', async () => {
    const requests: ApprovalRequestV2[] = [];
    // Artifact persistence is the system boundary; admission, policy, private
    // projection and request construction remain the real production path.
    const deps = { approvalsCreate: async ({ request }) => {
      requests.push(ApprovalRequestV2Schema.parse(request));
      return { artifactId: 'acp-private-review' };
    } } satisfies Pick<ActionExecutorDeps, 'approvalsCreate'>;
    const executor = createActionExecutor(deps as unknown as ActionExecutorDeps);
    const raw = { backend: { id: 'agent-a', name: 'agent-a', title: 'Review agent', launch: {
      kind: 'archive', version: '1.0.0', args: [],
      assetsByPlatform: { 'linux-x64': { archiveUrl: 'https://example.test/agent.tar.gz', executableSubpath: 'agent' } },
      envByPlatform: { 'linux-x64': { ACCESS_TOKEN: 'archive-secret-sentinel' } },
    }, env: { API_KEY: { t: 'literal', v: 'literal-secret-sentinel' },
      ENDPOINT: { t: 'template', template: 'sensitive-template-sentinel', vars: {
        key: { t: 'literal', v: 'nested-secret-sentinel' }, token: { t: 'savedSecret', secretId: 'saved-token' },
      } } }, auth: { support: 'login_terminal', loginCommand: {
      command: 'review-agent', args: ['auth-secret-sentinel'],
    } } } };
    expect(await executor.execute('agents.acp.backends.upsert', raw, {
      surface: 'cli', authority: 'account_automation', serverId: 'home', runtimeAccountId: 'owner',
      actionCaller: { kind: 'host' }, actionRequestId: 'acp-private-review',
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'acp-private-review' } });
    const request = ApprovalRequestV2Schema.parse(requests[0]);
    expect(request.actionArgs).toEqual(getActionSpec('agents.acp.backends.upsert').inputSchema.parse(raw));
    const executing = ApprovalRequestV2Schema.parse({ ...request, status: 'executing',
      updatedAtMs: request.updatedAtMs + 1, decision: { kind: 'approve', decidedAtMs: request.updatedAtMs + 1 } });
    const history = ApprovalRequestV2Schema.parse({ ...executing, status: 'executed',
      updatedAtMs: executing.updatedAtMs + 1, actionArgs: settleApprovalRequestActionArgs(executing),
      execution: { executedAtMs: executing.updatedAtMs + 1, ok: true } });
    expect(decideApprovalRequestTransition(executing, history)).toEqual({ ok: true, changed: true });
    for (const sentinel of ['literal-secret-sentinel', 'nested-secret-sentinel', 'sensitive-template-sentinel',
      'auth-secret-sentinel', 'archive-secret-sentinel']) {
      expect(JSON.stringify(request.actionArgs)).toContain(sentinel);
      expect(JSON.stringify(request.preview)).not.toContain(sentinel);
      expect(JSON.stringify(history)).not.toContain(sentinel);
    }
    expect(JSON.stringify(request.preview)).toContain('saved-token');
    expect(JSON.stringify(request.preview)).toContain('ACCESS_TOKEN');
    expect(describeApprovalRequestFields(history)).toEqual(resolveApprovalRequestApproveAdmission(request).presentation);
  });

  it('reviews all configured ACP operation fields while retaining only safe environment metadata in history', () => {
    const raw = { backend: { id: 'agent-a', name: 'agent-a', title: 'Review agent', launch: {
      kind: 'command', command: 'review-agent', args: ['--acp'],
    }, env: { API_KEY: { t: 'literal', v: 'literal-secret-sentinel' },
      TOKEN: { t: 'savedSecret', secretId: 'saved-token' },
      ENDPOINT: { t: 'template', template: 'sensitive-template-sentinel', vars: {
        key: { t: 'literal', v: 'nested-secret-sentinel' }, token: { t: 'savedSecret', secretId: 'saved-template-token' },
      } } }, auth: { support: 'login_terminal', machineLoginKey: 'agent-login',
      loginCommand: { command: 'review-agent', args: ['auth-secret-sentinel'] }, envVars: ['API_KEY'] },
      runtime: { stderrRules: { authenticationErrorDetail: 'Sign in required' } },
      defaultMode: 'review', defaultModel: 'model-a', capabilities: { supportsLoadSession: true },
    }, dryRun: true, expectedRevision: 3 };
    const request = requestFor('agents.acp.backends.upsert', raw);
    const presentation = resolveApprovalRequestApproveAdmission(request).presentation;
    for (const path of ['backend.env', 'backend.auth', 'backend.runtime', 'backend.defaultMode', 'backend.defaultModel', 'backend.capabilities', 'dryRun', 'expectedRevision']) {
      expect(presentation.rows.some(row => row.path === path), path).toBe(true);
    }
    const history = settleApprovalRequestActionArgs(request);
    for (const sentinel of ['literal-secret-sentinel', 'nested-secret-sentinel', 'sensitive-template-sentinel', 'auth-secret-sentinel']) {
      expect(JSON.stringify([presentation, history])).not.toContain(sentinel);
    }
    expect(JSON.stringify(history)).toContain('saved-template-token');
    expect(JSON.stringify(history)).toContain('API_KEY');
    expect(describeApprovalRequestFields({ ...request, status: 'executed', actionArgs: history })).toEqual(presentation);
  });

  it('retains archive launch environment names without persisting their values', () => {
    const request = requestFor('agents.acp.backends.upsert', { backend: {
      id: 'agent-a', name: 'agent-a', title: 'Review agent', launch: { kind: 'archive', version: '1.0.0',
        assetsByPlatform: { 'linux-x64': { archiveUrl: 'https://example.test/agent.tar.gz', executableSubpath: 'agent' } },
        envByPlatform: { 'linux-x64': { ACCESS_TOKEN: 'archive-secret-sentinel' } }, args: [],
      },
    } });
    const presentation = resolveApprovalRequestApproveAdmission(request).presentation;
    const history = settleApprovalRequestActionArgs(request);
    expect(JSON.stringify(request.actionArgs)).toContain('archive-secret-sentinel');
    expect(JSON.stringify([presentation, history])).not.toContain('archive-secret-sentinel');
    expect(JSON.stringify(history)).toContain('ACCESS_TOKEN');
    expect(describeApprovalRequestFields({ ...request, status: 'executed', actionArgs: history })).toEqual(presentation);
  });

  it('retains binary skill-file review metadata without encoded or decoded binary content', () => {
    const binary = skillFileFromBytesV1('asset.bin', new Uint8Array([0xff, 0, 0xfe]), 0o644);
    const request = requestFor('skills.create', { name: 'binary-asset', files: [binary] });
    const history = settleApprovalRequestActionArgs(request);
    expect(history).toMatchObject({ files: [{ path: 'asset.bin', contentKind: 'binary', sizeBytes: 3, unixMode: 0o644 }] });
    expect(JSON.stringify(history)).not.toContain('contentBase64');
    expect(JSON.stringify(history)).not.toContain('"content":');
    expect(describeApprovalRequestFields({ ...request, status: 'executed', actionArgs: history }))
      .toEqual(resolveApprovalRequestApproveAdmission(request).presentation);
  });

  it.each(cases)('preserves the reviewed %s operands after settlement', (actionId, raw, path) => {
    const request = requestFor(actionId, raw);
    const admission = resolveApprovalRequestApproveAdmission(request);
    expect(admission.status).toBe('available');
    expect(admission.presentation.rows.some(row => row.path === path), path).toBe(true);
    const executing = ApprovalRequestV2Schema.parse({ ...request, status: 'executing', updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 } });
    const settled = ApprovalRequestV2Schema.parse({ ...executing, status: 'executed', updatedAtMs: 3,
      actionArgs: settleApprovalRequestActionArgs(executing), execution: { executedAtMs: 3, ok: true } });
    expect(decideApprovalRequestTransition(executing, settled)).toEqual({ ok: true, changed: true });
    expect(describeApprovalRequestFields(settled)).toEqual(admission.presentation);
    expect(JSON.stringify(settled.actionArgs)).not.toContain('contentBase64');
    if (['skills.create', 'skills.update'].includes(actionId)
      || actionId === 'skills.install' && JSON.stringify(raw).includes('upload')) {
      expect(JSON.stringify(settled.actionArgs)).toContain('Review the complete skill instructions.');
    }
    expect(settleApprovalRequestActionArgs(settled)).toEqual(settled.actionArgs);
  });

  it.each([
    ['secrets.create', { name: 'Registry token', kind: 'token', value: 'private-value-sentinel' }],
    ['secrets.update', { secretId: 'secret-a', name: 'Renamed token', expectedUpdatedAt: 1, value: 'private-value-sentinel' }],
    ['secrets.delete', { secretId: 'secret-a', expectedUpdatedAt: 1 }],
  ] as const)('keeps %s review metadata without acquiring secret replay custody', (actionId, raw) => {
    const request = requestFor(actionId, raw);
    const admission = resolveApprovalRequestApproveAdmission(request);
    expect(admission.status).toBe('available');
    const history = settleApprovalRequestActionArgs(request);
    expect(JSON.stringify([request, admission.presentation, history])).not.toContain('private-value-sentinel');
    expect(admission.presentation.rows).toContainEqual(expect.objectContaining({
      path: actionId === 'secrets.create' ? 'name' : 'secretId', title: actionId === 'secrets.create' ? 'Name' : 'Saved Secret',
    }));
    expect(describeApprovalRequestFields({ ...request, status: 'executed', actionArgs: history })).toEqual(admission.presentation);
  });
});
