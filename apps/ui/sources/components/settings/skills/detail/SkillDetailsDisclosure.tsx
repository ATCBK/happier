import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import {
  ExpandableItem,
  ExpandableItemCaret,
} from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { t } from '@/text';

import { readSkillActionRefusal } from './useSkillDetail';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

type Execute = (
  actionId: 'skills.machine.install' | 'skills.machine.uninstall',
  input: unknown,
  operation?: Readonly<{
    presentUserConfirmation?: Readonly<{ actionId: string }>;
  }>,
) => Promise<ActionExecuteResult>;

/**
 * "Details" (sd D, closed by default): the revision, and "Also install on <machine>" for each online
 * machine (P3 `skills.machine.install/uninstall`; D1: for use outside Happier). First-party skills offer
 * no install rows (bundled content would drift from the installed Happier).
 */
export function SkillDetailsDisclosure(
  props: Readonly<{
    skillId: string;
    revision: string;
    onlineMachines: readonly Readonly<{ machineId: string; name: string }>[];
    allowInstall: boolean;
    execute: Execute;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const [installed, setInstalled] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [busy, setBusy] = React.useState<string | null>(null);

  const toggle = React.useCallback(
    async (machineId: string) => {
      setBusy(machineId);
      try {
        const removing = installed.has(machineId);
        if (removing) {
          const result = await props.execute(
            'skills.machine.uninstall',
            { skillId: props.skillId, machineId },
            {
              presentUserConfirmation: { actionId: 'skills.machine.uninstall' },
            },
          );
          if (readSkillActionRefusal(result)) {
            Modal.alert(t('common.error'), t('errors.unknownError'));
            return;
          }
        } else {
          const result = await props.execute('skills.machine.install', {
            skillId: props.skillId,
            machineId,
          });
          if (readSkillActionRefusal(result)) {
            Modal.alert(t('common.error'), t('errors.unknownError'));
            return;
          }
        }
        setInstalled((current) => {
          const next = new Set(current);
          if (removing) next.delete(machineId);
          else next.add(machineId);
          return next;
        });
      } finally {
        setBusy(null);
      }
    },
    [installed, props],
  );

  return (
    <ItemGroup header="none" testID={props.testID}>
      <ExpandableItem
        testID={`${props.testID}:disclosure`}
        expanded={open}
        onExpandedChange={setOpen}
        showDivider={false}
        header={({ headerProps, expanded }) => (
          <Item
            {...(headerProps as Readonly<Record<string, unknown>>)}
            title={t('capabilities.skillDetail.details.title')}
            leftElement={<ExpandableItemCaret expanded={expanded} />}
            rightElement={
              expanded ? null : (
                <Text variant="meta" style={styles.summary}>
                  {t('capabilities.skillDetail.details.summary')}
                </Text>
              )
            }
            showChevron={false}
          />
        )}
      >
        {open ? (
          <>
            <Item
              testID={`${props.testID}:revision`}
              title={t('capabilities.skillDetail.details.revision')}
              rightElement={
                <Text
                  variant="meta"
                  style={styles.mono}
                  selectable
                  numberOfLines={1}
                >
                  {props.revision}
                </Text>
              }
              showChevron={false}
            />
            {props.allowInstall
              ? props.onlineMachines.map((machine) => {
                  const isInstalled = installed.has(machine.machineId);
                  return (
                    <Item
                      key={machine.machineId}
                      testID={`${props.testID}:install:${machine.machineId}`}
                      title={t('capabilities.skillDetail.details.alsoInstall', {
                        machine: machine.name,
                      })}
                      subtitle={t(
                        'capabilities.skillDetail.details.alsoInstallBody',
                      )}
                      icon={
                        <Icon
                          name="desktop"
                          size={20}
                          color={theme.colors.text.secondary}
                        />
                      }
                      rightElement={
                        <RoundButton
                          size="small"
                          display="secondary"
                          loading={busy === machine.machineId}
                          disabled={busy !== null}
                          title={
                            isInstalled
                              ? t('capabilities.skillDetail.files.remove')
                              : t('capabilities.skillDetail.details.install')
                          }
                          onPress={() => {
                            void toggle(machine.machineId);
                          }}
                        />
                      }
                      showChevron={false}
                    />
                  );
                })
              : null}
          </>
        ) : null}
      </ExpandableItem>
    </ItemGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  summary: { color: theme.colors.text.secondary },
  mono: {
    ...Typography.mono(),
    color: theme.colors.text.secondary,
    maxWidth: 260,
  },
}));
