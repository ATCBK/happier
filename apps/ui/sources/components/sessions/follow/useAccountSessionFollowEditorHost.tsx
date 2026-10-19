import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { t } from '@/text';
import { useIsTablet } from '@/utils/platform/responsive';

import { AccountSessionFollowControl } from './AccountSessionFollowControl';
import { FollowEditorPanel } from './FollowEditorPanel';
import { openFollowNotificationSettings } from './openFollowNotificationSettings';

type FollowEditorTarget = Readonly<{ address: SessionAddress; archived?: boolean }>;

/** The three session action surfaces share presentation; the control owns all Follow state. */
export function useAccountSessionFollowEditorHost(params: Readonly<{
    serverId: string | null;
    sessionId: string;
    anchorRef?: React.RefObject<View | null>;
}>) {
    const ownAnchorRef = React.useRef<View>(null);
    const anchorRef = params.anchorRef ?? ownAnchorRef;
    const triggerRef = React.useRef<React.ComponentRef<typeof Pressable>>(null);
    const router = useRouter();
    const featureEnabled = useFeatureEnabled('sessions.following', {
        scopeKind: 'spawn',
        serverId: params.serverId ?? '',
    });
    const enabled = Boolean(params.serverId?.trim()) && featureEnabled;
    const usePopover = useIsTablet();
    const [openedTarget, setOpenedTarget] = React.useState<FollowEditorTarget | null>(null);
    const close = React.useCallback(() => setOpenedTarget(null), []);

    React.useEffect(() => {
        if (!enabled) setOpenedTarget(null);
    }, [enabled]);

    const openEditor = React.useCallback((target: FollowEditorTarget) => {
        if (!enabled || target.address.serverId !== params.serverId || target.address.sessionId !== params.sessionId) return;
        if (usePopover) {
            setOpenedTarget(target);
            return;
        }
        router.push(buildScopedSessionRouteHref({
            ...target.address,
            suffix: '/follow',
            query: { archived: target.archived === true ? '1' : undefined },
        }) as Href);
    }, [enabled, params.serverId, params.sessionId, router, usePopover]);

    const editor = openedTarget ? (
        <AccountSessionFollowControl {...openedTarget} onClose={close}
            onOpenNotificationSettings={() => {
                close();
                void openFollowNotificationSettings({
                    serverId: openedTarget.address.serverId,
                    navigate: () => router.push('/settings/notifications'),
                });
            }}
            frame={(parts) => (
                <FollowEditorPanel anchorRef={anchorRef} focusReturnRef={triggerRef} onRequestClose={close}
                    testID="account-session-follow-popover" accessibilityLabel={t('session.follow.editor.title')}
                    title={parts.title} subtitle={parts.subtitle} mark={parts.mark} footer={parts.footer}>
                    {parts.body}
                </FollowEditorPanel>
            )}
        />
    ) : null;

    return { enabled, open: openedTarget !== null, anchorRef, triggerRef, openEditor, editor };
}
