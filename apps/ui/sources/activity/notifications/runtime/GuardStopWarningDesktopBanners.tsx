import * as React from 'react';

import { isDesktopMainWindowFocused } from '@/desktop/window/desktopMainWindowPresence';
import { storage } from '@/sync/domains/state/storageStore';
import { readSessionListGuardState } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { isSessionSurfaceVisible } from '@/sync/domains/session/sessionSurfaceVisibility';
import { t } from '@/text';
import { readSessionNameIfNamed } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { sendTauriLocalNotification } from '../channels/sendTauriLocalNotification';

type Warning = Readonly<{ key: string; sessionId: string; serverId: string; stopAt: number; title: string }>;

/** Each warning is announced once on this computer (a Session's stop at one time). */
const announced = new Set<string>();

function selectWarnings(state: ReturnType<typeof storage.getState>): string {
    const warnings: Warning[] = [];
    for (const session of Object.values(state.sessions)) {
        if (!session || session.active !== true) continue;
        const guard = readSessionListGuardState(readSessionOwnerMetadataView(session)?.sessionGuardStateV1);
        if (guard?.kind !== 'stopping') continue;
        const serverId = typeof session.serverId === 'string' ? session.serverId : '';
        warnings.push({ key: `${serverId}:${session.id}:${guard.stopAt}`, sessionId: session.id, serverId, stopAt: guard.stopAt,
            title: readSessionNameIfNamed(session) ?? t('machineGuard.activity.kinds.something') });
    }
    return JSON.stringify(warnings);
}

/**
 * The guard's stop warning on the computer you are at (plan 50 GRD-7, lab `rg` G3-4): phones get the push
 * with Keep running and Stop now; a desktop gets this banner once per warning, unless the Session is
 * already open in front of you (its composer carries the countdown and Keep running).
 */
export function GuardStopWarningDesktopBanners(): null {
    const signature = storage(selectWarnings);
    React.useEffect(() => {
        const now = Date.now();
        for (const warning of JSON.parse(signature) as Warning[]) {
            if (announced.has(warning.key) || warning.stopAt <= now) continue;
            announced.add(warning.key);
            if (isSessionSurfaceVisible(warning.sessionId, warning.serverId) && isDesktopMainWindowFocused()) continue;
            const minutes = Math.max(1, Math.round((warning.stopAt - now) / 60_000));
            fireAndForget(sendTauriLocalNotification({
                title: t('machineGuard.session.bannerTitle', { title: warning.title, minutes }),
                body: t('machineGuard.session.bannerBody'),
            }), { tag: 'GuardStopWarningDesktopBanners.send' });
        }
    }, [signature]);
    return null;
}
