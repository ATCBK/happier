import * as React from 'react';

import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveTriggerEditorHref, type TriggerEditorHref } from '@/components/workflows/triggers/triggerEditorDestination';
import { AutomationApiError, getAutomationDefinition } from '@/sync/api/automations/apiAutomations';
import { readSessionRouteServerId } from '@/hooks/session/sessionRouteServerScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';

/** Old bookmarks resolve through the existing direct read; they never open another editor or write. */
export function RetiredAutomationRoute(): React.ReactElement {
    const params = useLocalSearchParams<{ id?: string; serverId?: string | string[] }>();
    const id = typeof params.id === 'string' ? params.id.trim() : '';
    const scope = useActiveServerAccountScope();
    const serverId = readSessionRouteServerId(params) ?? scope?.serverId ?? null;
    if (!id) return <Redirect href="/workflows" />;
    return <ResolveAutomation key={`${serverId}:${scope ? serverAccountScopeKeySuffix(scope) : 'unscoped'}:${id}`} id={id} serverId={serverId} />;
}

function ResolveAutomation({ id, serverId }: Readonly<{ id: string; serverId: string | null }>): React.ReactElement {
    const { binding, resolution } = useServerCredentialAccountScopeBinding(serverId);
    const [destination, setDestination] = React.useState<TriggerEditorHref | Readonly<{
        pathname: '/workflows'; params: Readonly<{ automationUnavailable: '1' }>;
    }> | null>(null);
    const [failed, setFailed] = React.useState(false);
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => {
        const lifetime = binding;
        let cancelled = false;
        const current = () => !cancelled && lifetime?.isCurrent() === true;
        setFailed(false);
        if (!lifetime) {
            if (resolution.kind !== 'resolving') setDestination({ pathname: '/workflows', params: { automationUnavailable: '1' } });
            return;
        }
        void (async () => {
            const context = await captureLazyActionAccountContext(lifetime.scope.serverId);
            try {
                if (!current()) return;
                if (!areServerAccountScopesEqual(context.accountLifetime.scope, lifetime.scope)) throw new Error('action_account_scope_changed');
                context.assertCurrent();
                const automation = await getAutomationDefinition(context.credentials, id, { request: context.request, serverId: context.serverId });
                context.assertCurrent();
                if (!current() || !areServerAccountScopesEqual(context.accountLifetime.scope, lifetime.scope)) return;
                return automation;
            } finally { context.dispose(); }
        })().then((automation) => {
            if (!current()) return;
            setDestination(automation == null
                ? { pathname: '/workflows', params: { automationUnavailable: '1' } }
                : resolveTriggerEditorHref({ automationId: id, serverId: lifetime.scope.serverId,
                    scopeSessionId: automation.scopeSessionId, workflowDefinitionId: automation.workflowDefinitionId }));
        }).catch((error: unknown) => {
            if (!current()) return;
            if (error instanceof AutomationApiError && error.status === 404) {
                setDestination({ pathname: '/workflows', params: { automationUnavailable: '1' } });
            } else setFailed(true);
        });
        return () => { cancelled = true; };
    }, [id, attempt, binding, resolution.kind]);
    if (destination !== null) return <Redirect href={destination} />;
    return <SurfaceStateCard testID="retired-automation-read" kind={failed ? 'error' : 'loading'}
        title={t(failed ? 'workflows.loadFailedTitle' : 'workflows.editor.loadingTitle')}
        {...(failed ? { reason: t('workflows.loadFailedBody'), action: {
            testID: 'retired-automation-read-retry', label: t('workflows.retry'), onPress: () => setAttempt((value) => value + 1),
        } } : {})} />;
}
