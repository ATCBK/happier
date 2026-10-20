import type { ReactElement } from 'react';
import { StyleSheet, View } from 'react-native';

import { useHappierColumnEdgeRemainder } from '../presentation/layout/columnEdge.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';
import { HappierText } from '../presentation/text/Text.js';
import { Select } from './Form.js';
import { Item, ItemGroup } from './List.js';
import { SettingRow } from './Setting.js';
import {
  usePluginTheme,
  usePluginTranslation,
  type PluginTranslate,
} from './PluginUiProvider.js';

/**
 * How one followed event reaches the person: it interrupts (push), arrives quietly (Inbox), or is left out.
 * For a Session receiver the same two channels read Wake and Next turn.
 */
export type FollowPolicyEditorDelivery = 'interrupt' | 'quiet' | 'off';

/**
 * One event row. `id` is the canonical event: `needs_you.decision`, `needs_you.approval`,
 * `needs_you.blocked`, `finished`, `failed_or_stopped`, `stalled`, `update_posted`, `person_wrote`,
 * `goal_changed` or `message`. The editor names each one; hosts and plugins pass ids, never copy.
 */
export type FollowPolicyEditorEvent = Readonly<{
  id: string;
  delivery: FollowPolicyEditorDelivery;
}>;

/** Who hears the followed events: a `person` (Push, Inbox; the default) or a `session` (Wake, Next turn). */
export type FollowPolicyEditorReceiver = 'person' | 'session';

export type FollowPolicyEditorProps = Readonly<{
  /** Names the two delivery channels the way this receiver gets them; defaults to `person`. */
  receiver?: FollowPolicyEditorReceiver;
  /** `everything`, `important`, `quiet` or `custom`. */
  preset: string;
  presets: readonly string[];
  events: readonly FollowPolicyEditorEvent[];
  onSelectPreset: (preset: string) => void;
  /** Custom only: one event's delivery. */
  onSetDelivery: (
    eventId: string,
    delivery: FollowPolicyEditorDelivery,
  ) => void;
  disabled?: boolean;
  testID?: string;
}>;

const KEY = 'happier.plugin-ui.follow';

const PRESET_LABELS: Readonly<Record<string, string>> = {
  everything: 'Everything',
  important: 'Important',
  quiet: 'Quiet',
  custom: 'Custom',
};
const PERSON_COPY = {
  presetLabel: 'How much you hear',
  presetDescriptions: {
    everything:
      'Interrupts you whenever something happens. Messages arrive quietly in Inbox.',
    important:
      'Interrupts you only when it needs you, fails or stalls. Everything else waits quietly in Inbox.',
    quiet: 'Nothing interrupts you. Updates wait quietly in Inbox.',
    custom:
      'Choose what interrupts you, what arrives quietly and what is left out.',
  },
  groups: {
    interrupt: { title: 'Interrupts you', channel: 'Push' },
    quiet: { title: 'Arrives quietly', channel: 'Inbox' },
  },
  deliveries: { quiet: 'Inbox', interrupt: 'Push' },
} as const;
const SESSION_COPY = {
  presetLabel: 'How much it hears',
  presetDescriptions: {
    everything:
      'Wakes it whenever something happens. Messages wait for its next turn.',
    important:
      'Wakes it only when something needs it, fails or stalls. Everything else waits for its next turn.',
    quiet: 'Nothing wakes it. Updates wait for its next turn.',
    custom:
      'Choose what wakes it, what waits for its next turn and what is left out.',
  },
  groups: {
    interrupt: { title: 'Wakes it', channel: 'Wake' },
    quiet: { title: 'Waits for its next turn', channel: 'Next turn' },
  },
  deliveries: { quiet: 'Next turn', interrupt: 'Wake' },
} as const;
const EVENT_LABELS: Readonly<Record<string, string>> = {
  needs_you: 'Needs you',
  'needs_you.decision': 'Needs a decision',
  'needs_you.approval': 'Needs approval',
  'needs_you.blocked': 'Blocked',
  finished: 'Finished',
  failed_or_stopped: 'Failed or stopped',
  stalled: 'Stalled',
  update_posted: 'Update posted',
  person_wrote: 'A person wrote in it',
  goal_changed: 'Goal changed',
  message: 'Every message',
};
const EVENT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  needs_you: 'A decision, an approval, or it’s blocked',
  failed_or_stopped: 'Also when a run ends without a word',
  person_wrote: 'A notice and a link, never their words',
};
const DELIVERIES = [
  'off',
  'quiet',
  'interrupt',
] as const satisfies readonly FollowPolicyEditorDelivery[];
const GROUP_DELIVERIES = ['interrupt', 'quiet'] as const;

function eventLabel(translate: PluginTranslate, id: string): string {
  return translate(`${KEY}.event.${id}`, EVENT_LABELS[id] ?? id);
}
function eventDescription(
  translate: PluginTranslate,
  id: string,
): string | undefined {
  const fallback = EVENT_DESCRIPTIONS[id];
  return fallback === undefined
    ? undefined
    : translate(`${KEY}.eventDescription.${id}`, fallback);
}

/** A preset's rows: the three needs-you kinds read as one "Needs you" row when they arrive the same way. */
function presetRows(
  events: readonly FollowPolicyEditorEvent[],
): FollowPolicyEditorEvent[] {
  const needsYou = events.filter((event) => event.id.startsWith('needs_you.'));
  const together =
    needsYou.length > 1 &&
    needsYou.every((event) => event.delivery === needsYou[0]!.delivery);
  const rows: FollowPolicyEditorEvent[] = [];
  for (const event of events) {
    if (together && event.id.startsWith('needs_you.')) {
      if (event === needsYou[0])
        rows.push({ id: 'needs_you', delivery: event.delivery });
    } else rows.push(event);
  }
  return rows;
}

/**
 * The one Follow policy editor (C1 §4.3, lab P2): the four presets, what the chosen one means, and the
 * events it covers grouped by how they reach you; Custom gives each event its own Off · Inbox · Push.
 * Core's personal Follow, Session sources, rules and plugins bind the same editor; it holds no state and
 * writes nothing — the caller's Follow owner applies each choice.
 */
export function FollowPolicyEditor(
  props: FollowPolicyEditorProps,
): ReactElement {
  const translate = usePluginTranslation();
  const theme = usePluginTheme();
  const testID = props.testID ?? 'follow-policy-editor';
  const custom = props.preset === 'custom';
  // A Session receiver has its own words for the channels; each has its own host translation keys.
  const session = props.receiver === 'session';
  const copy = session ? SESSION_COPY : PERSON_COPY;
  const copyKey = session ? `${KEY}.session` : KEY;
  const presetLabel = translate(`${copyKey}.presetLabel`, copy.presetLabel);
  const rows = custom ? props.events : presetRows(props.events);
  const deliveryOptions = DELIVERIES.map((delivery) => ({
    value: delivery,
    label: delivery === 'off'
      ? translate(`${KEY}.delivery.off`, 'Off')
      : translate(`${copyKey}.delivery.${delivery}`, copy.deliveries[delivery]),
  }));
  const off = rows.filter((row) => row.delivery === 'off');
  // The presets and the Not-included line stand on the sheets' edge; a column that already draws it adds none.
  const edgePx = useHappierColumnEdgeRemainder(HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx);
  return (
    <View testID={testID} style={styles.root}>
      <View style={[styles.presets, { paddingHorizontal: edgePx }]}>
        <Select
          label={presetLabel}
          presentation="segmented"
          fill
          options={props.presets.map((preset) => ({
            value: preset,
            label: translate(
              `${KEY}.preset.${preset}`,
              PRESET_LABELS[preset] ?? preset,
            ),
            testID: `${testID}.preset.${preset}`,
          }))}
          value={props.preset}
          disabled={props.disabled}
          onChange={(value) => {
            if (typeof value === 'string') props.onSelectPreset(value);
          }}
          testID={`${testID}.presets`}
        />
        <HappierText
          variant="body"
          style={{ color: theme.colors.secondaryText }}
          testID={`${testID}.description`}
        >
          {translate(
            `${copyKey}.presetDescription.${props.preset}`,
            copy.presetDescriptions[props.preset as keyof typeof copy.presetDescriptions] ?? '',
          )}
        </HappierText>
      </View>
      {custom ? (
        <ItemGroup
          title={translate(`${KEY}.customTitle`, 'Each event')}
          testID={`${testID}.events`}
        >
          {rows.map((row) => (
            <SettingRow
              key={row.id}
              title={eventLabel(translate, row.id)}
              {...(eventDescription(translate, row.id) === undefined
                ? {}
                : { hint: eventDescription(translate, row.id) })}
              layout="adaptive"
              disabled={props.disabled}
              testID={`${testID}.event.${row.id}`}
              control={
                <Select
                  label={eventLabel(translate, row.id)}
                  presentation="segmented"
                  options={deliveryOptions.map((option) => ({
                    ...option,
                    testID: `${testID}.event.${row.id}.${option.value}`,
                  }))}
                  value={row.delivery}
                  disabled={props.disabled}
                  onChange={(value) => {
                    if (
                      value === 'off' ||
                      value === 'quiet' ||
                      value === 'interrupt'
                    )
                      props.onSetDelivery(row.id, value);
                  }}
                />
              }
            />
          ))}
        </ItemGroup>
      ) : (
        <>
          {GROUP_DELIVERIES.map((delivery) => {
            const group = copy.groups[delivery];
            const members = rows.filter((row) => row.delivery === delivery);
            if (members.length === 0) return null;
            return (
              <ItemGroup
                key={delivery}
                title={translate(`${copyKey}.group.${delivery}`, group.title)}
                action={
                  <HappierText
                    variant="meta"
                    style={{ color: theme.colors.secondaryText }}
                  >
                    {translate(`${copyKey}.channel.${delivery}`, group.channel)}
                  </HappierText>
                }
                testID={`${testID}.group.${delivery}`}
              >
                {members.map((row) => {
                  const description = eventDescription(translate, row.id);
                  return (
                    <Item
                      key={row.id}
                      title={eventLabel(translate, row.id)}
                      {...(description === undefined
                        ? {}
                        : { subtitle: description })}
                      testID={`${testID}.event.${row.id}`}
                    />
                  );
                })}
              </ItemGroup>
            );
          })}
          {off.length > 0 ? (
            <HappierText
              variant="meta"
              style={{ color: theme.colors.secondaryText, paddingHorizontal: edgePx }}
              testID={`${testID}.group.off`}
            >
              {`${translate(`${KEY}.group.off`, 'Not included')} · ${off.map((row) => eventLabel(translate, row.id)).join(', ')}`}
            </HappierText>
          ) : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: HAPPIER_PAGE_METRICS.groupSeparatorGapPx },
  // The presets take the container's width (never wider), so a narrow pane can fit the segmented control.
  presets: { gap: HAPPIER_PAGE_METRICS.groupHeadingGapPx },
});
