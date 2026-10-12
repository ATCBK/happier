import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useMachinesDoor } from '@/components/machines/page/machinesDoor';
import { machinePageHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useMachineResourcesPolicy } from '@/sync/domains/machines/resources/useMachineResourcesPolicy';
import { t } from '@/text';

import { describeMachineAlertsRow } from './machineAlertsPresentation';

/**
 * The Overview's Alerts row (lab `rv` O / OE): one destination that says the current state — off and what
 * turning one on gives, or the rule that is on — and opens the machine's Alerts page in the same door.
 */
export const MachineAlertsRow = React.memo(function MachineAlertsRow(
  props: Readonly<{ serverId: string; machineId: string; machineName: string }>,
) {
  const router = useRouter();
  const door = useMachinesDoor();
  const policy = useMachineResourcesPolicy({
    serverId: props.serverId,
    machineId: props.machineId,
  });
  const alerts =
    policy.status === 'ready' ? (policy.policy?.alerts ?? null) : null;
  const subtitle = describeMachineAlertsRow({
    machineName: props.machineName,
    alerts,
    readOnlyReason: policy.readOnlyReason,
  });
  return (
    <ItemGroup>
      <Item
        testID="machine-vitals-alerts-row"
        icon={<Icon name="bell" />}
        title={t('machineVitals.alerts.title')}
        subtitle={subtitle}
        subtitleLines={2}
        showChevron
        onPress={() =>
          router.push(
            machinePageHref({
              door,
              target: { machineId: props.machineId, serverId: props.serverId },
              page: 'alerts',
            }) as never,
          )
        }
      />
    </ItemGroup>
  );
});
