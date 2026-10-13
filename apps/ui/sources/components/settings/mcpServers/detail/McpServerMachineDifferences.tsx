import * as React from 'react';
import type {
  McpServerCatalogEntryV1,
  McpServerConfigOverrideV1,
} from '@happier-dev/protocol/mcp/servers/settingsV1';
import { reachPlaceKeyV1 } from '@happier-dev/protocol/reach/reachPlaceV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import {
  ExpandableItem,
  ExpandableItemCaret,
} from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

/** What one machine's override changes, in the words of the Configuration rows. */
function describeOverride(override: McpServerConfigOverrideV1): string {
  const parts: string[] = [];
  if (override.stdio?.command)
    parts.push(t('capabilities.mcp.config.differsCommand'));
  if (override.stdio?.args)
    parts.push(t('capabilities.mcp.config.differsArguments'));
  if (override.stdio?.cwd)
    parts.push(
      t('capabilities.mcp.config.differsFolder', {
        path: override.stdio.cwd.path,
      }),
    );
  if (override.remote?.url)
    parts.push(t('capabilities.mcp.config.differsAddress'));
  const names = [
    ...Object.keys(override.envPatch ?? {}),
    ...Object.keys(override.remote?.headersPatch ?? {}),
  ];
  if (names.length > 0)
    parts.push(
      t('capabilities.mcp.config.differsValues', { names: names.join(', ') }),
    );
  return parts.join(' · ');
}

/**
 * "Different on a machine…" (T5): the machines whose values differ from the Configuration above. Closed,
 * it names them; open, each is one row with what differs. A 0.2 folder override reads "In <folder> on
 * <machine>" with Remove only. Removing commits like any Configuration edit.
 */
export const McpServerMachineDifferences = React.memo(
  function McpServerMachineDifferences(
    props: Readonly<{
      server: McpServerCatalogEntryV1;
      machineName: (machineId: string) => string;
      onChangeServer: (
        updater: (current: McpServerCatalogEntryV1) => McpServerCatalogEntryV1,
      ) => void;
      onCommit: () => void;
    }>,
  ) {
    const { theme } = useUnistyles();
    const overrides = props.server.configOverrides ?? [];
    const [expanded, setExpanded] = React.useState(false);
    if (overrides.length === 0) return null;
    const names = overrides.map((override) =>
      props.machineName(override.target.machineId),
    );
    const summary =
      overrides.length === 1
        ? t('capabilities.mcp.config.differentOne', { machine: names[0]! })
        : t('capabilities.mcp.config.differentCount', {
            count: overrides.length,
          });

    const remove = (override: McpServerConfigOverrideV1) => {
      const key = reachPlaceKeyV1(override.target);
      props.onChangeServer((current) => ({
        ...current,
        configOverrides: (current.configOverrides ?? []).filter(
          (item) => reachPlaceKeyV1(item.target) !== key,
        ),
        updatedAt: Date.now(),
      }));
      props.onCommit();
    };

    return (
      <ItemGroup header="none" testID="mcp.server.differences">
        <ExpandableItem
          testID="mcp.server.differences.toggle"
          expanded={expanded}
          onExpandedChange={setExpanded}
          header={({ headerProps, expanded: open }) => (
            <Item
              {...(headerProps as Readonly<Record<string, unknown>>)}
              title={t('capabilities.mcp.config.different')}
              leftElement={<ExpandableItemCaret expanded={open} />}
              detail={summary}
              showChevron={false}
            />
          )}
        >
          {overrides.map((override, index) => {
            const machine = props.machineName(override.target.machineId);
            const title =
              override.target.t === 'workspace'
                ? t('capabilities.mcp.config.inFolderOn', {
                    folder: override.target.workspaceRoot,
                    machine,
                  })
                : machine;
            return (
              <Item
                key={reachPlaceKeyV1(override.target)}
                testID={`mcp.server.differences.row.${index}`}
                title={title}
                subtitle={describeOverride(override) || undefined}
                icon={
                  <Icon
                    name="desktop"
                    size={20}
                    color={theme.colors.text.secondary}
                  />
                }
                showChevron={false}
                rightElement={
                  <RoundButton
                    testID={`mcp.server.differences.row.${index}.remove`}
                    size="small"
                    display="inverted"
                    title={t('capabilities.mcp.config.removeDifference')}
                    onPress={() => remove(override)}
                  />
                }
              />
            );
          })}
        </ExpandableItem>
      </ItemGroup>
    );
  },
);
