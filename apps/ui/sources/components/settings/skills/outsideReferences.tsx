import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const SHOWN = 3;

/** The first few paths, then how many more: the list stays short however long the skill's references run. */
function referencePaths(references: readonly string[]): string {
  const more = references.length - SHOWN;
  return more > 0
    ? `${references.slice(0, SHOWN).join(', ')} ${t('capabilities.skillAdd.outsideReferencesMore', { count: more })}`
    : references.join(', ');
}

/**
 * A skill's instructions point at relative files its bundle will not have (an advisory, never a block). On a
 * preview row it is one quiet line under the facts, through `CapabilityRow` `note`.
 */
export function skillOutsideReferencesNote(
  references: readonly string[] | undefined,
  testID: string,
): React.ReactElement | undefined {
  return references?.length ? (
    <SkillOutsideReferencesNote count={references.length} testID={testID} />
  ) : undefined;
}

function SkillOutsideReferencesNote(props: Readonly<{ count: number; testID: string }>) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.note} testID={props.testID}>
      <Icon name="link-break" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
      <Text variant="meta" style={styles.noteText}>
        {t('capabilities.skillAdd.outsideReferences', { count: props.count })}
      </Text>
    </View>
  );
}

/** The same fact on a detail: the count as the title, the paths beneath it, in the group's own row grammar. */
export function SkillOutsideReferencesItem(
  props: Readonly<{
    references: readonly string[] | undefined;
    testID: string;
  }>,
): React.ReactElement | null {
  const { theme } = useUnistyles();
  if (!props.references?.length) return null;
  return (
    <Item
      testID={props.testID}
      icon={
        <Icon
          name="link-break"
          size={ICON_SIZE.md}
          color={theme.colors.text.secondary}
        />
      }
      title={t('capabilities.skillAdd.outsideReferences', {
        count: props.references.length,
      })}
      subtitle={referencePaths(props.references)}
      subtitleStyle={styles.mono}
      showChevron={false}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minWidth: 0,
  },
  noteText: { flexShrink: 1, color: theme.colors.text.secondary },
  mono: { ...Typography.mono() },
}));
