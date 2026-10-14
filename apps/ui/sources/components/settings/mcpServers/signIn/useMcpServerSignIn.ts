import * as React from 'react';
import { Platform } from 'react-native';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import {
  MCP_OAUTH_CALLBACK_URL_V1,
} from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';
import type { ConnectedAccountRevokedResponseV1Schema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/connect/configurationActionsV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { getStorage } from '@/sync/domains/state/storageStore';
import { runConnectedAccountAuthenticationAction } from '@/sync/ops/connectedAccounts/connectedAccountDaemon';
import { readMcpOAuthOpenerMessage } from '@/sync/ops/connectedAccounts/mcpOAuthCallback';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { normalizeInternalReturnPath } from '@/utils/path/routeUtils';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

import type { McpServerSignInFact } from '../status/mcpServerStatus';
import { findMcpSignInGrant, mcpSignInGrantView, mcpSignInFact, type McpSignInView } from './mcpSignInGrantView';
import { useMcpSignInGrantDiagnostics } from './useMcpSignInGrantDiagnostics';
export { findMcpSignInGrant, mcpSignInGrantIdentity, mcpSignInGrantView, mcpSignInFact, type McpSignInView } from './mcpSignInGrantView';

/** A machine as the sign-in needs it: REACH's presence and a name to say where it finishes. */
export type McpSignInMachine = Readonly<{
  machineId: string;
  name: string;
  online: boolean;
}>;

export type McpSignInCompletion = Readonly<{
  code: string;
  state: string;
  iss?: string;
}>;

export type McpServerSignIn = Readonly<{
  view: McpSignInView | null;
  /** The same state in the status owner's vocabulary (banner, rail chip). */
  fact: McpServerSignInFact;
  start: (options?: Readonly<{ stepUp?: boolean }>) => Promise<void>;
  cancel: () => Promise<void>;
  complete: (completion: McpSignInCompletion) => Promise<boolean>;
  signOut: () => Promise<boolean>;
  busy: boolean;
}>;

type Attempt = Readonly<{
  attemptId: string;
  machineId: string;
  authorizationUrl: string;
  expiresAtMs: number;
}>;
type Local =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'starting' }>
  | Readonly<{ kind: 'signing'; attempt: Attempt; baseline: string | null }>
  | Readonly<{ kind: 'finishing'; attempt: Attempt; baseline: string | null }>
  | Readonly<{
      kind: 'failed';
      state: 'did_not_finish' | 'no_machine_online' | 'client_refused';
    }>;

const IDLE: Local = { kind: 'idle' };

function failureState(
  code: string | undefined,
): 'did_not_finish' | 'no_machine_online' | 'client_refused' {
  if (code === 'no_machine_online') return 'no_machine_online';
  if (code === 'client_refused') return 'client_refused';
  return 'did_not_finish';
}

/**
 * One OAuth MCP server's sign-in (T2): the Account's grant (synced with the profile, so every device sees
 * it land) plus this page's own attempt. Start, cancel, finish (an opener message from the callback page,
 * or a pasted answer) and sign out all go through the existing Actions; the daemon owns PKCE, state and
 * issuer checks. The grant is the truth: an attempt ends when the grant it was waiting for changes.
 */
export function useMcpServerSignIn(
  server: McpServerCatalogEntryV1 | null,
  machines: readonly McpSignInMachine[],
  options?: Readonly<{ returnTo?: string; scope?: AccountSettingsScope | null }>,
): McpServerSignIn {
  const signsIn =
    server !== null && server.transport !== 'stdio' && server.remote?.auth?.kind === 'oauth';
  const activeSettingsScope = useAccountSettingsScope();
  const settingsScope = options?.scope === undefined ? activeSettingsScope : options.scope;
  const homeId = settingsScope?.serverId;
  const accountId = settingsScope?.accountId;
  const scope = React.useMemo(
    () => (homeId && accountId ? { serverId: homeId, accountId } : null),
    [homeId, accountId],
  );
  const execution = useMountedActionExecution(scope);
  const execute = execution.execute;
  const profiles = getStorage()((state) => areServerAccountScopesEqual(scope, state.profileScope) ? state.profile.connectedAccountsV4 : null);
  const grant = server ? findMcpSignInGrant(profiles, server.id) : null;
  const diagnostics = useMcpSignInGrantDiagnostics(profiles, scope, machines.find(machine => machine.online)?.machineId ?? machines[0]?.machineId ?? null);
  const fingerprint = grant
    ? `${grant.status}:${grant.credentialRevision ?? ''}:${grant.configurationRevision ?? ''}`
    : null;
  const targetKey = JSON.stringify([scope?.serverId, scope?.accountId, server?.id]);
  const currentTarget = React.useRef(targetKey);
  currentTarget.current = targetKey;
  const [localState, setLocalState] = React.useState<Readonly<{ key: string; value: Local }>>({ key: targetKey, value: IDLE });
  const local = localState.key === targetKey ? localState.value : IDLE;
  const setLocal = React.useCallback((update: React.SetStateAction<Local>) => {
    if (currentTarget.current !== targetKey) return;
    setLocalState(current => ({ key: targetKey, value: typeof update === 'function'
      ? update(current.key === targetKey ? current.value : IDLE) : update }));
  }, [targetKey]);
  const [signingOut, setSigningOut] = React.useState(false);
  const [revocation, setRevocation] = React.useState<Readonly<{
    key: string;
    receipt: ReturnType<typeof ConnectedAccountRevokedResponseV1Schema.parse>;
    credentialRevision: NonNullable<typeof grant>['credentialRevision'];
  }> | null>(null);
  const anyOnline = machines.some((machine) => machine.online);

  // An attempt ends when the grant it waited for lands (from this page, the callback page or another device).
  React.useEffect(() => {
    if (
      (local.kind === 'signing' || local.kind === 'finishing') &&
      fingerprint !== local.baseline &&
      grant?.status === 'connected'
    ) {
      setLocal(IDLE);
    }
  }, [fingerprint, grant?.status, local]);

  // The authorization link has a lifetime; past it the attempt didn't finish.
  const signingAttempt = local.kind === 'signing' ? local.attempt : null;
  React.useEffect(() => {
    if (!signingAttempt) return;
    const remaining = signingAttempt.expiresAtMs - Date.now();
    const timer = setTimeout(
      () =>
        setLocal((current) =>
          current.kind === 'signing' && current.attempt === signingAttempt
            ? { kind: 'failed', state: 'did_not_finish' }
            : current,
        ),
      Math.max(0, remaining),
    );
    return () => clearTimeout(timer);
  }, [signingAttempt]);

  const complete = React.useCallback(
    async (completion: McpSignInCompletion): Promise<boolean> => {
      if (local.kind !== 'signing' || !scope) return false;
      const { attempt, baseline } = local;
      setLocal({ kind: 'finishing', attempt, baseline });
      try {
        const response = await runConnectedAccountAuthenticationAction({
          serverId: scope.serverId,
          expectedAccountId: scope.accountId,
          machineId: attempt.machineId,
          executeAction: execute,
          command: {
            operation: 'completeOAuth',
            attemptId: attempt.attemptId,
            completion: {
              code: completion.code,
              state: completion.state,
              callbackUrl: MCP_OAUTH_CALLBACK_URL_V1,
              ...(completion.iss === undefined ? {} : { iss: completion.iss }),
            },
          },
        });
        if (response.status === 'connected') return true;
        setLocal({ kind: 'failed', state: 'did_not_finish' });
        return false;
      } catch {
        setLocal({ kind: 'failed', state: 'did_not_finish' });
        return false;
      }
    },
    [execute, local, scope],
  );

  // The callback page hands the answer back to the page that opened it, from app.happier.dev only.
  const completeRef = React.useRef(complete);
  completeRef.current = complete;
  const listening = local.kind === 'signing' ? local.attempt.attemptId : null;
  React.useEffect(() => {
    if (!listening || Platform.OS !== 'web') return;
    const target = globalThis as unknown as {
      addEventListener?: Window['addEventListener'];
      removeEventListener?: Window['removeEventListener'];
    };
    if (!target.addEventListener) return;
    const onMessage = (event: MessageEvent) => {
      const message = readMcpOAuthOpenerMessage(event);
      if (
        !message ||
        message.state.slice(0, message.state.lastIndexOf('.')) !== listening
      )
        return;
      void completeRef.current(message);
    };
    target.addEventListener('message', onMessage);
    return () => target.removeEventListener?.('message', onMessage);
  }, [listening]);

  const start = React.useCallback(
    async (startOptions?: Readonly<{ stepUp?: boolean }>) => {
      if (!server || !scope) return;
      setLocal({ kind: 'starting' });
      const result = await execute('mcp.servers.signIn.start', {
        serverId: server.id,
        ...(startOptions?.stepUp ? { stepUp: true } : {}),
      });
      if (currentTarget.current !== targetKey || !execution.isCurrent()) return;
      if (!result.ok) {
        setLocal({ kind: 'failed', state: failureState(result.errorCode) });
        return;
      }
      const parsed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1[
        'mcp.servers.signIn.start'
      ].safeParse(result.result);
      if (!parsed.success) {
        setLocal({ kind: 'failed', state: 'did_not_finish' });
        return;
      }
      setLocal({
        kind: 'signing',
        attempt: parsed.data,
        baseline: fingerprint,
      });
      const returnTo = normalizeInternalReturnPath(options?.returnTo);
      if (returnTo) {
        // Reuse the generic external-connect continuation; OAuth state remains daemon-owned.
        const retained = await TokenStorage.setPendingExternalConnect({ provider: `mcp:${parsed.data.attemptId}`,
          returnTo, serverId: scope.serverId, serverUrl: getServerProfileById(scope.serverId)?.serverUrl });
        if (!retained) { setLocal({ kind: 'failed', state: 'did_not_finish' }); return; }
      }
      await openExternalUrl(parsed.data.authorizationUrl).catch(() => false);
    },
    [execute, execution.isCurrent, fingerprint, server, scope, options?.returnTo, targetKey, setLocal],
  );

  const cancel = React.useCallback(async () => {
    const attempt = local.kind === 'signing' ? local.attempt : null;
    setLocal(IDLE);
    if (!attempt || !scope) return;
    await runConnectedAccountAuthenticationAction({
      serverId: scope.serverId,
      expectedAccountId: scope.accountId,
      machineId: attempt.machineId,
      executeAction: execute,
      command: { operation: 'cancel', attemptId: attempt.attemptId },
    }).catch(() => undefined);
  }, [execute, local, scope]);

  const signOut = React.useCallback(async (): Promise<boolean> => {
    const machine = machines.find((candidate) => candidate.online);
    if (!grant || !machine) return false;
    setSigningOut(true);
    try {
      const result = await execute('connectedServices.accounts.revoke', {
        machineId: machine.machineId,
        account: grant.ref,
        cleanupGroupReferences: true,
        ...(grant.revisionSemantics === 'revisioned'
          ? { expectedCredentialRevision: grant.credentialRevision }
          : {}),
      }, { presentUserConfirmation: { actionId: 'connectedServices.accounts.revoke' } });
      const revoked = result.ok ? CONNECTED_SERVICE_CONFIGURATION_ACTION_OUTPUT_SCHEMAS_V1['connectedServices.accounts.revoke'].safeParse(result.result) : null;
      if (!revoked?.success || revoked.data.status !== 'revoked' || revoked.data.account.accountId !== grant.ref.accountId
        || revoked.data.account.service.pluginId !== grant.ref.service.pluginId || revoked.data.account.service.localId !== grant.ref.service.localId) return false;
      setRevocation({ key: targetKey, receipt: revoked.data, credentialRevision: grant.credentialRevision });
      return true;
    } finally {
      setSigningOut(false);
    }
  }, [execute, grant, machines, targetKey]);

  const view = React.useMemo((): McpSignInView | null => {
    if (!signsIn || !server) return null;
    switch (local.kind) {
      case 'starting':
        return { state: 'starting' };
      case 'signing':
        return {
          state: 'signing',
          authorizationUrl: local.attempt.authorizationUrl,
          expiresAtMs: local.attempt.expiresAtMs,
        };
      case 'finishing':
        return {
          state: 'finishing',
          machineName:
            machines.find(
              (machine) => machine.machineId === local.attempt.machineId,
            )?.name ?? local.attempt.machineId,
        };
      case 'failed':
        return { state: local.state };
      case 'idle':
        break;
    }
    return mcpSignInGrantView(server, grant, anyOnline, {
      ...diagnostics[server.id],
      ...(revocation?.key === targetKey && (!grant || grant.credentialRevision === revocation.credentialRevision) ? { revoked: revocation.receipt } : {}),
    });
  }, [anyOnline, diagnostics, grant, local, machines, revocation, server, signsIn, targetKey]);

  const fact = React.useMemo(() => mcpSignInFact(view), [view]);
  return {
    view,
    fact,
    start,
    cancel,
    complete,
    signOut,
    busy: local.kind === 'starting' || signingOut,
  };
}
