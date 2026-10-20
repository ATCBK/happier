import type {
    BrowserRuntimeAutomationAdapter,
    BrowserRuntimeDiagnosticsAdapter,
    BrowserRuntimeControlAdapter,
    BrowserRuntimeWorkspaceOpeningAdapter,
} from './runtimeActionExecutor';
import { serverAccountScopedResourceKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

type BrowserRuntimeControlRegistrationToken = Readonly<{
    id: symbol;
}>;

type BrowserRuntimeControlRegistration = Readonly<{
    token: BrowserRuntimeControlRegistrationToken;
    control: BrowserRuntimeControlAdapter;
    automation?: BrowserRuntimeAutomationAdapter;
    diagnostics?: BrowserRuntimeDiagnosticsAdapter;
}>;

export type BrowserRuntimeControlAdapterRegistration = Readonly<{
    browserSessionId: string;
    control: BrowserRuntimeControlAdapter;
    automation?: BrowserRuntimeAutomationAdapter | null | undefined;
    diagnostics?: BrowserRuntimeDiagnosticsAdapter | null | undefined;
}>;

const registrationsBySessionId = new Map<string, BrowserRuntimeControlRegistration[]>();
// Workspace presentation is registered here with the other Browser runtime owners. It does not
// register a view or create control state; Account qualification prevents same-id Home collisions.
const workspaceOpeners = new Map<string, BrowserRuntimeWorkspaceOpeningAdapter[]>();

export function registerBrowserRuntimeWorkspaceOpeningAdapter(owner: BrowserRuntimeWorkspaceOpeningAdapter): () => void {
    const lifetime = owner.accountLifetime;
    if (!lifetime?.isCurrent()) return () => {};
    const key = serverAccountScopedResourceKey(lifetime.scope, owner.scopeId);
    workspaceOpeners.set(key, [...(workspaceOpeners.get(key) ?? []), owner]);
    const dispose = () => {
        const remaining = (workspaceOpeners.get(key) ?? []).filter(candidate => candidate !== owner);
        if (remaining.length) workspaceOpeners.set(key, remaining);
        else workspaceOpeners.delete(key);
    };
    const retirement = lifetime.onRetire(dispose);
    return () => { retirement.dispose(); dispose(); };
}

// A UI caller's open request is fulfilled by that caller's own opener, which records where in the
// pane layout Details was opened from. An Agent or external caller has no opener of its own and is
// served by the scope's most recently mounted one.
const claimedWorkspaceOpenCommands = new Map<string, BrowserRuntimeWorkspaceOpeningAdapter>();

function workspaceOpenCommandKey(scope: ServerAccountScope, scopeId: string, commandId: string): string {
    return JSON.stringify([serverAccountScopedResourceKey(scope, scopeId), commandId]);
}

/** Routes one open command, for its duration, to the opener that issued it. */
export function claimBrowserRuntimeWorkspaceOpenCommand(
    owner: BrowserRuntimeWorkspaceOpeningAdapter,
    commandId: string,
): () => void {
    const lifetime = owner.accountLifetime;
    if (!lifetime?.isCurrent()) return () => {};
    const key = workspaceOpenCommandKey(lifetime.scope, owner.scopeId, commandId);
    claimedWorkspaceOpenCommands.set(key, owner);
    return () => {
        if (claimedWorkspaceOpenCommands.get(key) === owner) claimedWorkspaceOpenCommands.delete(key);
    };
}

export function readRegisteredBrowserRuntimeWorkspaceOpeningAdapter(
    scope: ServerAccountScope,
    scopeId: string,
    commandId?: string,
): BrowserRuntimeWorkspaceOpeningAdapter | null {
    const claimed = commandId ? claimedWorkspaceOpenCommands.get(workspaceOpenCommandKey(scope, scopeId, commandId)) : undefined;
    if (claimed?.accountLifetime?.isCurrent()) return claimed;
    const owners = workspaceOpeners.get(serverAccountScopedResourceKey(scope, scopeId)) ?? [];
    for (let index = owners.length - 1; index >= 0; index--) {
        if (owners[index].accountLifetime?.isCurrent()) return owners[index];
    }
    return null;
}

function normalizeBrowserSessionId(browserSessionId: string): string {
    return browserSessionId.trim();
}

export function registerBrowserRuntimeControlAdapter(
    input: BrowserRuntimeControlAdapterRegistration,
): () => void {
    const browserSessionId = normalizeBrowserSessionId(input.browserSessionId);
    if (!browserSessionId) {
        return () => {};
    }

    const token = { id: Symbol(browserSessionId) };
    const registrations = registrationsBySessionId.get(browserSessionId) ?? [];
    registrations.push({
        token,
        control: input.control,
        ...(input.automation ? { automation: input.automation } : {}),
        ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    });
    registrationsBySessionId.set(browserSessionId, registrations);

    return () => {
        const current = registrationsBySessionId.get(browserSessionId);
        if (!current) return;
        const remaining = current.filter(registration => registration.token !== token);
        if (remaining.length) registrationsBySessionId.set(browserSessionId, remaining);
        else registrationsBySessionId.delete(browserSessionId);
    };
}

function readRegistration(browserSessionId: string, viewId?: string): BrowserRuntimeControlRegistration | null {
    const sessionId = normalizeBrowserSessionId(browserSessionId);
    const registrations = registrationsBySessionId.get(sessionId) ?? [];
    // A Session can have several mounted tabs. Resolve an existing view at its actual host;
    // registration order only selects the host for a new view, or a relocated copy of one view.
    for (let index = registrations.length - 1; index >= 0; index--) {
        const registration = registrations[index];
        if (!viewId || registration.control.readState()?.viewsById[viewId]?.browserSessionId === sessionId) return registration;
    }
    return null;
}

export function readRegisteredBrowserRuntimeControlAdapter(
    browserSessionId: string,
    viewId?: string,
): BrowserRuntimeControlAdapter | null {
    return readRegistration(browserSessionId, viewId)?.control ?? null;
}

export function readRegisteredBrowserRuntimeAutomationAdapter(
    browserSessionId: string,
    viewId?: string,
): BrowserRuntimeAutomationAdapter | null {
    return readRegistration(browserSessionId, viewId)?.automation ?? null;
}

export function readRegisteredBrowserRuntimeDiagnosticsAdapter(browserSessionId: string, viewId: string): BrowserRuntimeDiagnosticsAdapter | null {
    return readRegistration(browserSessionId, viewId)?.diagnostics ?? null;
}

export function clearBrowserRuntimeControlRegistryForTests(): void {
    registrationsBySessionId.clear();
    workspaceOpeners.clear();
    claimedWorkspaceOpenCommands.clear();
}
