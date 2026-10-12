import { useHomeAiLaunchProfileCatalog } from '@/sync/store/useAiLaunchProfiles';
import { isProfilePromptStackKnown } from '@/sync/store/useProfilePromptStack';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';

/** `/settings/prompts/stacks/profiles`: each profile with how many prompts and skills it adds. */
export const PromptProfileStacksScreen = React.memo(() => {
  const router = useRouter();
  const { profiles, hasCompleteData, status, stale } = useHomeAiLaunchProfileCatalog(useAccountSettingsScope());
  const hasReadableContent = profiles.length > 0 || hasCompleteData;

  return (
    <ItemList>
      <SettingsPageHeader description={t('promptLibrary.surface.profileStacksPageDescription')} />
      <ItemGroup title={t('promptLibrary.surface.profilesSection')}>
        {!hasCompleteData || status !== 'ready' || stale ? (
          hasReadableContent ? (
            <SurfaceFreshnessLine testID="promptStacks.profiles.freshness" busy={status === 'loading'}
              reason={t(status === 'loading' ? 'common.loading' : 'common.error')} />
          ) : (
            <SurfaceStateCard testID="promptStacks.profiles.readState" size="line"
              kind={status === 'loading' ? 'loading' : 'unavailable'}
              title={t(status === 'loading' ? 'common.loading' : 'common.error')} />
          )
        ) : null}
        {profiles.map((profile) => {
          const profileId = profile.id;
          const count = isProfilePromptStackKnown(profile, hasCompleteData) ? (profile.promptStack ?? []).length : undefined;
          return (
            <Item
              key={profileId}
              testID={`promptStacks.profile.${profileId}`}
              icon={<Icon name="user-circle" />}
              title={profile.name || profileId}
              detail={count === undefined ? undefined : t('promptLibrary.profileStackCount', { count })}
              onPress={() => router.push(`/settings/prompts/stacks/profiles/${encodeURIComponent(profileId)}`)}
            />
          );
        })}

        {hasCompleteData && profiles.length === 0 ? (
          <Item
            testID="promptStacks.profiles.empty"
            title={t('promptLibrary.noProfilesTitle')}
            subtitle={t('promptLibrary.noProfilesSubtitle')}
            mode="info"
            showChevron={false}
          />
        ) : null}
      </ItemGroup>
    </ItemList>
  );
});

PromptProfileStacksScreen.displayName = 'PromptProfileStacksScreen';
