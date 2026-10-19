import { projectFollowEventConditionPickerV1 } from '../../automations/automationTriggerDefinition.js';
import {
  FOLLOW_POLICY_PRESET_KINDS_V1, FollowEventKindV1Schema, FollowNeedsYouTypeV1Schema, FollowPolicyV1Schema, resolveFollowDeliveryV1,
  type FollowEventDeliveryV1, type FollowEventKindV1, type FollowEventV1, type FollowPolicyV1,
} from './sessionFollowPolicyV1.js';

export type FollowPolicyEditorEventV1 = Readonly<{
  event: FollowEventV1;
  delivery: FollowEventDeliveryV1['delivery'];
  voice: boolean;
}>;
export type FollowPolicyEditorEditV1 =
  | Readonly<{ kind: 'preset'; preset: FollowPolicyV1['preset'] }>
  | Readonly<{ kind: 'voice'; enabled: boolean }>
  | Readonly<{ kind: 'event'; event: FollowEventV1; delivery?: FollowEventDeliveryV1['delivery']; voice?: boolean }>;
export type FollowPolicyEditorModelV1 = Readonly<{
  policy: FollowPolicyV1;
  preset: FollowPolicyV1['preset'];
  presets: readonly FollowPolicyV1['preset'][];
  voice: boolean;
  events: readonly FollowPolicyEditorEventV1[];
}>;

/** Account, Session and rule editors render the same source-supported choices. */
export function projectFollowPolicyEditorV1(policy: FollowPolicyV1, supportedFollowEvents?: readonly FollowEventKindV1[]): FollowPolicyEditorModelV1 {
  const value = FollowPolicyV1Schema.parse(policy);
  const events = projectFollowEventConditionPickerV1({ usage: 'follow', supportedFollowEvents })
    .flatMap((choice): FollowEventV1[] => {
      const kind = FollowEventKindV1Schema.parse(choice.condition.kind);
      return kind === 'needs_you' ? FollowNeedsYouTypeV1Schema.options.map(type => ({ kind, type })) : [{ kind }];
    })
    .map((event): FollowPolicyEditorEventV1 => {
      const route = resolveFollowDeliveryV1({ policies: [value], event });
      return { event, delivery: !route.selected ? 'off' : route.interrupt ? 'interrupt' : 'quiet', voice: route.voice };
    });
  return { policy: value, preset: value.preset,
    presets: [...FOLLOW_POLICY_PRESET_KINDS_V1, 'custom'] as const,
    voice: events.some(event => event.voice), events };
}

function customPolicy(policy: FollowPolicyV1): Extract<FollowPolicyV1, { preset: 'custom' }> {
  if (policy.preset === 'custom') return policy;
  let result: Extract<FollowPolicyV1, { preset: 'custom' }> = { preset: 'custom', events: {} };
  for (const row of projectFollowPolicyEditorV1(policy).events) result = setEvent(result, row.event, row);
  return result;
}
function setEvent(policy: Extract<FollowPolicyV1, { preset: 'custom' }>, event: FollowEventV1, setting: FollowEventDeliveryV1): Extract<FollowPolicyV1, { preset: 'custom' }> {
  return { preset: 'custom', events: event.kind === 'needs_you'
    ? { ...policy.events, needs_you: { ...policy.events.needs_you, [event.type]: { delivery: setting.delivery, voice: setting.voice } } }
    : { ...policy.events, [event.kind]: { delivery: setting.delivery, voice: setting.voice } } };
}

/** Immutable form edit; persistence and delivery continue through the existing owners. */
export function editFollowPolicyV1(policy: FollowPolicyV1, edit: FollowPolicyEditorEditV1): FollowPolicyV1 {
  const value = FollowPolicyV1Schema.parse(policy);
  if (edit.kind === 'preset') return edit.preset === 'custom' ? customPolicy(value)
    : { preset: edit.preset, voice: projectFollowPolicyEditorV1(value).voice };
  if (edit.kind === 'voice' && value.preset !== 'custom') return { ...value, voice: edit.enabled };
  const custom = customPolicy(value);
  if (edit.kind === 'voice') {
    let result = custom;
    for (const row of projectFollowPolicyEditorV1(custom).events) result = setEvent(result, row.event, { ...row, voice: edit.enabled });
    return result;
  }
  const previous = edit.event.kind === 'needs_you' ? custom.events.needs_you?.[edit.event.type] : custom.events[edit.event.kind];
  return setEvent(custom, edit.event, { delivery: edit.delivery ?? previous?.delivery ?? 'off', voice: edit.voice ?? previous?.voice ?? false });
}
