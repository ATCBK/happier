import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalMcpOAuthResourceUrlV1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthResourceV1';
import { HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1 } from '@happier-dev/protocol/connect/qualified-connected-account-persistence';
import { SessionExecutionRunBrokerAuthorityRequestV1Schema, SessionExecutionRunBrokerAuthorityResponseV1Schema, type SessionExecutionRunBrokerAuthorityRequestV1 } from '@happier-dev/protocol/daemon/executionRuns';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { QualifiedConnectedAccountEstablishedRuntimeOwner } from '@/daemon/connectedServices/qualifiedConnectedAccountEstablishedRuntimeOwner';
import { scopeConnectedAccountPurposeBindingLease, type ConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { ConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { ensurePrivateConnectedServiceMaterializedRoot } from '@/daemon/connectedServices/materialize/privateMaterializedRoot';
import { readMcpServersSettingsFromAccountSettings } from '../servers/readMcpServersSettingsFromAccountSettings';
import { MCP_REQUEST_AUTH_PURPOSE, type McpRequestAuthCapability, type McpRequestAuthPort } from './mcpRequestAuth';

/** Captured by the authenticated daemon Session owner, never supplied by the runner. */
export type McpRequestAuthIssuanceContext = Readonly<{
  parentSessionId: string;
  materializationBaseDir: string;
  readAccountSettingsSnapshot(): ActiveAccountSettingsSnapshot | null;
  establishedOwner: Pick<QualifiedConnectedAccountEstablishedRuntimeOwner, 'readMaterialSnapshot'>;
  activatePurposeBindings: ConnectedAccountPurposeBindingOwner['activatePurposeBindings'];
  registry: ConnectedAccountRequestAuthSubjectRegistry;
  httpPort: number;
  isCurrent(): boolean;
  assertCurrent(signal: AbortSignal): Promise<void>;
  registerLifetimeCleanup?(cleanup: () => Promise<void>): (() => void) | null;
  readExecutionRunAuthority?(request: SessionExecutionRunBrokerAuthorityRequestV1, signal: AbortSignal): Promise<unknown>;
}>;

/** Issues through the incumbent purpose and capability owners; owns no registry or credential cache. */
export async function issueMcpRequestAuthCapability(
  input: Parameters<McpRequestAuthPort['open']>[0],
  context: McpRequestAuthIssuanceContext,
  signal: AbortSignal,
): Promise<McpRequestAuthCapability> {
  const resource = canonicalMcpOAuthResourceUrlV1(input.resource);
  const account = { service: HOST_CONNECTED_ACCOUNT_SERVICE_REF_V1, accountId: input.serverId };
  const validateCurrent = async (requestSignal: AbortSignal): Promise<boolean> => {
    if (!context.isCurrent() || requestSignal.aborted) return false;
    try {
      await context.assertCurrent(requestSignal);
      const server = readMcpServersSettingsFromAccountSettings(context.readAccountSettingsSnapshot()).servers.find(row => row.id === input.serverId);
      if (!server || server.transport === 'stdio' || server.remote.auth?.kind !== 'oauth'
        || canonicalMcpOAuthResourceUrlV1(server.remote.url) !== resource) return false;
      const grant = await context.establishedOwner.readMaterialSnapshot({ account, signal: requestSignal });
      const storedResource = grant.configuration?.values.resource;
      if (typeof storedResource !== 'string' || canonicalMcpOAuthResourceUrlV1(storedResource) !== resource
        || !await grant.isCurrent()) return false;
      if (input.executionRun) {
        if (!context.readExecutionRunAuthority) return false;
        const proof = SessionExecutionRunBrokerAuthorityRequestV1Schema.parse({ v: 1, executionRunId: input.executionRun.runId,
          expectedOccurrenceId: input.executionRun.occurrenceId });
        const current = SessionExecutionRunBrokerAuthorityResponseV1Schema.parse(await context.readExecutionRunAuthority(proof, requestSignal));
        if (current.status !== 'current' || current.executionRunId !== input.executionRun.runId
          || current.occurrenceId !== input.executionRun.occurrenceId || current.parentSessionId !== context.parentSessionId) return false;
      }
      await context.assertCurrent(requestSignal);
      return context.isCurrent() && !requestSignal.aborted;
    } catch { return false; }
  };
  if (!await validateCurrent(signal)) throw new Error('mcp_request_auth_not_active');
  const lease = context.activatePurposeBindings({
    subject: { kind: 'mcp_request_auth', operationId: input.materializationId, serverId: input.serverId, resource, isCurrent: context.isCurrent },
    purposes: [MCP_REQUEST_AUTH_PURPOSE],
    bindings: [{ purpose: MCP_REQUEST_AUTH_PURPOSE, target: { kind: 'account', account } }],
  });
  let root: string | null = null;
  let unregister: (() => void) | null = null;
  try {
    await ensurePrivateConnectedServiceMaterializedRoot(context.materializationBaseDir);
    root = await mkdtemp(join(context.materializationBaseDir, 'mcp-'));
    await ensurePrivateConnectedServiceMaterializedRoot(root);
    const subject = scopeConnectedAccountPurposeBindingLease({ lease, subjectId: lease.subjectId,
      parentSessionId: context.parentSessionId, validateCurrent,
      uses: [{ purpose: MCP_REQUEST_AUTH_PURPOSE, materialization: { kind: 'httpHeaders', origin: new URL(resource).origin, headerNames: ['authorization'] } }],
      // Bearers stay exclusively on the strict private request-auth response and are never logged.
      registerRedaction: () => undefined });
    const descriptor = await context.registry.activate({ subject, materializedRootDir: root,
      materializationId: input.materializationId, httpPort: context.httpPort,
      onRetire: () => { unregister?.(); lease.dispose(); },
      finalizeStagedAuthorityCommit: async (_descriptor, commit) => {
        if (!await validateCurrent(signal)) throw new Error('mcp_request_auth_not_active');
        commit();
      },
    });
    if (context.registerLifetimeCleanup) {
      unregister = context.registerLifetimeCleanup(() => context.registry.retire(descriptor, { removeMaterializedRoot: true }));
      if (!unregister) {
        await context.registry.retire(descriptor, { removeMaterializedRoot: true });
        throw new Error('mcp_request_auth_not_active');
      }
    }
    return { capabilityFile: descriptor.path, resource };
  } catch (error) {
    await lease.dispose();
    if (root) await rm(root, { recursive: true, force: true });
    throw error;
  }
}
