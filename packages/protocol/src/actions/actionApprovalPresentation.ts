import { StructuredQuestionAnswersV1Schema } from '../tools/structuredQuestionAnswersV1.js';
import type { ApprovalRequest } from '../approvals/approvalRequestV1.js';
import { getActionSpec } from './actionSpecs.js';
import { resolveEffectiveActionInputFields } from './actionInputHintsRuntime.js';
import { actionInputFieldAcceptsNull } from './actionInputSchemaPath.js';
import { ActionIdSchema, type ActionId } from './actionIds.js';
import { VoiceConversationTargetSchema } from './voiceConversationActionFamily.js';
import type { ActionInputFieldHint } from './actionInputHintsRuntime.js';
import { readCanonicalPaddedBase64DecodedLength } from '../crypto/base64.js';
import { normalizeUiSurfaceCapabilityRequestV1 } from '../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import { SessionVisualReviewedAdmissionV1Schema } from '../sessions/board/actions.js';
import { resolveSessionVisualEffectiveCapabilitiesV1 } from '../sessions/board/visualPolicy.js';
import { z } from 'zod';
import { unwrapActionInputSchema } from './actionInputSchemaPath.js';
import { isSettingsDeclarationActionIdV1 } from './settingsDeclarationActionFamily.js';
import { readBuiltInSettingDeclarationV1 } from './settings/settingsDeclarations.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export type ApprovalStructuredAnswer = Readonly<{
  question: string;
  values: readonly string[];
}>;

export type ApprovalUnrepresentableReason =
  | 'malformed_entry'
  | 'duplicate_question'
  | 'exceeds_protocol_bounds'
  | 'missing_required_context';

export type ApprovalStructuredAnswersProjection =
  | Readonly<{ kind: 'valid'; answers: readonly ApprovalStructuredAnswer[] }>
  | Readonly<{ kind: 'unrepresentable'; reason: ApprovalUnrepresentableReason }>;

/**
 * One line of a structured value as people read it: a humanized key and its scalar value, or a
 * group heading (`value: null`) whose members follow one level deeper. Every leaf of the literal
 * appears exactly once, in order, so the entries are a faithful reading of the same value.
 */
export type ApprovalStructuredValueEntry = Readonly<{
  label: string; value: string | null; depth: number;
  /** A declared reference (a Home, a session, an Account): people read it by its name. */
  reference?: ApprovalActionReference;
  /** A schema version or an empty value: present, but read only when asked for. */
  technical?: true;
}>;

export type ApprovalActionFieldRow =
  | Readonly<{
    kind: 'value'; path: string; title: string; value: string; reference?: ApprovalActionReference;
    /** A boolean choice reads through the client's localized yes/no labels. */
    valueFormat?: 'boolean';
    /** A readable reading of a structured (JSON) value; `value` stays the exact literal. */
    entries?: readonly ApprovalStructuredValueEntry[];
    /** A schema version argument: present, but read only when asked for. */
    technical?: true;
  }>
  | Readonly<{ kind: 'structuredAnswers'; path: string; title: string; answers: readonly ApprovalStructuredAnswer[] }>
  | Readonly<{ kind: 'unrepresentable'; path: string; title: string; reason: ApprovalUnrepresentableReason }>;

export type ApprovalActionReference =
  | Readonly<{ kind: 'session'; id: string; serverId?: string }>
  | Readonly<{ kind: 'home'; id: string }>
  | Readonly<{ kind: 'account'; id: string }>
  | Readonly<{ kind: 'setting'; id: string }>
  | Readonly<{ kind: 'providerConnection'; id: string; displayName?: string }>
  | Readonly<{ kind: 'providerContribution'; id: string }>;

// These are declared Action field keys, not a guess from an opaque value or suffix.
const SESSION_REFERENCE_KEYS = new Set([
  'sessionId', 'leadSessionId', 'expectedLeadSessionId', 'sourceSessionId', 'targetSessionId',
  'underSessionId', 'parentSessionId', 'originSessionId',
]);

/** A declared reference key read by its name: a session, a Home or an Account. */
function describeApprovalKeyReference(key: string | undefined, value: unknown): ApprovalActionReference | undefined {
  if (typeof value !== 'string' || !value.trim() || key === undefined) return undefined;
  if (SESSION_REFERENCE_KEYS.has(key)) return { kind: 'session', id: value.trim() };
  if (key === 'serverId') return { kind: 'home', id: value.trim() };
  if (key === 'accountId') return { kind: 'account', id: value.trim() };
  return undefined;
}

/**
 * What says nothing about the request's target: a schema version or an empty value. Target ids stay in
 * view, so an approval always shows exactly what it acts on; only a named reference moves its raw id.
 */
function isTechnicalApprovalKey(key: string | undefined): boolean {
  return key === 'v';
}

function describeApprovalReference(actionId: string, field: ActionInputFieldHint, values: readonly unknown[], input: unknown): ApprovalActionReference | undefined {
  if (values.length !== 1) return undefined;
  const value = values[0];
  if (field.path === 'target' && (actionId === 'ui.voice_global.start' || actionId === 'ui.voice_global.get')) {
    // Only this declared typed union owns this discriminator. Arbitrary JSON that happens
    // to contain kind/sessionId keys remains data, including access principals/configuration.
    const target = VoiceConversationTargetSchema.safeParse(value);
    if (target.success && target.data.kind === 'session' && target.data.sessionAddress) {
      return { kind: 'session', id: target.data.sessionAddress.sessionId, serverId: target.data.sessionAddress.serverId };
    }
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (field.path === 'anchor' && isSettingsDeclarationActionIdV1(actionId) && readBuiltInSettingDeclarationV1(value)) {
    return { kind: 'setting', id: value };
  }
  if (actionId.startsWith('providers.')) {
    if (field.path === 'connectionId') {
      const name = isRecord(input) && typeof input.displayName === 'string' ? input.displayName.trim() : '';
      return { kind: 'providerConnection', id: value.trim(), ...(name ? { displayName: name } : {}) };
    }
    if (field.path === 'contributionKey') return { kind: 'providerContribution', id: value.trim() };
  }
  const key = field.path.split('.').at(-1);
  if (field.inputType && 'hostType' in field.inputType && field.inputType.hostType === 'session') {
    return { kind: 'session', id: value.trim() };
  }
  return describeApprovalKeyReference(key, value);
}

export type ApprovalActionFieldsPresentation = Readonly<{
  rows: readonly ApprovalActionFieldRow[];
  unrepresentable: Readonly<{ path: string; reason: ApprovalUnrepresentableReason }> | null;
}>;

export type ApprovalRequestApproveAdmission = Readonly<
  | {
      status: 'available';
      presentation: ApprovalActionFieldsPresentation;
    }
  | {
      status: 'unavailable';
      reason: 'legacy_request';
      presentation: ApprovalActionFieldsPresentation;
    }
  | {
      status: 'unavailable';
      reason: 'context_unavailable';
      details: NonNullable<ApprovalActionFieldsPresentation['unrepresentable']>;
      presentation: ApprovalActionFieldsPresentation;
    }
>;

const STRUCTURED_ANSWER_FIELD_PATH_BY_ACTION_ID: Readonly<Record<string, string>> = {
  'session.user_action.answer': 'answers',
};

function visitSegments(value: unknown, segments: readonly string[], index: number, output: unknown[]): void {
  if (index >= segments.length) {
    output.push(value);
    return;
  }
  const segment = segments[index];
  if (!segment) return;
  if (segment === '[]') {
    if (!Array.isArray(value)) return;
    for (const entry of value) visitSegments(entry, segments, index + 1, output);
    return;
  }
  if (!isRecord(value)) return;
  visitSegments(value[segment], segments, index + 1, output);
}

export function getApprovalFieldValues(input: unknown, path: string): readonly unknown[] {
  if (path === 'answers.[].values' && isRecord(input) && Array.isArray(input.answers)) {
    return input.answers.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      if (Array.isArray(entry.values)) return entry.values;
      return typeof entry.answer === 'string' ? [entry.answer] : [];
    });
  }
  const segments = path.split('.').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return [];
  const output: unknown[] = [];
  visitSegments(input, segments, 0, output);
  return output;
}

export function shouldHideApprovalField(path: string, allPaths: readonly string[]): boolean {
  if (!path || path.endsWith('.[]')) return true;
  return allPaths.some((candidate) => candidate !== path
    && (candidate.startsWith(`${path}.`) || candidate.startsWith(`${path}.[`)));
}

export function formatApprovalFieldValues(values: readonly unknown[], options: Readonly<{ preserveStructuredValues?: boolean }> = {}): string | null {
  const displayValues = options.preserveStructuredValues ? values : values.flatMap((value) => (Array.isArray(value) ? value : [value]));
  const formatted = displayValues
    .map((value) => {
      // An explicitly blank string is still supplied content (for example an
      // empty prompt document), unlike an absent operand.
      if (typeof value === 'string') return value.trim() || JSON.stringify(value);
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      if (value === null && options.preserveStructuredValues) return 'null';
      if (value && typeof value === 'object') {
        try {
          return JSON.stringify(value) ?? '';
        } catch {
          return '';
        }
      }
      return '';
    })
    .filter((value) => value.length > 0);
  return formatted.length > 0 ? formatted.join(', ') : null;
}

function humanizeApprovalKey(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

function formatApprovalScalar(value: unknown): string {
  if (typeof value === 'string') return value.trim() || JSON.stringify(value);
  if (Array.isArray(value)) return value.length === 0 ? '[]' : value.map(formatApprovalScalar).join(', ');
  if (isRecord(value)) return '{}';
  return String(value);
}

function formatApprovalByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const kilobytes = bytes / 1024;
  return kilobytes < 1024 ? `${kilobytes.toFixed(1)} KB` : `${(kilobytes / 1024).toFixed(1)} MB`;
}

function isApprovalScalar(value: unknown): boolean {
  if (Array.isArray(value)) return value.every((item) => !Array.isArray(item) && !isRecord(item));
  return !isRecord(value) || Object.keys(value).length === 0;
}

/** A discriminator (`kind: 'corePage'`) reads as words; any other value stays as it was sent. */
function formatApprovalEntryValue(key: string | undefined, value: unknown): string {
  if ((key === 'kind' || key === 'type') && typeof value === 'string' && /^[a-z][A-Za-z0-9_-]*$/.test(value)) {
    return humanizeApprovalKey(value);
  }
  return formatApprovalScalar(value);
}

function isEmptyApprovalValue(value: unknown): boolean {
  return (Array.isArray(value) && value.length === 0) || (isRecord(value) && Object.keys(value).length === 0);
}

function appendApprovalStructuredEntries(
  key: string | undefined,
  label: string,
  value: unknown,
  depth: number,
  output: ApprovalStructuredValueEntry[],
): void {
  const encodedBytes = key === 'contentBase64' && typeof value === 'string'
    ? readCanonicalPaddedBase64DecodedLength(value) : null;
  if (encodedBytes !== null) {
    // A file's encoded bytes are not something people read: its size is. The literal keeps the bytes.
    output.push({ label: 'Size', value: formatApprovalByteSize(encodedBytes), depth });
    return;
  }
  if (isApprovalScalar(value)) {
    // Inside a JSON value only Home and Account ids name themselves: their ids are exact identities.
    // A session-looking key there stays data, so an arbitrary value cannot borrow a session's name.
    const keyReference = describeApprovalKeyReference(key, value);
    const reference = keyReference?.kind === 'session' ? undefined : keyReference;
    const technical = !reference && (isTechnicalApprovalKey(key) || isEmptyApprovalValue(value));
    output.push({
      label, value: formatApprovalEntryValue(key, value), depth,
      ...(reference ? { reference } : {}),
      ...(technical ? { technical: true as const } : {}),
    });
    return;
  }
  output.push({ label, value: null, depth });
  appendApprovalStructuredMembers(value, depth + 1, output);
}

function appendApprovalStructuredMembers(value: unknown, depth: number, output: ApprovalStructuredValueEntry[]): void {
  const members: [string | undefined, string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [undefined, String(index + 1), item])
    : Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, humanizeApprovalKey(key), item]);
  for (const [key, label, item] of members) appendApprovalStructuredEntries(key, label, item, depth, output);
}

/** Readable entries for one structured JSON value; scalars and flat lists read fine as they are. */
function describeApprovalStructuredValue(values: readonly unknown[]): readonly ApprovalStructuredValueEntry[] | undefined {
  if (values.length !== 1 || isApprovalScalar(values[0])) return undefined;
  const output: ApprovalStructuredValueEntry[] = [];
  appendApprovalStructuredMembers(values[0], 0, output);
  return output;
}

export function projectApprovalStructuredAnswers(values: readonly unknown[]): ApprovalStructuredAnswersProjection {
  const entries = values.flatMap((value) => {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
  });
  const candidate = Object.create(null) as Record<string, readonly string[]>;
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.question !== 'string') {
      return { kind: 'unrepresentable', reason: 'malformed_entry' };
    }
    if (Object.hasOwn(candidate, entry.question)) {
      return { kind: 'unrepresentable', reason: 'duplicate_question' };
    }
    const rawValues = Array.isArray(entry.values)
      ? entry.values
      : (entry.answer === undefined ? [] : [entry.answer]);
    if (rawValues.length === 0 || rawValues.some((value) => typeof value !== 'string')) {
      return { kind: 'unrepresentable', reason: 'malformed_entry' };
    }
    candidate[entry.question] = rawValues as readonly string[];
  }
  const parsed = StructuredQuestionAnswersV1Schema.safeParse(candidate);
  if (!parsed.success) return { kind: 'unrepresentable', reason: 'exceeds_protocol_bounds' };
  return {
    kind: 'valid',
    answers: Object.entries(parsed.data).map(([question, values]) => ({ question, values })),
  };
}

function readApprovalPresentationPreview(input: Readonly<{ actionId: string; preview?: unknown }>) {
  if (isRecord(input.preview)
    && input.preview.actionId === input.actionId
    && Object.hasOwn(input.preview, 'actionArgs')) {
    return input.preview;
  }
  return null;
}

/**
 * Selects the host-owned observation-safe arguments persisted in the approval
 * preview. Released artifacts without that envelope fall back to the Action's
 * own observation projection; raw secret-bearing arguments are never selected
 * merely because the presentation envelope is absent or mismatched.
 */
export function resolveApprovalPresentationInput(input: Readonly<{
  actionId: string;
  actionArgs: unknown;
  preview?: unknown;
}>): unknown {
  const preview = readApprovalPresentationPreview(input);
  if (preview) return preview.actionArgs;
  try {
    const spec = getActionSpec(input.actionId as ActionId);
    return spec.projectObservationInput
      ? spec.projectObservationInput(input.actionArgs)
      : input.actionArgs;
  } catch {
    return {};
  }
}

/** One Protocol-owned reading governs both rendered fields and approval admission. */
export function describeApprovalActionFields(input: Readonly<{
  actionId: string;
  actionArgs: unknown;
  preview?: unknown;
}>): ApprovalActionFieldsPresentation {
  let spec;
  try {
    spec = getActionSpec(input.actionId as ActionId);
  } catch {
    return { rows: [], unrepresentable: { path: '', reason: 'missing_required_context' } };
  }
  if (spec.approvalPresentation?.projectInput && !spec.inputSchema.safeParse(input.actionArgs).success) {
    const reason = 'missing_required_context' as const;
    return { rows: [{ kind: 'unrepresentable', path: '', title: spec.title, reason }],
      unrepresentable: { path: '', reason } };
  }
  // Observation previews can intentionally omit private domain content. Only the domain's
  // explicit review projection may disclose that content; never fall back to raw secret input.
  const presentationInput = spec.approvalPresentation?.projectInput
    ? spec.approvalPresentation.projectInput(input.actionArgs)
    : resolveApprovalPresentationInput(input);
  const resolved = [...resolveEffectiveActionInputFields(spec, presentationInput)];
  const coveredRoots = new Set(resolved.map(field => field.path.split('.')[0]));
  const schema = unwrapActionInputSchema(spec.inputSchema).schema;
  const shape = schema instanceof z.ZodObject ? schema.shape as Record<string, z.core.$ZodType> : {};
  // Form hints refine a field's reading; without hints, the canonical review
  // projection determines which operands can be shown.
  // Existing hints also declare intentional safe omissions (for example a saved credential
  // reference in a Provider review). Do not invent a required secret disclosure beside them.
  // The observation owner can deliberately omit invocation operands. Derive
  // unhinted review fields from that canonical projection, while an explicit
  // approval projection still defines its full reviewed-input contract.
  const observationInput = !spec.approvalPresentation?.projectInput && spec.projectObservationInput
    ? spec.approvalInputCustody !== 'live_only' && readApprovalPresentationPreview(input)
      && spec.inputSchema.safeParse(input.actionArgs).success
      ? spec.projectObservationInput(input.actionArgs)
      : presentationInput
    : null;
  const schemaKeys = !spec.approvalPresentation?.projectInput && spec.projectObservationInput
    ? isRecord(observationInput) ? Object.keys(observationInput) : []
    : Object.keys(shape);
  const keys = new Set((spec.inputHints?.fields.length ?? 0) === 0
    ? [...schemaKeys, ...(isRecord(presentationInput) ? Object.keys(presentationInput) : [])]
    : []);
  for (const path of keys) {
    if (coveredRoots.has(path)) continue;
    const fieldSchema = shape[path];
    resolved.push({ path, title: humanizeApprovalKey(path), widget: 'json', visible: true, disabled: false,
      required: fieldSchema !== undefined && !z.safeParse(fieldSchema, undefined).success });
  }
  const paths = resolved.map((field) => field.path);
  const structuredAnswerPath = STRUCTURED_ANSWER_FIELD_PATH_BY_ACTION_ID[input.actionId];
  const rows: ApprovalActionFieldRow[] = [];
  let unrepresentable: ApprovalActionFieldsPresentation['unrepresentable'] = resolved.length === 0
    && (!isRecord(presentationInput) || Object.keys(presentationInput).length > 0
      || (isRecord(input.actionArgs) && Object.keys(input.actionArgs).length > 0))
    ? { path: '', reason: 'missing_required_context' } : null;

  for (const field of resolved) {
    if (shouldHideApprovalField(field.path, paths)) continue;
    const values = getApprovalFieldValues(presentationInput, field.path);
    if (structuredAnswerPath !== undefined && field.path === structuredAnswerPath) {
      const projection = projectApprovalStructuredAnswers(values);
      if (projection.kind === 'unrepresentable') {
        unrepresentable ??= { path: field.path, reason: projection.reason };
        rows.push({ kind: 'unrepresentable', path: field.path, title: field.title, reason: projection.reason });
      } else if (projection.answers.length > 0) {
        rows.push({ kind: 'structuredAnswers', path: field.path, title: field.title, answers: projection.answers });
      }
      continue;
    }
    const literal = formatApprovalFieldValues(values, { preserveStructuredValues: field.widget === 'json' });
    // A chosen option reads by the label the form that set it shows.
    const option = field.widget === 'select' && values.length === 1
      ? field.options?.find((candidate) => candidate.value === values[0]) : undefined;
    const value = option && typeof option.label === 'string' ? option.label : literal;
    if (value === null) {
      // A required field whose schema declares `null` and that carries exactly
      // that null is present context with nothing to display, not missing context.
      const declaredNull = values.length > 0
        && values.every((entry) => entry === null)
        && actionInputFieldAcceptsNull(spec, field.path);
      // Live-only input deliberately leaves required private fields out of the
      // durable observation projection. Their presence is guaranteed by the
      // admitted invocation that retains the raw input; omission here means
      // withheld, not missing approval context.
      const withheldByLiveOnlyCustody = spec.approvalInputCustody === 'live_only';
      if (field.required && !declaredNull && !withheldByLiveOnlyCustody) {
        const reason = 'missing_required_context' as const;
        unrepresentable ??= { path: field.path, reason };
        rows.push({ kind: 'unrepresentable', path: field.path, title: field.title, reason });
      }
      continue;
    }
    const reference = describeApprovalReference(input.actionId, field, values, presentationInput);
    // A typed reference already reads by its name; entries are for values nothing else can read.
    const entries = field.widget === 'json' && !reference ? describeApprovalStructuredValue(values) : undefined;
    const technical = !reference && (isTechnicalApprovalKey(field.path.split('.').at(-1))
      || values.length > 0 && values.every(isEmptyApprovalValue)
      // The visual summary already names this item. Preserve its exact identity
      // in Details, rather than adding an opaque id to that first reading.
      || field.path === 'itemId' && Boolean(readApprovalVisualItem(input.actionId, presentationInput)?.title?.trim())
      || input.actionId.startsWith('providers.') && field.path === 'action');
    rows.push({
      kind: 'value', path: field.path, title: field.title, value,
      ...(reference ? { reference } : {}),
      ...(values.length === 1 && typeof values[0] === 'boolean' ? { valueFormat: 'boolean' as const } : {}),
      ...(entries ? { entries } : {}),
      ...(technical ? { technical: true as const } : {}),
    });
  }
  // A previewed visual is read by looking at it; its arguments stay one disclosure away.
  if (resolveApprovalVisualPreview(input)) {
    const at = rows.findIndex((row) => row.path === 'item' && row.kind === 'value');
    const row = rows[at];
    if (row && row.kind === 'value') rows[at] = { ...row, technical: true };
  }
  const network = describeApprovalVisualNetwork(input.actionId, presentationInput);
  if (network) {
    // The one consequence a visual approval exists for, next to the visual it belongs to.
    const at = rows.findIndex((row) => row.path === 'item');
    rows.splice(at < 0 ? rows.length : at + 1, 0, network);
  }
  return { rows, unrepresentable };
}

/** The visual a Session visual approval asks to show, read once for its rows and its preview. */
function readApprovalVisualItem(actionId: string, input: unknown): Readonly<{ title: string | null; source: Record<string, unknown> }> | null {
  if (actionId !== 'session.board.item.upsert' || !isRecord(input) || !isRecord(input.item)) return null;
  const source = input.item.source;
  if (!isRecord(source)) return null;
  return { title: typeof input.item.title === 'string' ? input.item.title : null, source };
}

export type ApprovalVisualPreview =
  | Readonly<{ kind: 'declarative'; title: string | null; document: unknown }>
  | Readonly<{ kind: 'html'; title: string | null; source: unknown; requestedCapabilities: Readonly<{ network: 'none' }> }>;

/**
 * The visual itself, for the person deciding. Nothing is approved yet, so an HTML visual previews
 * with no network and no requested Actions or Resources; its admitted network is the Network row.
 */
export function resolveApprovalVisualPreview(input: Readonly<{
  actionId: string; actionArgs: unknown; preview?: unknown;
}>): ApprovalVisualPreview | null {
  const visual = readApprovalVisualItem(input.actionId, resolveApprovalPresentationInput(input));
  if (!visual) return null;
  if (visual.source.kind === 'declarative' && visual.source.document !== undefined) {
    return { kind: 'declarative', title: visual.title, document: visual.source.document };
  }
  if (visual.source.kind === 'hostedHtml' && visual.source.source !== undefined) {
    return { kind: 'html', title: visual.title, source: visual.source.source, requestedCapabilities: { network: 'none' } };
  }
  return null;
}

/** What network an HTML visual gets once approved, using the host-captured admission facts. */
function describeApprovalVisualNetwork(actionId: string, input: unknown): ApprovalActionFieldRow | null {
  const source = readApprovalVisualItem(actionId, input)?.source;
  if (!source || source.kind !== 'hostedHtml') return null;
  // An invalid request is refused by admission; it has no network to state.
  const capabilities = normalizeUiSurfaceCapabilityRequestV1(source.requestedCapabilities);
  if (!capabilities) return null;
  const reviewed = SessionVisualReviewedAdmissionV1Schema.safeParse(isRecord(input) ? input.reviewedVisual : undefined);
  const policy = resolveSessionVisualEffectiveCapabilitiesV1(capabilities, {
    isCreate: isRecord(input) && input.expectedItemRevision === null,
    networkSetting: reviewed.success ? reviewed.data.networkSetting : null,
  });
  const value = policy.network === 'open' ? 'Any site'
    : policy.network === 'origins' ? `Only ${policy.networkOrigins.join(', ')}`
      : 'No network access';
  return { kind: 'value', path: 'item.source.requestedCapabilities', title: 'Network', value };
}

export function describeApprovalRequestFields(
  request: Pick<ApprovalRequest, 'actionId' | 'actionArgs' | 'preview'>,
): ApprovalActionFieldsPresentation {
  return describeApprovalActionFields({
    actionId: request.actionId,
    actionArgs: request.actionArgs,
    ...(request.preview === undefined ? {} : { preview: request.preview }),
  });
}

/**
 * The single Protocol-owned admission for an Approve decision.
 *
 * Released V1 requests stay readable and rejectable, but cannot prove the
 * immutable execution origin needed for replay. Current requests additionally
 * fail closed when the Action's required observation-safe context could not be
 * represented. UI controls and the executor consume this same result so a
 * button cannot advertise an effect that the decision owner will reject.
 */
export function resolveApprovalRequestApproveAdmission(
  request: ApprovalRequest,
): ApprovalRequestApproveAdmission {
  // Current durable requests retain the complete replay input. Validate before
  // typed projectors run; live-only records validate their private operands at
  // the invocation owner and keep only safe observation fields here.
  if (request.v === 2) {
    const actionId = ActionIdSchema.safeParse(request.actionId);
    if (actionId.success) {
      const spec = getActionSpec(actionId.data);
      if (spec.projectObservationInput && spec.approvalInputCustody !== 'live_only') {
        const admitted = spec.inputSchema.safeParse(request.actionArgs);
        if (!admitted.success) {
          const details = { path: admitted.error.issues[0]?.path.join('.') ?? '', reason: 'missing_required_context' as const };
          return { status: 'unavailable', reason: 'context_unavailable', details,
            presentation: { rows: [{ kind: 'unrepresentable', ...details, title: spec.title }], unrepresentable: details } };
        }
      }
    }
  }
  const presentation = describeApprovalRequestFields(request);
  if (request.v === 1) {
    return { status: 'unavailable', reason: 'legacy_request', presentation };
  }
  if (presentation.unrepresentable) {
    return {
      status: 'unavailable',
      reason: 'context_unavailable',
      details: presentation.unrepresentable,
      presentation,
    };
  }
  return { status: 'available', presentation };
}
