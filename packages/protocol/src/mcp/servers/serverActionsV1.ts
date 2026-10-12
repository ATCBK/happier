import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import type { ActionExecuteFailure, ActionExecuteResult } from '../../actions/actionExecutionResult.js';
import type { ActionExecutorContext, ActionExecutorDeps } from '../../actions/executor/types.js';
import { ConnectedAccountDaemonControlResponseSchema } from '../../connect/connectedAccountDaemonRpcV1.js';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 as connectedOutputs } from '../../connect/configurationActionsV1.js';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 as signInService } from '../../connect/qualifiedConnectedAccountPersistence.js';
import { canonicalMcpOAuthResourceUrlV1 } from '../oauth/mcpOAuthResourceV1.js';
import { McpServerRuleV1Schema, McpServerCatalogEntryV1Schema, McpServerConfigOverrideV1Schema } from './settingsV1.js';
import { ReachRulesChangeV1Schema, resolveCreateReachV1, type ReachRulesWriteContextV1 } from '../../reach/reachRulesChangeV1.js';
import { McpRulesSetInputV1Schema, McpRulesSetOutputV1Schema } from '../../actions/specs/capabilityRules.js';
import { McpServerCatalogSnapshotV1Schema,
  type McpServerCatalogSnapshotV1, type McpServerCatalogMutationV1 } from './catalogSchemasV1.js';
import { McpServerCatalogV1Schema, McpServerCatalogDiagnosticV1Schema, McpServerCatalogRowMutationResponseV1Schema,
  type McpServerCatalogMutationResponseV1 } from './catalogSchemasV1.js';
import { DaemonMcpServersTestAuthoringRequestSchema, DaemonMcpServersTestResponseSchema,
  DaemonMcpServersDetectRequestSchema, DaemonMcpServersDetectResponseSchema } from './daemonRpcV1.js';
import type { McpServerActionIdV1 } from './serverActionIdsV1.js';
export { MCP_SERVER_ACTION_IDS_V1, isMcpServerActionIdV1, type McpServerActionIdV1 } from './serverActionIdsV1.js';

const revision = lazyZodSchema(() => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));
const catalogRevision = lazyZodSchema(() => z.union([revision, z.literal('absent')]));
const identity = lazyZodSchema(() => z.string().min(1));
const createItem = lazyZodSchema(() => z.object({ entry: McpServerCatalogEntryV1Schema,
  where: ReachRulesChangeV1Schema.optional() }).strict());
const serverWrite = lazyZodSchema(() => z.object({ expectedRevision: catalogRevision,
  entry: McpServerCatalogEntryV1Schema, configOverrides: z.array(McpServerConfigOverrideV1Schema).optional() }).strict());
const serverCreate = lazyZodSchema(() => z.union([
  createItem.extend({ expectedRevision: catalogRevision }).strict(),
  z.object({ expectedRevision: catalogRevision, entries: z.array(createItem) }).strict(),
]));
const serverListEntry = lazyZodSchema(() => {
  const { id, name, title, description, transport, createdAt, updatedAt } = McpServerCatalogEntryV1Schema.shape;
  return z.object({ id, name, title, description, transport, createdAt, updatedAt }).strict();
});
const bindingListEntry = McpServerRuleV1Schema;
const listCatalog = lazyZodSchema(() => z.object({ v: McpServerCatalogV1Schema.shape.v,
  servers: z.array(serverListEntry), bindings: z.array(bindingListEntry) }).strict());
const listSnapshot = lazyZodSchema(() => z.discriminatedUnion('status', [
  McpServerCatalogSnapshotV1Schema.options[0], McpServerCatalogSnapshotV1Schema.options[1],
  McpServerCatalogSnapshotV1Schema.options[2].extend({ catalog: listCatalog }),
  McpServerCatalogSnapshotV1Schema.options[3].extend({ catalog: listCatalog }),
]));
const readResult = lazyZodSchema(() => z.union([
  McpServerCatalogSnapshotV1Schema,
  z.object({ status: z.literal('present'), server: McpServerCatalogEntryV1Schema,
    bindings: z.array(McpServerRuleV1Schema), revision: catalogRevision,
    authority: z.enum(['active', 'inactive']), complete: z.boolean(), diagnostics: z.array(McpServerCatalogDiagnosticV1Schema) }).strict(),
  z.object({ status: z.literal('not-found'), serverId: identity, revision: catalogRevision }).strict(),
]));

/** Semantic requests are closed and use the one catalog revision, never item-local versions. */
export const MCP_SERVER_ACTION_INPUT_SCHEMAS_V1 = {
  'mcp.servers.list': lazyZodSchema(() => z.object({}).strict()),
  'mcp.servers.read': lazyZodSchema(() => z.object({ serverId: identity }).strict()),
  'mcp.servers.create': serverCreate,
  'mcp.servers.update': serverWrite,
  'mcp.servers.duplicate': lazyZodSchema(() => createItem.extend({ expectedRevision: catalogRevision, serverId: identity }).strict()),
  'mcp.servers.delete': lazyZodSchema(() => z.object({ expectedRevision: catalogRevision,
    serverId: identity, removeBindings: z.boolean() }).strict()),
  'mcp.servers.test': lazyZodSchema(() => z.union([
    DaemonMcpServersTestAuthoringRequestSchema.options[0].strict(), DaemonMcpServersTestAuthoringRequestSchema.options[1].strict(),
  ])),
  'mcp.servers.probe': lazyZodSchema(() => DaemonMcpServersDetectRequestSchema.strict()),
  'mcp.servers.signIn.start': lazyZodSchema(() => z.object({ serverId: identity, stepUp: z.boolean().optional() }).strict()),
} as const;
export const MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 = {
  'mcp.servers.list': listSnapshot,
  'mcp.servers.read': readResult,
  'mcp.servers.create': McpServerCatalogRowMutationResponseV1Schema,
  'mcp.servers.update': McpServerCatalogRowMutationResponseV1Schema,
  'mcp.servers.duplicate': McpServerCatalogRowMutationResponseV1Schema,
  'mcp.servers.delete': lazyZodSchema(() => z.union([McpServerCatalogRowMutationResponseV1Schema,
    McpServerCatalogRowMutationResponseV1Schema.options[0].extend({ signOut: z.union([
      z.object({ status: z.literal('revoked'), remoteStatus: z.enum(['remoteRevoked', 'remoteUnsupported', 'remoteNotAttempted']) }).strict(),
      z.object({ status: z.literal('not_connected') }).strict(),
      z.object({ status: z.literal('pending') }).strict(),
    ]) }).strict(),
  ])),
  'mcp.servers.test': DaemonMcpServersTestResponseSchema,
  'mcp.servers.probe': DaemonMcpServersDetectResponseSchema,
  'mcp.servers.signIn.start': lazyZodSchema(() => z.object({ attemptId: identity, authorizationUrl: z.url(),
    expiresAtMs: z.number().int().nonnegative(), machineId: identity }).strict()),
} as const;
export type McpServerActionRequestV1 = Readonly<{ actionId: McpServerActionIdV1 | 'mcp.rules.set'; input: unknown; context: ActionExecutorContext }>;
export type McpServerActionPortsV1 = Readonly<{
  readCatalog(context: ActionExecutorContext): Promise<McpServerCatalogSnapshotV1>;
  mutate(change: McpServerCatalogMutationV1, expectedRevision: number | 'absent', context: ActionExecutorContext): Promise<McpServerCatalogMutationResponseV1>;
  ruleWriteContext?: () => ReachRulesWriteContextV1;
  resolveAdministrationMachine?(context: ActionExecutorContext): Promise<string | null>;
  describeConnectedService?(machineId: string, context: ActionExecutorContext): Promise<unknown>;
  connectedServiceAction?: ActionExecutorDeps['connectedServiceAction'];
  machine(request: Readonly<{ actionId: 'mcp.servers.test' | 'mcp.servers.probe'; input: unknown;
    machineId: string; context: ActionExecutorContext }>): Promise<unknown>;
}>;

const catalogFailureCodes = new Set<string>([
  ...McpServerCatalogSnapshotV1Schema.options[1].shape.reason.options,
  'invalid-mutation', 'reference-conflict', 'outcome_unknown', 'server_scope_mismatch',
  'not_authenticated', 'permission_denied', 'admission_unavailable', 'invalid_action_output',
  'machine_unreachable', 'mcp_catalog_unavailable',
  'no_machine_online', 'mcp_server_not_found', 'mcp_sign_in_not_supported', 'client_refused',
  'connected_account_configuration_target_unavailable',
]);

/** Domain/transport causes can contain literal credentials; expose only owned refusal codes. */
export function projectMcpServerActionFailureV1(cause: unknown): ActionExecuteFailure {
  const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  const aborted = cause && typeof cause === 'object' && 'name' in cause && cause.name === 'AbortError';
  const errorCode = code === 'action_account_scope_changed' ? 'scope-retired' : aborted ? 'cancelled'
    : typeof code === 'string' && catalogFailureCodes.has(code) ? code : 'mcp_catalog_operation_failed';
  return { ok: false, errorCode, error: errorCode };
}

/** The shared Action adapter selects semantic operations; catalog decisions stay at its owner. */
export function createMcpServerActionExecuteV1(ports: McpServerActionPortsV1) {
  return async ({ actionId, input, context }: McpServerActionRequestV1): Promise<ActionExecuteResult> => {
    if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    const connected = async <TId extends keyof typeof connectedOutputs>(id: TId, operands: unknown, operationContext = context) => {
      if (!ports.connectedServiceAction) throw Object.assign(new Error('Connected Services unavailable'), { code: 'mcp_sign_in_not_supported' });
      const response = await ports.connectedServiceAction({ actionId: id, input: operands, context: operationContext, signal: operationContext.signal });
      if (response && typeof response === 'object' && 'ok' in response && response.ok === false) {
        throw Object.assign(new Error('Connected Services refused'), {
          code: 'errorCode' in response ? response.errorCode : 'mcp_sign_in_not_supported' });
      }
      return connectedOutputs[id].parse(response) as z.infer<(typeof connectedOutputs)[TId]>;
    };
    const describe = async (machineId: string) => {
      if (!ports.describeConnectedService) throw Object.assign(new Error('Connected Services unavailable'), { code: 'mcp_sign_in_not_supported' });
      const description = ConnectedAccountDaemonControlResponseSchema.parse(await ports.describeConnectedService(machineId, context));
      if (description.status !== 'described' || description.service.pluginId !== signInService.pluginId
        || description.service.localId !== signInService.localId || description.operationTransport?.kind !== 'v4') {
        throw Object.assign(new Error('Connected Services unavailable'), { code: 'mcp_sign_in_not_supported' });
      }
      return description;
    };
    if (actionId === 'mcp.rules.set') {
      const inputRules = McpRulesSetInputV1Schema.parse(input);
      if (inputRules.change.kind === 'replace' && inputRules.items.length !== 1) {
        return { ok: true, result: { ok: false, code: 'replace_needs_one_item' } };
      }
      const snapshot = await ports.readCatalog(context);
      if (snapshot.status !== 'ready' || snapshot.authority !== 'active') return { ok: true, result: { ok: false, code: 'catalog_unavailable' } };
      const ids = inputRules.items.map(item => 'serverId' in item ? item.serverId
        : snapshot.catalog.servers.find(server => server.name === item.name)?.id);
      if (ids.some(id => id === undefined || !snapshot.catalog.servers.some(server => server.id === id))) {
        return { ok: true, result: { ok: false, code: 'not_found' } };
      }
      const serverIds = [...new Set(ids.filter((id): id is string => id !== undefined))];
      const receipt = await ports.mutate({ kind: 'rules-change', serverIds, change: inputRules.change }, snapshot.revision, context);
      const result = receipt.status === 'updated' && receipt.items ? { ok: true, items: receipt.items, revision: receipt.revision }
        : { ok: false, code: receipt.status === 'conflict' || receipt.status === 'settings-conflict' ? 'conflict' : 'catalog_unavailable' };
      return { ok: true, result: McpRulesSetOutputV1Schema.parse(result) };
    }
    const createRules = (entryId: string, where?: z.infer<typeof ReachRulesChangeV1Schema>) => {
      const ctx = ports.ruleWriteContext?.() ?? { nowMs: Date.now(), newId: () => globalThis.crypto.randomUUID() };
      const reach = resolveCreateReachV1({ kind: 'mcp_server', caller: { surface: context.surface ?? null, sessionId: context.defaultSessionId ?? undefined }, requested: where, ctx });
      if (!reach.ok) throw new Error(reach.code);
      return reach.rules.map(rule => ({ ...rule, serverId: entryId }));
    };
    let result: unknown;
    switch (actionId) {
      case 'mcp.servers.list': {
        const snapshot = await ports.readCatalog(context);
        // Configuration stays private to the domain owner and explicit read.
        // Lists disclose metadata without guessing which literals are secrets.
        result = snapshot.status === 'ready' || snapshot.status === 'partial'
          ? { ...snapshot, catalog: { v: snapshot.catalog.v,
            servers: snapshot.catalog.servers.map(entry => serverListEntry.strip().parse(entry)),
            bindings: snapshot.catalog.bindings.map(entry => bindingListEntry.strip().parse(entry)),
          } } : snapshot;
        break;
      }
      case 'mcp.servers.read': {
        const { serverId } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        const snapshot = await ports.readCatalog(context);
        if (snapshot.status === 'loading' || snapshot.status === 'unavailable') { result = snapshot; break; }
        const server = snapshot.catalog.servers.find(entry => entry.id === serverId);
        result = server ? { status: 'present', server, bindings: snapshot.catalog.bindings.filter(binding => binding.serverId === serverId),
          revision: snapshot.revision, authority: snapshot.authority, complete: snapshot.status === 'ready', diagnostics: snapshot.diagnostics }
          : snapshot.status === 'partial' || snapshot.authority !== 'active' ? snapshot
            : { status: 'not-found', serverId, revision: snapshot.revision };
        break;
      }
      case 'mcp.servers.create': {
        const { expectedRevision, ...change } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        result = await ports.mutate('entries' in change
          ? { kind: 'server-create-batch', entries: change.entries.map(item => ({ entry: item.entry, rules: createRules(item.entry.id, item.where) })) }
          : { kind: 'server-create', entry: change.entry, rules: createRules(change.entry.id, change.where) }, expectedRevision, context);
        break;
      }
      case 'mcp.servers.update': {
        const { expectedRevision, entry, configOverrides } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        result = await ports.mutate({ kind: 'server-update', entry: configOverrides === undefined ? entry : { ...entry, configOverrides } }, expectedRevision, context);
        break;
      }
      case 'mcp.servers.duplicate': {
        const { expectedRevision, entry, serverId, where } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        result = await ports.mutate({ kind: 'server-duplicate', serverId, entry, rules: createRules(entry.id, where) }, expectedRevision, context); break;
      }
      case 'mcp.servers.delete': {
        const { expectedRevision, ...change } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        const snapshot = await ports.readCatalog(context);
        const oauth = (snapshot.status === 'ready' || snapshot.status === 'partial')
          && snapshot.catalog.servers.find(server => server.id === change.serverId)?.remote?.auth?.kind === 'oauth';
        const receipt = await ports.mutate({ kind: 'server-remove', ...change }, expectedRevision, context);
        result = receipt;
        if (receipt.status === 'updated' && oauth) {
          let signOut: { status: 'pending' } | { status: 'not_connected' }
            | { status: 'revoked'; remoteStatus: 'remoteRevoked' | 'remoteUnsupported' | 'remoteNotAttempted' } = { status: 'pending' };
          try {
            const machineId = await ports.resolveAdministrationMachine?.(context);
            if (machineId) {
              const account = { service: signInService, accountId: change.serverId };
              const description = await describe(machineId);
              const profile = description.accounts.find(profile => profile.ref.accountId === change.serverId
                && profile.ref.service.pluginId === signInService.pluginId && profile.ref.service.localId === signInService.localId);
              if (!profile) signOut = { status: 'not_connected' };
              else {
                const input = { machineId, account, cleanupGroupReferences: true,
                  ...(profile.revisionSemantics === 'revisioned' ? { expectedCredentialRevision: profile.credentialRevision } : {}) };
                const prepared = ports.connectedServiceAction?.prepareInput
                  ? await ports.connectedServiceAction.prepareInput({ actionId: 'connectedServices.accounts.revoke', input, context, signal: context.signal })
                  : input;
                const revoked = await connected('connectedServices.accounts.revoke', prepared);
                if (revoked.status === 'revoked') signOut = { status: 'revoked', remoteStatus: revoked.remoteStatus };
              }
            }
          } catch { /* The catalog ACK survives an unavailable or indeterminate revoke. */ }
          result = { ...receipt, signOut };
        }
        break;
      }
      case 'mcp.servers.signIn.start': {
        const { serverId, stepUp } = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        const snapshot = await ports.readCatalog(context);
        if (snapshot.status !== 'ready' || snapshot.authority !== 'active') {
          return { ok: false, errorCode: 'mcp_catalog_unavailable', error: 'mcp_catalog_unavailable' };
        }
        const server = snapshot.catalog.servers.find(entry => entry.id === serverId);
        if (!server) return { ok: false, errorCode: 'mcp_server_not_found', error: 'mcp_server_not_found' };
        if (!server.remote || server.remote.auth?.kind !== 'oauth') {
          return { ok: false, errorCode: 'mcp_sign_in_not_supported', error: 'mcp_sign_in_not_supported' };
        }
        const machineId = await ports.resolveAdministrationMachine?.(context);
        if (!machineId) return { ok: false, errorCode: 'no_machine_online', error: 'no_machine_online' };
        const service = await describe(machineId);
        const account = service.accounts.find(profile => profile.ref.accountId === serverId
          && profile.ref.service.pluginId === signInService.pluginId && profile.ref.service.localId === signInService.localId);
        let attempt;
        if (account) {
          const target = { kind: 'account' as const, account: account.ref };
          const previous = await connected('connectedServices.configuration.get', { machineId, target });
          const replacement = await connected('connectedServices.configuration.replace', { machineId, target,
            expectedRevision: previous.configuration.revision, values: { ...previous.configuration.values,
              serverId, resource: canonicalMcpOAuthResourceUrlV1(server.remote.url), stepUp: stepUp === true, grantedScopes: account.scopes }, secretValues: {} });
          attempt = await connected('connectedServices.authentication.beginReconnect', { machineId, account: account.ref,
            expectedConfigurationRevision: replacement.revision });
        } else {
          attempt = await connected('connectedServices.authentication.beginConnect', { machineId, service: signInService, modeId: 'oauth' });
          if (attempt.status === 'configurationRequired' && attempt.attemptId && attempt.target.kind === 'attempt') {
            const target = { kind: 'attempt' as const, attemptId: attempt.attemptId };
            const previous = await connected('connectedServices.configuration.get', { machineId, target });
            const replacement = await connected('connectedServices.configuration.replace', { machineId, target,
              expectedRevision: previous.configuration.revision, values: { ...previous.configuration.values,
                serverId, resource: canonicalMcpOAuthResourceUrlV1(server.remote.url), stepUp: stepUp === true }, secretValues: {} });
            attempt = await connected('connectedServices.authentication.continueConnect', { machineId, attemptId: attempt.attemptId,
              expectedConfigurationRevision: replacement.revision });
          }
        }
        if (attempt.status === 'starting') {
          const attemptId = attempt.attemptId;
          try {
            attempt = await connected('connectedServices.authentication.read', { machineId, attemptId, waitForProviderStart: true });
          } catch (cause) {
            if (context.signal?.aborted) {
              try {
                // Closing this new flow removes caller cancellation only; the
                // captured Account/Home owner still fences the cleanup Action.
                await connected('connectedServices.authentication.cancel', { machineId, attemptId }, { ...context, signal: undefined });
              } catch { /* Preserve the interruption if cleanup is unavailable. */ }
            }
            throw cause;
          }
        }
        if (attempt.status !== 'awaitingOAuth' || !attempt.authorizationUrl || attempt.expiresAtMs === undefined) {
          const code = 'code' in attempt && attempt.code === 'client_refused' ? 'client_refused' : 'mcp_sign_in_not_supported';
          return { ok: false, errorCode: code, error: code };
        }
        result = { attemptId: attempt.attemptId, authorizationUrl: attempt.authorizationUrl, expiresAtMs: attempt.expiresAtMs, machineId };
        break;
      }
      case 'mcp.servers.test': case 'mcp.servers.probe': {
        const payload = MCP_SERVER_ACTION_INPUT_SCHEMAS_V1[actionId].parse(input);
        result = await ports.machine({ actionId, input: payload, machineId: payload.machineId, context }); break;
      }
    }
    return { ok: true, result: MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(result) };
  };
}
