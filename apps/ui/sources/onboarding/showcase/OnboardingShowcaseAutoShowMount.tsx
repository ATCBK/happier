import { useSegments } from 'expo-router';
import * as React from 'react';

import { useAuth } from '@/auth/context/AuthContext';
import { isTeamEntryRoute } from '@/auth/routing/authRouting';
import { getCurrentReleaseId } from '@/changelog/releaseNotes/manifestRuntime';
import { setLastSeenReleaseId } from '@/changelog/releaseNotes/storage';
import { OnboardingShowcaseStorySurface } from '@/components/onboarding/showcase';
import { Modal, useModal } from '@/modal';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { useOnboardingShowcaseState } from './useOnboardingShowcaseState';

function markCurrentReleaseNotesSeen(): void {
    const releaseId = getCurrentReleaseId();
    if (releaseId) setLastSeenReleaseId(releaseId);
}

/** Shows the evergreen tour once, before auth. Existing users are silently seeded as seen. */
export function OnboardingShowcaseAutoShowMount(): null {
    const auth = useAuth();
    const showcase = useOnboardingShowcaseState();
    const modal = useModal();
    const modalStackActive = modal.state.modals.length > 0;
    // Somebody who opened a Team invitation or Team sign-in came to join that Team: the tour waits
    // for them to leave it rather than covering it.
    const teamEntryActive = isTeamEntryRoute(useSegments());
    const ranRef = React.useRef(false);

    React.useEffect(() => {
        if (ranRef.current || !showcase.hasUnread) return;
        if (auth.isAuthenticated) {
            ranRef.current = true;
            showcase.markSeen();
            return;
        }
        if (modalStackActive || teamEntryActive) return;

        const timer = setTimeout(() => {
            if (ranRef.current) return;
            ranRef.current = true;
            let modalId: string | null = null;
            const close = () => {
                if (!modalId) return;
                Modal.hide(modalId);
                modalId = null;
            };
            const markSeenAndClose = () => {
                showcase.markSeen();
                markCurrentReleaseNotesSeen();
                close();
            };

            modalId = Modal.show({
                component: OnboardingShowcaseStorySurface,
                onRequestClose: markSeenAndClose,
                props: {
                    manifest: showcase.manifest,
                    onComplete: markSeenAndClose,
                    onDismiss: markSeenAndClose,
                    // Before sign-in this keeps only the explicit authoring intent; the ordinary
                    // sign-in continuation opens the editable draft afterwards.
                    onAskHappier: () => {
                        markSeenAndClose();
                        fireAndForget(import('@/components/sessions/bots/askHappierEntry')
                            .then(({ startAskHappier }) => startAskHappier({ lifetime: null })), { tag: 'Showcase.askHappier' });
                    },
                },
            });
        }, 250);

        return () => clearTimeout(timer);
    }, [auth.isAuthenticated, modalStackActive, showcase, teamEntryActive]);

    return null;
}
