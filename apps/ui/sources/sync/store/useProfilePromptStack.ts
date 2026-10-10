import * as React from 'react';
import type { PromptStackIntentV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { PROFILE_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/profiles/profileActionsV1';
import { useHomeAiLaunchProfiles } from './useAiLaunchProfiles';
import { requireUpdatedProfileOperation, useAccountSettingsScope, useProfileActionExecute } from './settingsWriters';

/** Profile stack edits have one mounted owner, separate from coding and voice stacks. */
export function useProfilePromptStack(profileId: string | null | undefined) {
    const id = profileId?.trim() ?? '';
    const scope = useAccountSettingsScope();
    const profiles = useHomeAiLaunchProfiles(id ? scope : null);
    const execute = useProfileActionExecute();
    const profile = profiles.find(profile => profile.id === id);
    const available = profile !== undefined;
    const expectedRevision = profile?.profileRecordRevision ?? 'absent';
    const entries = React.useMemo(() => [...(profile?.promptStack ?? [])], [profile?.promptStack]);
    const update = React.useCallback(async (intent: PromptStackIntentV1): Promise<void> => {
        if (!id || !scope || !available) throw new Error('Profile is unavailable');
        const result = await execute({ actionId: 'launch_profiles.prompt_stack.update', input: { id, intent, expectedRevision } });
        requireUpdatedProfileOperation(PROFILE_ACTION_OUTPUT_SCHEMAS_V1['launch_profiles.prompt_stack.update'].parse(result));
    }, [id, execute, scope, expectedRevision, available]);
    return { entries, update };
}
