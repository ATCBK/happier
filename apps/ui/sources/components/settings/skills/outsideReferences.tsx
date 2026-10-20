import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { readSiblingSkillPathsV1 } from '@happier-dev/protocol/prompts/library/skills/skillReferencesV1';
import type { SkillInstallPreviewV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

const SHOWN = 3;
const none: ReadonlySet<string> = new Set();

/** The first few paths, then how many more: the list stays short however long the skill's references run. */
function referencePaths(references: readonly string[]): string {
  const more = references.length - SHOWN;
  return more > 0
    ? `${references.slice(0, SHOWN).join(', ')} ${t('capabilities.skillAdd.outsideReferencesMore', { count: more })}`
    : references.join(', ');
}

/**
 * The previewed skill's references that no sibling brings along: the only ones left to warn about. A sibling is
 * covered when it is kept (`included`) or the library already holds it (`held`, previewed paths with `inLibrary`).
 */
export function remainingOutsideReferences(
  item: Pick<SkillInstallPreviewV1, 'path' | 'outsideReferences' | 'siblingSkills'>,
  included: ReadonlySet<string>,
  held: ReadonlySet<string> = none,
): readonly string[] {
  const covered = new Set(
    (item.siblingSkills ?? [])
      .filter((sibling) => included.has(sibling.path))
      .flatMap((sibling) => sibling.references),
  );
  return (item.outsideReferences ?? []).filter(
    (reference) =>
      !covered.has(reference) &&
      !readSiblingSkillPathsV1(item.path, [reference]).some((path) => held.has(path)),
  );
}

/** "Also adds <name>, which it refers to": the one line that says why a sibling comes along. */
export function SkillAlsoAddsNote(props: Readonly<{ name: string; testID: string }>) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.note} testID={props.testID}>
      <Icon name="plus-circle" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
      <Text variant="meta" style={styles.noteText}>
        {t('capabilities.skillAdd.alsoAdds', { name: props.name })}
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
