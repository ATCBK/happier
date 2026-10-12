import { definePlugin, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { actionResultSchema, actionSchemas, FIXTURE_ORIGIN } from './contracts.mjs';

async function execute(action: keyof typeof actionSchemas, input: unknown, context: PluginInvocationContext) {
  const parsed = actionSchemas[action].parse(input);
  if (!context.session) throw new Error('fixture_session_required');
  if (!context.invocationId?.trim()) throw new Error('fixture_invocation_required');
  const response = await context.services.http.request({
    url: `${FIXTURE_ORIGIN}/api/actions/${action}`,
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', 'idempotency-key': context.invocationId,
      'x-happier-fixture-session-id': context.session.id },
    body: new TextEncoder().encode(JSON.stringify(parsed)),
  }, { signal: context.signal });
  if (response.status !== 200) throw new Error(`fixture_action_failed:${response.status}`);
  return actionResultSchema.parse(JSON.parse(new TextDecoder().decode(response.body)));
}

export const { manifest, activate } = definePlugin({
  id: 'dev.leads-fixture', version: '0.1.0', displayName: 'Leads fixture',
  description: 'Dev-only lead analysis and stage approval fixture for embedded chats.',
  runtime: { apiVersion: 1 }, entrypoints: { daemon: './dist/daemon.js' },
  hostAccess: { required: [{
    id: 'fixture-backend', capability: 'network',
    reason: 'Apply approved lead changes to the local CRM fixture.',
    scope: { targets: [{ kind: 'fixedOrigin', origin: FIXTURE_ORIGIN }], methods: ['POST'] },
  }], optional: [] },
  actions: {
    'record-analysis': {
      title: 'Record lead analysis', description: 'Save a score, summary and next step.',
      scopes: ['session'], surfaces: ['agent', 'mcp', 'cli', 'ui'], dangerLevel: 'safe',
      hostAccess: ['fixture-backend'], inputSchema: actionSchemas.record_analysis, resultSchema: actionResultSchema,
      run: (input, context) => execute('record_analysis', input, context),
    },
    'update-stage': {
      title: 'Update lead stage', description: 'Propose a pipeline stage change.',
      scopes: ['session'], surfaces: ['agent', 'mcp', 'cli', 'ui'], dangerLevel: 'writesRemote',
      confirmation: { title: 'Update this lead’s stage?', body: 'The CRM pipeline will change after approval.', confirmLabel: 'Update stage' },
      hostAccess: ['fixture-backend'], inputSchema: actionSchemas.update_stage, resultSchema: actionResultSchema,
      run: (input, context) => execute('update_stage', input, context),
    },
  },
});
