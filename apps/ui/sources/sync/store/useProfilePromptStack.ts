import * as React from 'react';
import type { PromptStackIntentV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { PROFILE_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/profiles/profileActionsV1';
import type { AiLaunchProfile } from '@happier-dev/protocol/profiles/read';
import { useHomeAiLaunchProfileCatalog } from './useAiLaunchProfiles';
import { requireUpdatedProfileOperation, useAccountSettingsScope, useProfileActionExecute } from './settingsWriters';

/** A shared definition carries no private Context; only complete inventory proves membership absence. */
export function isProfilePromptStackKnown(profile: AiLaunchProfile | undefined, hasCompleteData: boolean): boolean {
    return profile !== undefined && (profile.promptStack !== undefined || hasCompleteData);
}

/** Profile stack edits have one mounted owner, separate from coding and voice stacks. */
export function useProfilePromptStack(profileId: string | null | undefined) {
    const id = profileId?.trim() ?? '';
    const scope = useAccountSettingsScope();
    const catalog = useHomeAiLaunchProfileCatalog(id ? scope : null);
    const execute = useProfileActionExecute();
    const profile = catalog.profiles.find(profile => profile.id === id);
    const available = isProfilePromptStackKnown(profile, catalog.hasCompleteData);
    const canUpdate = Boolean(id && scope && available && catalog.status === 'ready' && catalog.source === 'destination');
    const expectedRevision = profile?.profileRecordRevision ?? 'absent';
    const entries = React.useMemo(() => [...(profile?.promptStack ?? [])], [profile?.promptStack]);
    const update = React.useCallback(async (intent: PromptStackIntentV1): Promise<void> => {
        if (!canUpdate) throw new Error('Profile is unavailable');
        const result = await execute({ actionId: 'launch_profiles.prompt_stack.update', input: { id, intent, expectedRevision } });
        requireUpdatedProfileOperation(PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.prompt_stack.update'].parse(result));
    }, [id, execute, expectedRevision, canUpdate]);
    return { entries, update, canUpdate, available, status: catalog.status, stale: catalog.stale };
}
