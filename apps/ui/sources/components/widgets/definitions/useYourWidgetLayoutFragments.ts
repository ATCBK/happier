import * as React from 'react';
import type { WidgetLayoutFragmentSummaryV1 } from '@happier-dev/protocol/widgets';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { t } from '@/text';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { createWidgetArtifactWriteAttempt, runWidgetDefinitionCommand, type WidgetCommandTarget } from './widgetDefinitionCommands';
import type { AccountInventoryStatus } from './useYourWidgetCandidates';

const EMPTY_FRAGMENTS: readonly WidgetLayoutFragmentSummaryV1[] = Object.freeze([]);

/** Mount only for an open group-capable Gallery; summaries never read executable child bodies. */
export function useYourWidgetLayoutFragments(account: WidgetCommandTarget | null): Readonly<{
    fragments: readonly WidgetLayoutFragmentSummaryV1[];
    /** Loading until the Account's saved groups have been read (ready without an Account); a refused read is failed. */
    status: AccountInventoryStatus;
    retry: () => void;
    actionsFor: (fragment: WidgetLayoutFragmentSummaryV1) => ItemAction[];
}> {
    const [inventory, setInventory] = React.useState<Readonly<{
        serverId: string; accountId: string; fragments: readonly WidgetLayoutFragmentSummaryV1[];
    }> | null>(null);
    const serverId = account?.serverId;
    const accountId = account?.accountId;
    const scope = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [accountId, serverId]);
    // Several Gallery entries can each hold an unresolved copy; one cannot replace another's id.
    const duplicateAttempts = React.useMemo(() => new Map<string, ReturnType<typeof createWidgetArtifactWriteAttempt<'widgets.fragment.duplicate'>>>(), [scope]);
    const [reload, refresh] = React.useReducer((value: number) => value + 1, 0);
    // A refused first read of this Account; a refused refresh keeps the groups already shown.
    const [refused, setRefused] = React.useState<WidgetCommandTarget | null>(null);
    const mountedAccount = React.useRef<WidgetCommandTarget | null>(null);
    React.useEffect(() => {
        if (!scope) { setInventory(null); setRefused(null); return; }
        const controller = new AbortController();
        mountedAccount.current = scope;
        setRefused(null);
        void (async () => {
            const listed = await runWidgetDefinitionCommand('widgets.fragment.list', { account: scope }, scope, controller.signal);
            if (controller.signal.aborted) return;
            if (listed.kind === 'applied') setInventory({ ...scope, fragments: listed.result.fragments });
            else setRefused(scope);
        })();
        return () => { controller.abort(); if (mountedAccount.current === scope) mountedAccount.current = null; };
    }, [reload, scope]);
    const manage = React.useCallback(async (fragment: WidgetLayoutFragmentSummaryV1, intent: 'rename' | 'duplicate' | 'delete') => {
        const artifactId = fragment.artifactId;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!scope || mountedAccount.current !== scope || !lifetime?.isCurrent()
            || !areServerAccountScopesEqual(lifetime.scope, scope)) return;
        // Refreshing the list must not cancel another acknowledged management intent.
        const controller = new AbortController();
        const { signal } = controller;
        const cancellation = lifetime.onRetire(() => controller.abort());
        const current = () => !signal.aborted && lifetime.isCurrent() && mountedAccount.current === scope;
        const notify = (outcome: Readonly<{ kind: 'approvalPending' }> | Readonly<{ kind: 'refused'; errorCode: string }>) => {
            if (!current()) return;
            if (outcome.kind === 'approvalPending') {
                publishPresentationNotice({
                    key: `widget-fragment:${serverAccountScopeKeySuffix(scope)}:${artifactId}:${intent}`,
                    severity: 'info',
                    message: `${t(`common.${intent}`)} · ${fragment.name} · ${t('approvals.waitingForYou')}`,
                });
            } else Modal.alert(t('common.error'),
                resolveActionExecutionFailureMessage({ ok: false, errorCode: outcome.errorCode }, t('errors.operationFailed'))
                    ?? t('errors.operationFailed'));
        };
        try {
            if (!current()) return;
            if (intent === 'delete') {
                // The canonical Action's Account approval policy owns destructive confirmation.
                const deleted = await runWidgetDefinitionCommand('widgets.fragment.delete', { account: scope, artifactId }, scope, signal);
                if (!current()) return;
                if (deleted.kind === 'applied') refresh();
                else notify(deleted);
                return;
            }
            if (intent === 'duplicate') {
                // The Action owns the copy's name/default and its independent Artifact identity.
                let attempt = duplicateAttempts.get(artifactId);
                if (!attempt) {
                    attempt = createWidgetArtifactWriteAttempt('widgets.fragment.duplicate', scope);
                    duplicateAttempts.set(artifactId, attempt);
                }
                const copied = await attempt.run(() => ({ account: scope, artifactId, newArtifactId: randomUUID() }), signal);
                if (!current()) return;
                // An accepted approval owns its prepared copy. A later Duplicate is another intent,
                // including after that request is rejected; only uncertain failures stay here.
                if (copied.kind !== 'refused' && duplicateAttempts.get(artifactId) === attempt) duplicateAttempts.delete(artifactId);
                if (copied.kind === 'applied') {
                    refresh();
                }
                else notify(copied);
                return;
            }
            const name = fragment.name;
            const answer = await Modal.prompt(t('common.rename'), undefined, {
                defaultValue: name, placeholder: t('widgetDefinition.name'), confirmText: t('common.save'), cancelText: t('common.cancel'),
            });
            const nextName = answer?.trim();
            if (!current() || !nextName || nextName === name) return;
            setInventory(previous => previous && areServerAccountScopesEqual(previous, scope)
                ? { ...previous, fragments: previous.fragments.map(entry => entry.artifactId === artifactId ? { ...entry, name: nextName } : entry) }
                : previous);
            // This patch stays on the Fragment port; its Artifact CAS/retry owns revisions.
            const renamed = await runWidgetDefinitionCommand('widgets.fragment.update',
                { account: scope, artifactId, patch: { name: nextName } }, scope, signal);
            if (!current()) return;
            if (renamed.kind === 'applied') refresh();
            else if (renamed.kind === 'refused') {
                // Roll back only this proposal; a newer rename or another Account must remain intact.
                setInventory(previous => previous && areServerAccountScopesEqual(previous, scope)
                    ? { ...previous, fragments: previous.fragments.map(entry => entry.artifactId === artifactId && entry.name === nextName
                        ? { ...entry, name } : entry) } : previous);
                notify(renamed);
            } else notify(renamed);
        } finally { cancellation.dispose(); }
    }, [duplicateAttempts, scope]);
    const actionsFor = React.useCallback((fragment: WidgetLayoutFragmentSummaryV1): ItemAction[] => [
        { id: 'rename', title: t('common.rename'), icon: 'pencil-simple', onPress: () => { void manage(fragment, 'rename'); } },
        { id: 'duplicate', title: t('common.duplicate'), icon: 'copy', onPress: () => { void manage(fragment, 'duplicate'); } },
        { id: 'delete', title: t('common.delete'), icon: 'trash', destructive: true, onPress: () => { void manage(fragment, 'delete'); } },
    ], [manage]);
    const current = inventory !== null && inventory.serverId === serverId && inventory.accountId === accountId;
    const status: AccountInventoryStatus = current || scope === null ? 'ready' : refused === scope ? 'failed' : 'loading';
    return { fragments: current ? inventory.fragments : EMPTY_FRAGMENTS, status, retry: refresh, actionsFor };
}
