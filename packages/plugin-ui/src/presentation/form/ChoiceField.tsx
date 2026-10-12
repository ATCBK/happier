import { useEffect, useState } from 'react';
import { View } from 'react-native';

import {
  resolveHappierUiPalette,
  useOptionalHappierUiLocalization,
  useOptionalHappierUiPalette,
} from '../../environment/context.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE } from '../interaction/focusVisible.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { settleHappierRaisedEdge } from '../layout/raisedEdge.js';
import { HappierScrollArea } from '../layout/Layout.js';
import { HappierText } from '../text/Text.js';
import { useHappierTypeRoleStyle } from '../text/typeRole.js';
import {
  HappierFieldBoxChevron,
  HappierFieldBoxTrigger,
  resolveHappierFieldBoxLabel,
} from './FieldBox.js';
import {
  planHappierSelectOptions,
  type HappierSelectOption,
} from './Fields.js';

/**
 * About seven rows: a Home with dozens of machines keeps its open field inside the step instead of
 * pushing the preview and the footer away; the rows scroll in place.
 */
const CHOICE_LIST_MAX_HEIGHT = 224;

/** The choice rows' own inset and the gap between the trigger and its rows. */
const CHOICE_ROW_PADDING = Object.freeze({ horizontal: 10, vertical: 6 });

/**
 * One fixed choice that is not a few short options: a field box that names the current reading
 * ("All agents", "Claude", "3 selected") and opens its choices as quiet rows beneath it. The same
 * plan as `HappierSelect` decides what is selected, disabled and what a press emits; only the
 * presentation differs, so a long or multiple choice stays one calm row until it is opened.
 *
 * The choices open in place, not in a floating layer, so the field works in an Action card, a
 * Workflow composer and a widget's setup step alike.
 */
export function HappierChoiceField<Value = string>(
  props: Readonly<{
    label: string;
    options: readonly HappierSelectOption<Value>[];
    value: Value | readonly Value[] | undefined;
    multiple?: boolean;
    maxSelections?: number;
    minimumSelections?: number;
    required?: boolean;
    disabled?: boolean;
    /** The reading while nothing is chosen ("All agents"); the shared "Choose…" when absent. */
    placeholder?: string;
    /**
     * A value the options cannot name (a period, a date range) is read here by the host. With
     * `onOpen` the field is a plain trigger for the type's own picker and draws no rows of its own.
     */
    reading?: string;
    onOpen?: () => void;
    /** Each new positive value shows the rows now; a host's repair or keyboard hand-off. */
    openRequest?: number;
    isEqual?: (left: Value, right: Value) => boolean;
    keyForOption?: (
      option: HappierSelectOption<Value>,
      index: number,
    ) => string;
    onChange: (value: Value | readonly Value[]) => void;
    theme: HappierUiTheme;
    testID?: string;
  }>,
) {
  const { theme } = props;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (props.openRequest) setOpen(true);
  }, [props.openRequest]);
  const palette =
    useOptionalHappierUiPalette(theme) ?? resolveHappierUiPalette(theme);
  const localization = useOptionalHappierUiLocalization();
  const labelStyle = useHappierTypeRoleStyle('label', theme);
  const captionStyle = useHappierTypeRoleStyle('micro', theme);
  const plan = planHappierSelectOptions(props);
  const chosen = plan.options.filter((entry) => entry.selected);
  // One choice is named; several are counted, so the trigger stays one line.
  const summary =
    props.reading !== undefined && props.reading !== ''
      ? props.reading
      : chosen.length === 0
        ? null
        : chosen.length === 1
          ? chosen[0]!.option.label
          : (localization?.translate(
              'happier.plugin-ui.select.count',
              `${chosen.length} selected`,
              { count: chosen.length },
            ) ?? `${chosen.length} selected`);
  const placeholder =
    props.placeholder ??
    localization?.translate('happier.plugin-ui.select.choose', 'Choose…') ??
    'Choose…';
  const reading = resolveHappierFieldBoxLabel({
    // A declared empty reading ("All agents") is a valid answer, not an unmade choice, so it keeps value ink.
    value:
      summary ?? (props.placeholder === undefined ? null : props.placeholder),
    placeholder,
    colors: {
      valueColor: theme.colors.text,
      placeholderColor: palette.placeholder,
    },
  });
  const disabled = props.disabled === true;
  return (
    <View style={{ gap: theme.spacing.small, alignSelf: 'stretch' }}>
      <HappierPressable
        testID={
          props.testID === undefined
            ? undefined
            : props.onOpen
              ? props.testID
              : `${props.testID}.trigger`
        }
        accessibilityRole="button"
        accessibilityLabel={`${props.label}: ${summary ?? placeholder}`}
        disabled={disabled}
        onPress={() => {
          if (props.onOpen) props.onOpen();
          else setOpen((current) => !current);
        }}
        style={{ alignSelf: 'stretch', ...HAPPIER_FOCUS_RING_DELEGATED_STYLE }}
      >
        {(state) => (
          <HappierFieldBoxTrigger
            span="column"
            colors={{
              borderColor: palette.controlBorder,
              focusRing: state.focused ? theme.colors.focus : null,
              backgroundColor: palette.fieldBackground,
              edge: settleHappierRaisedEdge(palette.controlEdge, {
                focused: state.focused,
              }),
            }}
            trailing={
              <HappierFieldBoxChevron
                open={open}
                color={theme.colors.secondaryText}
              />
            }
          >
            <HappierText
              accessible={false}
              numberOfLines={1}
              style={reading.style}
            >
              {reading.text}
            </HappierText>
          </HappierFieldBoxTrigger>
        )}
      </HappierPressable>
      {open && props.onOpen === undefined ? (
        <View
          role={props.multiple ? 'group' : 'radiogroup'}
          accessibilityLabel={props.label}
          testID={props.testID}
          style={{ gap: 2 }}
        >
          <HappierScrollArea style={{ maxHeight: CHOICE_LIST_MAX_HEIGHT }}>
          {plan.options.map((entry) => (
            <HappierPressable
              key={entry.key}
              testID={entry.option.testID}
              accessibilityRole={props.multiple ? 'checkbox' : 'radio'}
              accessibilityLabel={
                entry.option.accessibilityLabel ??
                (entry.option.description
                  ? `${entry.option.label}: ${entry.option.description}`
                  : entry.option.label)
              }
              checked={entry.selected}
              disabled={entry.disabled}
              onPress={() => {
                props.onChange(entry.nextValue());
                // A single choice settles the field; several stay open for the next pick.
                if (!props.multiple) setOpen(false);
              }}
              style={(state) => ({
                paddingHorizontal: CHOICE_ROW_PADDING.horizontal,
                paddingVertical: CHOICE_ROW_PADDING.vertical,
                borderRadius: theme.radii.control,
                backgroundColor:
                  entry.selected || state.hovered
                    ? palette.fieldBackground
                    : 'transparent',
                opacity: entry.disabled ? 0.4 : 1,
              })}
            >
              <HappierText
                numberOfLines={1}
                style={{
                  ...labelStyle,
                  color: entry.selected
                    ? theme.colors.text
                    : theme.colors.secondaryText,
                }}
              >
                {entry.option.label}
              </HappierText>
              {entry.option.description ? (
                <HappierText
                  numberOfLines={1}
                  style={{ ...captionStyle, color: theme.colors.secondaryText }}
                >
                  {entry.option.description}
                </HappierText>
              ) : null}
            </HappierPressable>
          ))}
          </HappierScrollArea>
        </View>
      ) : null}
    </View>
  );
}
