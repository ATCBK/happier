import type { ReactElement } from 'react';

import { useOptionalHappierUiPalette, useOptionalHappierUiTypography } from '../environment/context.js';
import { HAPPIER_RADIUS_V1 } from '../environment/radius.js';
import { HAPPIER_SPACE_STEPS } from '../environment/spacing.js';
import {
  HappierMemoryDuplicateChoice,
  type HappierMemoryDuplicateCandidate,
  type HappierMemoryDuplicateChoiceControlProps,
  type HappierMemoryDuplicateChoiceKind,
  type HappierMemoryDuplicateChoiceTextProps,
} from '../presentation/content/MemoryDuplicateChoice.js';
import { HappierSegmentedChoice } from '../presentation/form/SegmentedChoice.js';
import { HappierText } from '../presentation/text/Text.js';
import { resolveHappierTypeRoleStyle } from '../presentation/text/typeRole.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';

export type MemoryDuplicateChoiceKind = HappierMemoryDuplicateChoiceKind;
export type MemoryDuplicateCandidate = HappierMemoryDuplicateCandidate;

export type MemoryDuplicateChoiceProps = Readonly<{
  testID: string;
  /** The saved facts like the new one, closest first; the author owns the search that found them. */
  candidates: readonly MemoryDuplicateCandidate[];
  newText: string;
  candidateId: string | null;
  onCandidateChange: (id: string) => void;
  choice: MemoryDuplicateChoiceKind;
  onChoiceChange: (choice: MemoryDuplicateChoiceKind) => void;
  /** Opens the author's own view of a saved fact; the author keeps the draft and choice meanwhile. */
  onViewCandidate?: (id: string) => void;
  disabled?: boolean;
}>;

const KEY = 'happier.plugin-ui.memoryDuplicate';

/**
 * The duplicate comparison core shows before saving a fact like a saved one. The author passes the
 * candidates and holds the choice; the save itself (and its effect) goes through the author's Action.
 */
export function MemoryDuplicateChoice(props: MemoryDuplicateChoiceProps): ReactElement {
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme);
  const translate = usePluginTranslation();
  const many = props.candidates.length > 1;
  return <HappierMemoryDuplicateChoice {...props} Text={ChoiceText} Choice={ChoiceControl}
    style={{ padding: HAPPIER_SPACE_STEPS.s12, borderRadius: HAPPIER_RADIUS_V1.lg, backgroundColor: palette?.inset ?? theme.colors.elevatedSurface }}
    colors={{ chosen: palette?.navigationSelected ?? theme.colors.surface, hover: palette?.navigationHover ?? theme.colors.surface }}
    radius={HAPPIER_RADIUS_V1.md}
    labels={{
      title: many
        ? translate(`${KEY}.titleMany`, `This memory already has ${props.candidates.length} similar facts`, { count: props.candidates.length })
        : translate(`${KEY}.title`, 'This memory already has something similar'),
      saved: translate(`${KEY}.saved`, 'Saved'),
      new: translate(`${KEY}.new`, 'New'),
      choice: translate(`${KEY}.choice`, 'With the saved fact'),
      options: {
        update: translate(`${KEY}.update`, 'Update it'),
        replace: translate(`${KEY}.replace`, 'Replace it'),
        keep_both: translate(`${KEY}.keepBoth`, 'Keep both'),
      },
      effects: {
        update: translate(`${KEY}.updateHint`, 'Corrects the saved fact. Its source and approval stay.'),
        replace: translate(`${KEY}.replaceHint`, 'The saved fact moves to history. Agents only see the new one.'),
        keep_both: translate(`${KEY}.keepBothHint`, 'Saves the new fact next to the saved one.'),
      },
      view: translate(`${KEY}.view`, 'View'),
    }} />;
}

const ROLE = { title: 'label', label: 'meta', text: 'body', meta: 'micro', effect: 'meta', action: 'micro' } as const;

function ChoiceText(props: HappierMemoryDuplicateChoiceTextProps): ReactElement {
  const theme = usePluginTheme();
  const typography = useOptionalHappierUiTypography();
  const color = props.role === 'title' || props.role === 'text'
    ? props.retired ? theme.colors.mutedText : theme.colors.text
    : props.role === 'label' || props.role === 'meta' ? theme.colors.mutedText : theme.colors.secondaryText;
  const weight = props.role === 'title' || props.role === 'action' ? 'semiBold' : undefined;
  return <HappierText testID={props.testID} numberOfLines={props.numberOfLines} accessibilityRole={props.accessibilityRole}
    style={[
      resolveHappierTypeRoleStyle(ROLE[props.role], theme, typography, weight),
      { color },
      props.retired ? { textDecorationLine: 'line-through' } : null,
    ]}>{props.children}</HappierText>;
}

function ChoiceControl(props: HappierMemoryDuplicateChoiceControlProps): ReactElement {
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme);
  return <HappierSegmentedChoice
    accessibilityLabel={props.accessibilityLabel}
    segments={props.options.map((option) => ({
      key: option.id, label: option.label, selected: option.id === props.value, disabled: props.disabled,
      testID: `${props.testIDPrefix}:${option.id}`,
    }))}
    onSelect={(index) => {
      const option = props.options[index];
      if (option && option.id !== props.value) props.onChange(option.id);
    }}
    disabled={props.disabled}
    colors={{
      track: palette?.segmentTrack ?? theme.colors.surface,
      thumb: palette?.segmentThumb ?? theme.colors.elevatedSurface,
      thumbLift: palette?.segmentThumbLift,
      label: theme.colors.secondaryText,
      activeLabel: theme.colors.text,
      focusRing: theme.colors.focus,
    }} />;
}
