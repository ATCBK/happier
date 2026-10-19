import { actionInputOptionValueKey as canonicalActionInputOptionValueKey, isSameActionInputOptionValue as canonicalIsSameActionInputOptionValue } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { normalizeInputByFieldHints as canonicalNormalizeActionInputByFieldHints, resolveEffectiveInputFields as canonicalResolveEffectiveActionInputFields } from '@happier-dev/protocol/inputs/inputFieldRuntime';
import { readInputOptionValue as canonicalReadActionInputOptionValue } from '@happier-dev/protocol/inputs/inputFields';
import { readInputPath as canonicalReadInputPath } from '@happier-dev/protocol/inputs/inputPredicates';
import { writeInputPath as canonicalWriteInputPath, readInputTypePickerLaunchInput as canonicalReadInputTypePickerLaunchInput } from '@happier-dev/protocol/inputs';
import { resolveEffectiveInputFields as canonicalResolveEffectiveInputFields, normalizeInputByFieldHints as canonicalNormalizeInputByFieldHints, seedInputByFieldHints as canonicalSeedInputByFieldHints } from '@happier-dev/protocol/inputs/inputFieldRuntime';

import type {
  ActionInputFieldHint,
  ActionInputHints,
  ActionInputOption,
  ActionInputOptionValue,
  ActionInputPredicate,
  EffectiveActionInputField,
} from './actionTypeMap.generated.js';
import type { ActionSpec } from './service.js';
import { projectProtocolValue } from '../protocol/projectProtocolValue.js';

export type {
  ActionInputFieldHint,
  ActionInputHints,
  ActionInputOption,
  ActionInputOptionValue,
  ActionInputPredicate,
  EffectiveActionInputField,
};

/** Neutral fields used by Actions, Workflow declarations and widget inputs. */
export type InputFieldHint = ActionInputFieldHint;
export type InputHints = ActionInputHints;
export type InputOption = ActionInputOption;
export type InputOptionValue = ActionInputOptionValue;
export type { InputPredicate } from './dtos/pluginActionDtoSupport.generated.js';
export type EffectiveInputField = EffectiveActionInputField;
export type InputTypePickerLaunchInputV1 = Readonly<{
  inputType: Readonly<{ pluginId: string; localId: string }>; semantic: string;
  value?: import('../identity.js').JsonValue; options?: readonly InputOption[];
}>;
export const readInputTypePickerLaunchInput: (value: unknown) => InputTypePickerLaunchInputV1 | null = /* @__PURE__ */ projectProtocolValue(canonicalReadInputTypePickerLaunchInput);

export const readInputPath: (input: unknown, path: string) => unknown = canonicalReadInputPath;
export const writeInputPath: (input: Readonly<Record<string, unknown>>, path: string, value: unknown) => Record<string, unknown> = canonicalWriteInputPath;
export const resolveEffectiveInputFields: (spec: Readonly<{ inputHints?: InputHints }>, input: unknown,
  options?: Readonly<{ includeHidden?: boolean; contextSlots?: readonly string[] }>) => readonly EffectiveInputField[] = /* @__PURE__ */ projectProtocolValue(canonicalResolveEffectiveInputFields);
export const normalizeInputByFieldHints: (spec: Readonly<{ inputHints?: InputHints }>, input: Record<string, unknown>) => Record<string, unknown> = /* @__PURE__ */ projectProtocolValue(canonicalNormalizeInputByFieldHints);
/** Applies declared defaults to missing paths when opening a new form, before later edits or resets. */
export const seedInputByFieldHints: (spec: Readonly<{ inputHints?: InputHints }>, input: Readonly<Record<string, unknown>>) => Record<string, unknown> = /* @__PURE__ */ projectProtocolValue(canonicalSeedInputByFieldHints);

/**
 * The normalized, author-visible Action form contract consumed by UI
 * presenters. Host option-source instructions are intentionally excluded;
 * hosts resolve those into ordinary options before crossing this boundary.
 * UI presenters may add their own rendering-only option metadata, but do not
 * create another Action-form vocabulary.
 */
export type ActionFormFieldHint = Omit<
  ActionInputFieldHint,
  'optionsSourceId' | 'connectedAccountOptions' | 'resolvedEmptyConnectedAccountOptions'
>;

export type ActionFormHints = Omit<ActionInputHints, 'fields'> & Readonly<{
  fields: readonly ActionFormFieldHint[];
}>;

/** Resolves visibility, required, and disabled state through the Protocol-owned Action form owner. */
export const resolveEffectiveActionInputFields: (
  spec: Pick<ActionSpec, 'inputHints'>,
  input: unknown,
  options?: Readonly<{ includeHidden?: boolean; contextSlots?: readonly string[] }>,
) => readonly EffectiveActionInputField[] = /* @__PURE__ */ projectProtocolValue(canonicalResolveEffectiveActionInputFields);
/** Normalizes schema-admitted Action input through the Protocol-owned form owner. */
export const normalizeActionInputByFieldHints: (
  spec: Pick<ActionSpec, 'inputHints'>,
  input: Record<string, unknown>,
) => Record<string, unknown> = /* @__PURE__ */ projectProtocolValue(canonicalNormalizeActionInputByFieldHints);
/** Stable semantic identity for Action-form option values. */
export const actionInputOptionValueKey: (
  value: ActionInputOptionValue,
) => string = /* @__PURE__ */ projectProtocolValue(canonicalActionInputOptionValueKey);
/** Compares structured option values by their exact canonical ref, never object identity. */
export const isSameActionInputOptionValue: (
  left: ActionInputOptionValue,
  right: ActionInputOptionValue,
) => boolean = /* @__PURE__ */ projectProtocolValue(canonicalIsSameActionInputOptionValue);
/** Reads a draft/control option value through the Protocol's canonical strict schema. */
export const readActionInputOptionValue: (
  value: unknown,
) => ActionInputOptionValue | undefined = /* @__PURE__ */ projectProtocolValue(canonicalReadActionInputOptionValue);
