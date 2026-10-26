import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
import * as React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { ConstrainedScreenContent } from '@/components/ui/layout/ConstrainedScreenContent';
import { Text } from '@/components/ui/text/Text';
import {
    resolveExecutionRunLauncherIntent,
    type ExecutionRunIntent,
} from '@/components/sessions/runs/launcher/executionRunLauncherModel';
import { buildScopedSessionRouteHref, createSessionRouteServerScope } from '@/hooks/session/sessionRouteServerScope';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { isSessionRouteHydrationAvailable, isSessionRouteHydrationMissing } from '@/sync/domains/session/sessionRouteHydrationState';
import { t } from '@/text';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SessionInteractiveExecutionRunDraftView } from '@/components/sessions/runs/launcher/SessionInteractiveExecutionRunDraftView';
import {
    consumeInteractiveExecutionRunDraftNavigationIntent,
    readInteractiveExecutionRunDraftNavigationIntent,
} from '@/components/sessions/runs/launcher/interactiveExecutionRunDraftNavigationIntent';

function readSingleRouteParam(value: string | string[] | undefined): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    const normalized = raw?.trim() ?? '';
    return normalized.length > 0 ? normalized : null;
}

function InteractiveExecutionRunDraftRoute(props: Readonly<{
    sessionId: string;
    serverId: string | null;
    draftCorrelationId: string | null;
    intent: ExecutionRunIntent | null;
    roleId: string | null;
    onRunStarted: (runId: string, recovery?: Readonly<{ retryInputLocalId: string }>) => void;
}>) {
    const navigationIntent = React.useMemo(() => props.serverId && props.draftCorrelationId
        ? readInteractiveExecutionRunDraftNavigationIntent({
            address: { serverId: props.serverId, sessionId: props.sessionId },
            correlationId: props.draftCorrelationId,
        })
        : null, [props.draftCorrelationId, props.serverId, props.sessionId]);
    React.useEffect(() => {
        if (!navigationIntent || !props.serverId || !props.draftCorrelationId) return;
        consumeInteractiveExecutionRunDraftNavigationIntent({
            address: { serverId: props.serverId, sessionId: props.sessionId },
            correlationId: props.draftCorrelationId,
        });
    }, [navigationIntent, props.draftCorrelationId, props.serverId, props.sessionId]);
    return (
        <SessionInteractiveExecutionRunDraftView
            sessionId={props.sessionId}
            serverId={props.serverId}
            intent={props.intent}
            roleId={props.roleId}
            placement="center"
            initialText={navigationIntent?.initialText}
            launchOrigin={navigationIntent?.source}
            onRunStarted={props.onRunStarted}
        />
    );
}

export function SessionNewRunScreen() {
    const { theme } = useUnistyles();
    const router = useRouter();
    const params = useLocalSearchParams<{ id?: string | string[]; serverId?: string | string[]; intent?: string | string[]; roleId?: string | string[]; draftCorrelationId?: string | string[] }>();
    const routeScope = React.useMemo(() => createSessionRouteServerScope(params as Record<string, unknown>), [params]);
    const sessionId = normalizeSessionId(params.id);
    const routeHydrationState = useHydrateSessionForRoute(sessionId, 'SessionNewRunScreen.hydrate', routeScope.hydrationOptions);
    const hydrateReady = isSessionRouteHydrationAvailable(routeHydrationState);
    const exactSessionServerId = routeHydrationState.serverId ?? routeScope.serverId;
    const rawIntent = params.intent;
    const hasIntentParam = rawIntent !== undefined;
    const initialIntent = resolveExecutionRunLauncherIntent(rawIntent);
    const draftCorrelationId = readSingleRouteParam(params.draftCorrelationId);
    // A start that begins with a role (Second opinion: a review by `second_opinion`).
    const roleId = readSingleRouteParam(params.roleId);

    const screenOptions = React.useMemo(() => ({
        headerShown: true,
        title: initialIntent
            ? t(`executionRuns.newRun.intents.${initialIntent}` as const)
            : t('session.subagents.panel.newAgentConversation'),
        headerBackTitle: t('common.back'),
    }), [initialIntent]);

    const unavailable = !sessionId || isSessionRouteHydrationMissing(routeHydrationState);

    if (hasIntentParam && initialIntent === null) {
        return (
            <View style={{ flex: 1, padding: theme.space.s16, backgroundColor: theme.colors.surface.base }}>
                <Stack.Screen options={screenOptions} />
                <Text style={{ color: theme.colors.text.secondary }}>{t('errors.invalidFormat')}</Text>
            </View>
        );
    }

    return (
        <View style={{ flex: 1, backgroundColor: theme.colors.surface.base }}>
            <Stack.Screen options={screenOptions} />
            <ConstrainedScreenContent
                style={{
                    flex: 1,
                    paddingVertical: theme.space.s16,
                    gap: theme.space.s16,
                }}
            >
                {unavailable ? (
                    <Text style={{ color: theme.colors.text.primary, paddingHorizontal: theme.space.s16 }}>{t('errors.sessionDeleted')}</Text>
                ) : !hydrateReady ? (
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                ) : (
                    <InteractiveExecutionRunDraftRoute
                        key={JSON.stringify([
                            exactSessionServerId
                                ? sessionAddressKey({ serverId: exactSessionServerId, sessionId })
                                : null,
                            draftCorrelationId ?? null,
                            initialIntent,
                            roleId,
                        ])}
                        sessionId={sessionId}
                        serverId={exactSessionServerId}
                        draftCorrelationId={draftCorrelationId}
                        intent={initialIntent}
                        roleId={roleId}
                        onRunStarted={(runId, recovery) => {
                            router.replace(buildScopedSessionRouteHref({
                                sessionId,
                                serverId: exactSessionServerId,
                                suffix: `/runs/${encodeURIComponent(runId)}`,
                                query: recovery ? { retryInputLocalId: recovery.retryInputLocalId } : undefined,
                            }));
                        }}
                    />
                )}
            </ConstrainedScreenContent>
        </View>
    );
}

export { SessionNewRunScreen as WorkspaceRouteBody };

export default function RouteEntry() { return <WorkspaceRouteEntry Body={SessionNewRunScreen} />; }
