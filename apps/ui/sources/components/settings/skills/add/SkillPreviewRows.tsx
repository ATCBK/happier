import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SkillInstallPreviewV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import { CapabilityRow } from '@/components/capabilities/row/CapabilityRow';
import type { CapabilityFactsProps } from '@/components/capabilities/facts/CapabilityFacts';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { skillReferencesNote } from '../outsideReferences';

/** The preview's identity facts: where it was found, pinned. */
export function previewRef(item: SkillInstallPreviewV1): string | undefined {
  const provenance = item.provenance;
  if (provenance.kind === 'link' && provenance.ref.kind === 'gitTree')
    return provenance.ref.commit.slice(0, 7);
  if (
    provenance.kind === 'registry' &&
    provenance.registry.ref.kind === 'gitTree'
  )
    return provenance.registry.ref.commit.slice(0, 7);
  return undefined;
}

const none: ReadonlySet<string> = new Set();

/** "In your library": the one mark for a skill the library already holds (a Browse row, a held preview row). */
export function SkillInLibraryMark(props: Readonly<{ testID?: string }>) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.inLibrary} testID={props.testID}>
      <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
      <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
        {t('capabilities.skillAdd.inLibrary')}
      </Text>
    </View>
  );
}

/**
 * What a previewed skill the library already holds shows in place of a tick: the In your library mark and Open on
 * the id the Action returned (`inLibrary`). Spread into a `CapabilityRow`; nothing here decides what is held.
 */
export function heldSkillRowProps(
  held: string,
  onOpen: (skillId: string) => void,
  testID: string,
): Readonly<{ whereSummary: React.ReactElement; action: React.ReactElement }> {
  return {
    whereSummary: <SkillInLibraryMark testID={`${testID}.inLibrary`} />,
    action: (
      <RoundButton
        size="small"
        display="secondary"
        title={t('capabilities.skillAdd.open')}
        onPress={() => onOpen(held)}
        testID={`${testID}.open`}
      />
    ),
  };
}

/**
 * The skills a link or an upload found, one row each: ticked when `ticked` is given (the whole row is its checkbox),
 * with what each refers to under its facts, kept siblings first and the files that will not come along after.
 */
export function SkillPreviewRows(
  props: Readonly<{
    items: readonly SkillInstallPreviewV1[];
    ticked: ReadonlySet<string> | null;
    onToggle: (path: string) => void;
    /** A held skill's Open (its returned `inLibrary` id). */
    onOpen: (skillId: string) => void;
    facts: (item: SkillInstallPreviewV1) => CapabilityFactsProps;
    testID: string;
  }>,
) {
  const nameByPath = React.useMemo(
    () => new Map(props.items.map((item) => [item.path, item.name])),
    [props.items],
  );
  const held = React.useMemo(
    () => new Set(props.items.filter((item) => item.inLibrary !== undefined).map((item) => item.path)),
    [props.items],
  );
  const kept = props.ticked ?? new Set(props.items.filter((item) => !held.has(item.path)).map((item) => item.path));
  return (
    <>
      {props.items.map((item) => {
        const testID = `${props.testID}.item.${item.name}`;
        // Nothing of a held skill is added, so it has no tick and no references to warn about.
        if (item.inLibrary !== undefined)
          return (
            <CapabilityRow
              key={item.path}
              testID={testID}
              title={item.name}
              description={item.description}
              facts={props.facts(item)}
              {...heldSkillRowProps(item.inLibrary, props.onOpen, testID)}
            />
          );
        return (
          <CapabilityRow
            key={item.path}
            testID={testID}
            title={item.name}
            description={item.description}
            facts={props.facts(item)}
            {...(props.ticked ? { checked: props.ticked.has(item.path) } : {})}
            // A row left unticked brings no sibling along, so all it refers to counts as left behind.
            note={skillReferencesNote(item, props.ticked?.has(item.path) === false ? none : kept, nameByPath, testID, held)}
            {...(props.ticked ? { onPress: () => props.onToggle(item.path) } : {})}
          />
        );
      })}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  inLibrary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
  },
}));
