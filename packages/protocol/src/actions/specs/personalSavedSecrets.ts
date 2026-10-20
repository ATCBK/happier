import { z } from 'zod/mini';
import { readRecord } from '../../inputs/inputRecords.js';
import { PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1 as inputs, PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 as outputs,
  type PersonalSavedSecretActionIdV1 } from '../../account/settings/personalSavedSecretActionsV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
function secretSpec<TId extends PersonalSavedSecretActionIdV1>(id: TId, title: string): PreNormalizedActionSpec & Readonly<{
  id: TId; inputSchema: typeof inputs[TId]; outputSchema: typeof outputs[TId];
}> {
  const read = id === 'secrets.list';
  const observe = (raw: unknown) => { const value = readRecord(raw); return {
    ...(typeof value.secretId === 'string' ? { secretId: value.secretId } : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(typeof value.kind === 'string' ? { kind: value.kind } : {}),
  }; };
  return { id, title, safety: read ? 'safe' : 'danger', approval: { result: read ? 'none' : 'required' },
    // Deleting loses the value; creating and editing your own secret are reversible.
    approvalPolicy: id === 'secrets.create' || id === 'secrets.update' ? { uiConfirmation: 'direct' } : {},
    sideEffectClass: read ? 'read' : 'write', executionPlacement: 'account', placements: [], requiredAuthority: 'account_automation',
    surfaces: { ui: true, cli: true, agent: true, mcp: true, rpc: true, voice: false },
    bindings: { rpcMethod: id, mcpToolName: id.replaceAll('.', '_') }, inputSchema: inputs[id], outputSchema: outputs[id], inputHints: { fields: [
      { path: 'secretId', title: 'Saved Secret', widget: 'text' }, { path: 'name', title: 'Name', widget: 'text' },
      { path: 'kind', title: 'Kind', widget: 'select', options: [
        { value: 'apiKey', label: 'API key' }, { value: 'token', label: 'Token' }, { value: 'password', label: 'Password' }, { value: 'other', label: 'Other' },
      ] },
    ] },
    ...(id === 'secrets.create' || id === 'secrets.update' ? { approvalInputCustody: 'live_only' as const } : {}),
    projectObservationInput: observe, projectObservationOutput: observe,
    cli: { acceptsServerId: true, commands: [{ path: id.split('.'), visibility: 'canonical' }] },
  };
}
// Values are admitted only by the stdin/hidden-prompt adapter after argv parsing.
const secretCli = z.strictObject({ secretId: z.string().check(z.minLength(1)), rename: inputs['secrets.update'].shape.name });
export const PERSONAL_SAVED_SECRET_ACTION_SPECS_V1 = [
  secretSpec('secrets.list', 'List Saved Secrets'),
  { ...secretSpec('secrets.create', 'Create private Saved Secret'), cli: { acceptsServerId: true,
    inputSchema: z.strictObject({ name: inputs['secrets.create'].shape.name, kind: inputs['secrets.create'].shape.kind }),
    commands: [{ path: ['secrets', 'create'], positionals: ['name'], visibility: 'canonical' as const }] } },
  { ...secretSpec('secrets.update', 'Update private Saved Secret'), cli: { acceptsServerId: true, inputSchema: secretCli,
    commands: [{ path: ['secrets', 'update'], positionals: ['secretId'], visibility: 'canonical' as const }] } },
  { ...secretSpec('secrets.delete', 'Delete private Saved Secret'), cli: { acceptsServerId: true,
    inputSchema: z.omit(secretCli, { rename: true }),
    commands: [{ path: ['secrets', 'delete'], positionals: ['secretId'], visibility: 'canonical' as const }] } },
] as const satisfies readonly PreNormalizedActionSpec[];
