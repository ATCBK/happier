import * as React from 'react';
import { Platform } from 'react-native';
import type { McpServerCatalogEntryV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import {
  MCP_OAUTH_CALLBACK_URL_V1,
  MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1,
} from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { getStorage } from '@/sync/domains/state/storageStore';
import { runConnectedAccountAuthenticationAction } from '@/sync/ops/connectedAccounts/connectedAccountDaemon';
import { readMcpOAuthOpenerMessage } from '@/sync/ops/connectedAccounts/mcpOAuthCallback';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

import type { McpServerSignInFact } from '../status/mcpServerStatus';

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

/** What the Sign-in section draws (T2 states). `null`: the server does not sign in. */
export type McpSignInView =
  | Readonly<{ state: 'not_connected' }>
  | Readonly<{ state: 'starting' }>
  | Readonly<{
      state: 'signing';
      authorizationUrl: string;
      expiresAtMs: number;
    }>
  | Readonly<{ state: 'finishing'; machineName: string }>
  | Readonly<{
      state: 'connected';
      identity: string | null;
      scopes: readonly string[];
      lastUsedAt: number | null;
    }>
  | Readonly<{ state: 'needs_more_access'; tool?: string; scope?: string }>
  | Readonly<{ state: 'expired'; reason: 'expired' | 'address_changed' }>
  | Readonly<{ state: 'revoked' }>
  | Readonly<{ state: 'did_not_finish' }>
  | Readonly<{ state: 'no_machine_online' }>
  | Readonly<{ state: 'client_refused' }>;

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

function isSignInService(
  service: Readonly<{ pluginId: string; localId: string }>,
): boolean {
  return (
    service.pluginId === MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1.pluginId &&
    service.localId === MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1.localId
  );
}

type ConnectedAccountProfiles = NonNullable<
  ReturnType<ReturnType<typeof getStorage>['getState']>['profile']['connectedAccountsV4']
>;

/** The Account's sign-in grant for one MCP server (the connected-account row keyed by the server id). */
export function findMcpSignInGrant(
  profiles: ConnectedAccountProfiles | null | undefined,
  serverId: string,
): ConnectedAccountProfiles[number] | null {
  return (
    (profiles ?? []).find(
      (profile) =>
        isSignInService(profile.ref.service) &&
        profile.ref.accountId === serverId,
    ) ?? null
  );
}

/** The identity a connected grant signed in as, for "as leeroy@acme.dev". */
export function mcpSignInGrantIdentity(
  grant: ConnectedAccountProfiles[number],
): string | null {
  return (
    grant.providerIdentity?.email ??
    grant.displayName ??
    grant.providerIdentity?.accountId ??
    null
  );
}

function failureState(
  code: string | undefined,
): 'did_not_finish' | 'no_machine_online' | 'client_refused' {
  if (code === 'no_machine_online') return 'no_machine_online';
  if (code === 'client_refused') return 'client_refused';
  return 'did_not_finish';
}

function toFact(view: McpSignInView | null): McpServerSignInFact {
  if (!view) return null;
  switch (view.state) {
    case 'starting':
    case 'signing':
    case 'finishing':
      return { state: 'signing' };
    case 'expired':
      return { state: 'expired', reason: view.reason };
    case 'needs_more_access':
      return { state: 'needs_more_access' };
    default:
      return { state: view.state };
  }
}

/**
 * One OAuth MCP server's sign-in (T2): the Account's grant (synced with the profile, so every device sees
 * it land) plus this page's own attempt. Start, cancel, finish (an opener message from the callback page,
 * or a pasted answer) and sign out all go through the existing Actions; the daemon owns PKCE, state and
 * issuer checks. The grant is the truth: an attempt ends when the grant it was waiting for changes.
 */
export function useMcpServerSignIn(
  server: McpServerCatalogEntryV1,
  machines: readonly McpSignInMachine[],
): McpServerSignIn {
  const signsIn =
    server.transport !== 'stdio' && server.remote?.auth?.kind === 'oauth';
  const settingsScope = useAccountSettingsScope();
  const homeId = settingsScope?.serverId;
  const accountId = settingsScope?.accountId;
  const scope = React.useMemo(
    () => (homeId && accountId ? { serverId: homeId, accountId } : null),
    [homeId, accountId],
  );
  const execution = useMountedActionExecution(scope);
  const execute = execution.execute;
  const grant = getStorage()((state) =>
    findMcpSignInGrant(state.profile.connectedAccountsV4, server.id),
  );
  const fingerprint = grant
    ? `${grant.status}:${grant.credentialRevision ?? ''}:${grant.configurationRevision ?? ''}`
    : null;
  const [local, setLocal] = React.useState<Local>(IDLE);
  const [signingOut, setSigningOut] = React.useState(false);
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
    async (options?: Readonly<{ stepUp?: boolean }>) => {
      setLocal({ kind: 'starting' });
      const result = await execute('mcp.servers.signIn.start', {
        serverId: server.id,
        ...(options?.stepUp ? { stepUp: true } : {}),
      });
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
      await openExternalUrl(parsed.data.authorizationUrl).catch(() => false);
    },
    [execute, fingerprint, server.id],
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
      const status = result.ok
        ? (result.result as { status?: string } | null)?.status
        : undefined;
      return status === 'revoked';
    } finally {
      setSigningOut(false);
    }
  }, [execute, grant, machines]);

  const view = React.useMemo((): McpSignInView | null => {
    if (!signsIn) return null;
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
    if (grant && grant.status !== 'needs_reauth') {
      const identity = mcpSignInGrantIdentity(grant);
      return {
        state: 'connected',
        identity,
        scopes: grant.scopes ?? [],
        lastUsedAt: grant.lastUsedAt ?? null,
      };
    }
    if (!anyOnline) return { state: 'no_machine_online' };
    return grant
      ? { state: 'expired', reason: 'expired' }
      : { state: 'not_connected' };
  }, [anyOnline, grant, local, machines, signsIn]);

  const fact = React.useMemo(() => toFact(view), [view]);
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
