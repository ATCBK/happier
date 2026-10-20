import * as React from 'react';

import { Modal } from '@/modal';
import { t } from '@/text';
import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { requireUpdatedProfileOperation } from '@/sync/store/settingsWriters';
import type { ProfileRemovalResult } from '@happier-dev/protocol/profiles/profileOperations';
import type { AiLaunchProfileSourceV1 } from '@happier-dev/protocol/profiles/read';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

type ReviewedProfile = AIBackendProfile & Pick<AiLaunchProfileSourceV1, 'profileRecordRevision'>;

export function useNewSessionProfileActions(params: Readonly<{
    setSelectedProfileId: React.Dispatch<React.SetStateAction<string | null>>;
    selectedProfileId: string | null;
    deleteProfile: (profileId: string, expectedRevision?: number) => Promise<ProfileRemovalResult>;
}>): Readonly<{
    onPressDefaultEnvironment: () => void;
    handleDeleteProfile: (profile: ReviewedProfile) => Promise<void>;
}> {
    const onPressDefaultEnvironment = React.useCallback(() => {
        params.setSelectedProfileId(null);
    }, [params.setSelectedProfileId]);

    const handleDeleteProfile = React.useCallback(async (profile: ReviewedProfile) => {
        try {
            const result = await params.deleteProfile(profile.id, profile.profileRecordRevision);
            requireUpdatedProfileOperation(result);
            params.setSelectedProfileId(current => current === profile.id ? null : current);
            if (result.status === 'updated' && result.authoringMemoryCleanup) {
                Modal.alert(t('common.error'), result.authoringMemoryCleanup.reason);
            }
        } catch (error) {
            if (error !== null && typeof error === 'object' && 'code' in error && isActionApprovalDeclinedErrorCode(error.code)) return;
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.error'));
        }
    }, [params.deleteProfile, params.setSelectedProfileId]);

    return {
        onPressDefaultEnvironment,
        handleDeleteProfile,
    };
}
