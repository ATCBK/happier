import * as React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/**
 * Protection and cleanup await the machine's resources policy (`MachineStorageState.status === 'policy_unavailable'`).
 * One stable, non-spinning notice for the main view and every Storage page that would otherwise read an empty
 * list as "nothing is protected" or "nothing to clear"; Try again asks the store to read the policy again.
 */
export function StoragePolicyNotice(props: Readonly<{ onRetry?: (() => void) | undefined }>) {
  return (
    <ItemGroup header="none">
      <SurfaceStateCard
        testID="machine-storage-policy-unavailable"
        kind="unavailable"
        size="line"
        title={t('machineStorage.states.policyUnavailable')}
        reason={t('machineStorage.states.policyUnavailableReason')}
        {...(props.onRetry
          ? { action: { label: t('machineStorage.tryAgain'), onPress: props.onRetry, testID: 'machine-storage-policy-retry' } }
          : {})}
      />
    </ItemGroup>
  );
}
