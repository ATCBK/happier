import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SkillInstallPreviewV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

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

/** The previewed skill's references that no kept sibling brings along: the only ones left to warn about. */
export function remainingOutsideReferences(
  item: Pick<SkillInstallPreviewV1, 'outsideReferences' | 'siblingSkills'>,
  included: ReadonlySet<string>,
): readonly string[] {
  const covered = new Set(
    (item.siblingSkills ?? [])
      .filter((sibling) => included.has(sibling.path))
      .flatMap((sibling) => sibling.references),
  );
  return (item.outsideReferences ?? []).filter((reference) => !covered.has(reference));
}

/**
 * A previewed skill's instructions point at other files: the siblings the person keeps ("Also adds X, which Y refers
 * to") and the relative files its bundle will not have (an advisory, never a block). On a preview row it is quiet
 * lines under the facts, through `CapabilityRow` `note`.
 */
export function skillReferencesNote(
  item: Pick<SkillInstallPreviewV1, 'name' | 'outsideReferences' | 'siblingSkills'>,
  included: ReadonlySet<string>,
  nameByPath: ReadonlyMap<string, string>,
  testID: string,
): React.ReactElement | undefined {
  const siblings = (item.siblingSkills ?? []).filter((sibling) => included.has(sibling.path));
  const remaining = remainingOutsideReferences(item, included);
  if (siblings.length === 0 && remaining.length === 0) return undefined;
  return (
    <View style={styles.notes}>
      {siblings.map((sibling) => (
        <SkillAlsoAddsNote
          key={sibling.path}
          skill={item.name}
          name={nameByPath.get(sibling.path) ?? sibling.path}
          testID={`${testID}.sibling.${sibling.path}`}
        />
      ))}
      {remaining.length > 0 ? (
        <SkillOutsideReferencesNote count={remaining.length} testID={`${testID}.outsideReferences`} />
      ) : null}
    </View>
  );
}

/** "Also adds <name>, which <skill> refers to": the one line that says why a sibling comes along. */
export function SkillAlsoAddsNote(props: Readonly<{ name: string; skill: string; testID: string }>) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.note} testID={props.testID}>
      <Icon name="plus-circle" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
      <Text variant="meta" style={styles.noteText}>
        {t('capabilities.skillAdd.alsoAdds', { name: props.name, skill: props.skill })}
      </Text>
    </View>
  );
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
  notes: { gap: theme.space.s4, minWidth: 0 },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minWidth: 0,
  },
  noteText: { flexShrink: 1, color: theme.colors.text.secondary },
  mono: { ...Typography.mono() },
}));
