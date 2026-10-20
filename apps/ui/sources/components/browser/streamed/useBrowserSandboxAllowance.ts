import * as React from 'react';

import type { BrowserSandboxInstallOutcome } from '@/sync/domains/browser/firstUse/browserFirstUse';
import { t } from '@/text';

export type BrowserSandboxAllowance =
    | Readonly<{ kind: 'idle' }>
    | Readonly<{ kind: 'working' }>
    | Readonly<{ kind: 'settled'; outcome: BrowserSandboxInstallOutcome }>;

/**
 * Pressing "Allow the browser sandbox": idle, then working, then settled with the typed outcome.
 * A declined approval leaves the control as it was. The Session Browser's prerequisite card and an
 * approval's sandbox row both use it, so one press means one thing wherever it is offered.
 */
export function useBrowserSandboxAllowance(
    onAllow: (() => Promise<BrowserSandboxInstallOutcome | null>) | undefined,
): Readonly<{ allowance: BrowserSandboxAllowance; allow: (() => Promise<void>) | undefined }> {
    const [allowance, setAllowance] = React.useState<BrowserSandboxAllowance>({ kind: 'idle' });
    const mountedRef = React.useRef(true);
    React.useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);
    const allow = React.useCallback(async () => {
        if (!onAllow) return;
        setAllowance({ kind: 'working' });
        let outcome: BrowserSandboxInstallOutcome | null;
        try {
            outcome = await onAllow();
        } catch {
            outcome = { status: 'failed', code: 'request_failed' };
        }
        if (mountedRef.current) setAllowance(outcome ? { kind: 'settled', outcome } : { kind: 'idle' });
    }, [onAllow]);
    return { allowance, allow: onAllow ? allow : undefined };
}

/** What a settled allowance says, in the words both surfaces share. `agentName` adds who the browser is for. */
export function describeBrowserSandboxAllowance(
    outcome: BrowserSandboxInstallOutcome,
    agentName?: string,
): Readonly<{ kind: 'success' | 'warning' | 'error'; title: string; reason: string; code: string }> {
    if (outcome.status === 'installed') {
        return { kind: 'success', title: t('browserPresence.stream.sandboxAllowedTitle'),
            reason: agentName ? t('browserPresence.stream.sandboxAllowedBody', { agent: agentName }) : '', code: '' };
    }
    const needsPermission = outcome.code === 'os_authorization_required';
    return needsPermission
        ? { kind: 'warning', title: t('browserPresence.stream.sandboxPermissionTitle'),
            reason: t('browserPresence.stream.sandboxPermissionBody'), code: outcome.code }
        : { kind: 'error', title: t('browserPresence.stream.installFailedTitle'),
            reason: t('browserPresence.stream.sandboxFailedBody'), code: outcome.code };
}
