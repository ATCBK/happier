import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ComposerAttachmentDraftV1Schema, type ComposerAttachmentDraftV1, type ComposerAttachmentViewV1 } from '@happier-dev/protocol/runtime/input/composerAttachmentV1';
import { isValidPluginJsonSchemaValue } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { readHappierStructuredInputV1FromMeta } from '@happier-dev/protocol/sessions/userMessageRpc';
import type { ComposerSnapshotV1 } from '@happier-dev/protocol/plugins/ui/composer';
import { admitMentionRefsV1ForText, buildMentionRefV1, MentionRefV1Schema, parseMentionRefV1, type MentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { formatInlineReferenceTokenV1, scanInlineReferenceTokensV1, INLINE_REFERENCE_ATTACHMENT_SCHEME_V1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import type { PluginProjectedComposerAttachmentEntryV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { buildStructuredInputMetaOverrides } from '@/components/sessions/agentInput/structuredInputMentions';
import type { PluginUiComposerAttachmentProjection } from '@/sync/domains/plugins/ui/projection';
import type {
    ComposerStructuredInputMention,
    ComposerUnknownMention,
} from '@/sync/domains/input/draftValues/sessionDraftValueTypes';

type ComposerMentionRef = ComposerSnapshotV1['references'][number];

/**
 * The current daemon-normalized attachment declarations for one live Composer
 * scope. It is deliberately supplied by that scope's projection/currentness
 * owner; draft persistence retains neither this catalog nor its generation.
 */
export type ComposerAttachmentAvailabilityCatalog = Readonly<{
    entriesById: Readonly<Record<string, PluginUiComposerAttachmentProjection>> | null | undefined;
}>;

export type ComposerAttachmentDraftAvailabilitySummary = Readonly<{
    pluginUnavailable: boolean;
    attachmentNeedsAttention: boolean;
}>;

/**
 * Resolves a persisted attachment only through its exact current qualified
 * declaration. The immutable generation is not persisted alongside the draft:
 * an admitted current entry is the generation proof at the point of use.
 */
export function resolveCurrentComposerAttachmentCatalogEntry<
    Entry extends PluginProjectedComposerAttachmentEntryV1,
>(
    attachment: Pick<ComposerAttachmentDraftV1, 'attachment'>,
    entriesById: Readonly<Record<string, Entry>> | null | undefined,
): Entry | null {
    const contributionId = buildQualifiedPluginContributionKey(attachment.attachment);
    const entry = entriesById?.[contributionId];
    if (
        !entry
        || entry.id !== contributionId
        || entry.pluginId !== attachment.attachment.pluginId
        || entry.identity.pluginId !== attachment.attachment.pluginId
        || entry.identity.localId !== attachment.attachment.localId
        || entry.definition.id !== attachment.attachment.localId
        || entry.occurrenceId.trim().length === 0
    ) {
        return null;
    }
    return entry;
}

function resolveComposerAttachmentAvailability(
    draft: ComposerAttachmentDraftV1,
    catalog: ComposerAttachmentAvailabilityCatalog,
): ComposerAttachmentViewV1['availability'] {
    const entry = resolveCurrentComposerAttachmentCatalogEntry(draft, catalog?.entriesById);
    if (!entry) return { status: 'unavailable' };
    try {
        if (!entry.valueValidator) return { status: 'invalid' };
        return isValidPluginJsonSchemaValue(entry.valueValidator, draft.value)
            ? { status: 'ready' }
            : { status: 'invalid' };
    } catch {
        // A malformed static schema cannot make persisted input sendable. The
        // fallback record remains intact so the host can still display/remove it.
        return { status: 'invalid' };
    }
}

/**
 * Adapts the incumbent scope-specific draft records into the one Composer
 * document snapshot. It owns no persistence or identity: each caller writes
 * through its existing draft owner after the shared transaction validator
 * returns a complete mutation.
 */
export function composerAttachmentDraftToView(
    draft: ComposerAttachmentDraftV1,
    catalog: ComposerAttachmentAvailabilityCatalog,
): ComposerAttachmentViewV1 {
    return {
        ...draft,
        availability: resolveComposerAttachmentAvailability(draft, catalog),
    };
}

/**
 * Reduces persisted opaque attachment values to presentation-safe currentness
 * flags. Callers never need to retain or expose the attachment records, daemon
 * resources, or catalog generation in their own state.
 */
export function summarizeComposerAttachmentDraftAvailability(input: Readonly<{
    values: readonly unknown[];
    catalog: ComposerAttachmentAvailabilityCatalog;
    installedPluginIds: ReadonlySet<string>;
}>): ComposerAttachmentDraftAvailabilitySummary {
    let pluginUnavailable = false;
    let attachmentNeedsAttention = false;
    for (const value of input.values) {
        const parsed = ComposerAttachmentDraftV1Schema.safeParse(value);
        if (!parsed.success) {
            attachmentNeedsAttention = true;
            continue;
        }
        const draft = parsed.data;
        if (!input.installedPluginIds.has(draft.attachment.pluginId)) {
            pluginUnavailable = true;
            continue;
        }
        if (composerAttachmentDraftToView(draft, input.catalog).availability.status !== 'ready') {
            attachmentNeedsAttention = true;
        }
    }
    return { pluginUnavailable, attachmentNeedsAttention };
}

/** Drops only computed display availability while preserving canonical staged content. */
/**
 * One attachment as it was submitted. Live availability is a scope fact that a
 * retained submission never keeps, so it is not part of this projection input.
 */
export type ComposerSubmittedAttachmentV1 = Omit<ComposerAttachmentViewV1, 'availability'>;

export function composerAttachmentViewToDraft(
    view: ComposerSubmittedAttachmentV1,
): ComposerAttachmentDraftV1 {
    return {
        v: view.v,
        instanceId: view.instanceId,
        attachment: view.attachment,
        key: view.key,
        value: view.value,
        presentation: view.presentation,
        ...(view.content === undefined ? {} : { content: view.content }),
    };
}

/**
 * Projects one immutable Composer submission through the incumbent Message
 * structured-input owner. Callers may merge additional transport metadata, but
 * must not reinterpret reference or plugin-attachment identity themselves.
 *
 * Only the submitted content is read, so a retained submission that no longer
 * carries live scope facts — such as frozen creator launch custody — projects
 * through this same owner instead of reconstructing a synthetic snapshot.
 */
export function buildComposerSnapshotStructuredInputMetaOverrides(
    snapshot: Readonly<{
        text: ComposerSnapshotV1['text'];
        references: ComposerSnapshotV1['references'];
        attachments: readonly ComposerSubmittedAttachmentV1[];
    }>,
): Record<string, unknown> {
    return buildStructuredInputMetaOverrides({
        mentions: composerStructuredMentionsFromReferences({
            references: snapshot.references,
            existing: [],
        }),
        text: snapshot.text,
        ...(snapshot.attachments.length > 0
            ? { composerAttachments: snapshot.attachments.map(composerAttachmentViewToDraft) }
            : {}),
    });
}

function referenceIdentityKey(reference: Pick<MentionRefV1, 'kind' | 'ref' | 'token'>): string {
    return `${reference.kind}\u0000${reference.ref}\u0000${reference.token}`;
}

function readReferenceFromMention(
    mention: ComposerStructuredInputMention,
): MentionRefV1 | null {
    if ('ref' in mention && typeof mention.ref === 'string'
        && parseMentionRefV1(mention.ref)?.scheme === INLINE_REFERENCE_ATTACHMENT_SCHEME_V1) {
        const parsed = MentionRefV1Schema.safeParse({ kind: mention.kind, ref: mention.ref,
            token: mention.tokenText, ...('label' in mention && mention.label ? { label: mention.label } : {}) });
        return parsed.success ? parsed.data : null;
    }
    // Delegates identity encoding to the incumbent writer. The mention's own token is a
    // sufficient text basis: the writer admits a reference whose token the text contains.
    // The envelope owns only positionless Message identity. Normalize this token-sized
    // identity probe while retaining the real editable-draft range in the caller.
    const envelope = readHappierStructuredInputV1FromMeta(buildStructuredInputMetaOverrides({
        mentions: [{ ...mention, start: 0, end: mention.tokenText.length }],
        text: mention.tokenText,
    }));
    return envelope?.mentions?.[0] ?? null;
}

/** The only legacy-token rewrite; callers keep text and exact ranges together. */
export function normalizeComposerDraftReferenceTokens(input: Readonly<{
    text: string;
    mentions: readonly ComposerStructuredInputMention[];
}>): Readonly<{ text: string; mentions: readonly ComposerStructuredInputMention[] }> {
    let text = '';
    let boundary = 0;
    let changed = false;
    const mentions: ComposerStructuredInputMention[] = [];
    for (const mention of input.mentions) {
        const reference = readReferenceFromMention(mention);
        const inline = scanInlineReferenceTokensV1(mention.tokenText);
        const isInline = inline.length === 1 && inline[0]?.start === 0 && inline[0]?.end === mention.tokenText.length
            && inline[0]?.ref === reference?.ref;
        const token = reference && !isInline
            ? formatInlineReferenceTokenV1({ label: reference.label ?? mention.tokenText, ref: reference.ref })
            : mention.tokenText;
        text += input.text.slice(boundary, mention.start);
        const start = text.length;
        text += token;
        const end = text.length;
        const moved = token !== mention.tokenText || start !== mention.start || end !== mention.end;
        mentions.push(moved ? { ...mention, tokenText: token, start, end } : mention);
        changed ||= moved;
        boundary = mention.end;
    }
    return changed ? { text: text + input.text.slice(boundary), mentions } : input;
}

/** Message envelopes are positionless; editable custody starts at this seed boundary. */
export function hydrateComposerDraftReferencesFromMessage(input: Readonly<{
    text: string; meta?: unknown; references?: readonly MentionRefV1[];
    attachments?: readonly ComposerAttachmentDraftV1[];
}>): Readonly<{ text: string; mentions: readonly ComposerStructuredInputMention[]; attachments: readonly ComposerAttachmentDraftV1[] }> {
    const envelope = readHappierStructuredInputV1FromMeta(input.meta);
    const candidates = input.references ?? envelope?.mentions ?? [];
    const attachments = input.attachments ?? (envelope?.composerAttachments ?? [])
        .flatMap(({ content, ...attachment }) => content ? [] : [attachment]);
    const references = placePositionlessComposerReferences({ text: input.text,
        references: admitMentionRefsV1ForText(input.text, candidates), allOccurrences: true });
    const attachmentByRef = new Map(attachments.map(attachment => [
        buildMentionRefV1(INLINE_REFERENCE_ATTACHMENT_SCHEME_V1, attachment.instanceId), attachment,
    ]));
    const attachmentReferences: ComposerMentionRef[] = [];
    for (const token of scanInlineReferenceTokensV1(input.text)) {
        const attachment = attachmentByRef.get(token.ref);
        if (!attachment || references.some(reference => token.start < reference.end && token.end > reference.start)) continue;
        attachmentReferences.push({ kind: 'happier.attachment', ref: token.ref,
            token: input.text.slice(token.start, token.end), label: attachment.presentation.label, start: token.start, end: token.end });
    }
    const hydrated = normalizeComposerDraftReferenceTokens({ text: input.text,
        mentions: composerStructuredMentionsFromReferences({
            references: [...references, ...attachmentReferences].sort((left, right) => left.start - right.start), existing: [],
        }) });
    return { ...hydrated, attachments };
}

/**
 * Uses the incumbent structured-input writer/reader pair to retain its
 * reference identity rules. A document adapter never reimplements known
 * vendor/skill reference encoding.
 */
export function composerReferencesFromStructuredMentions(input: Readonly<{
    text: string;
    mentions: readonly ComposerStructuredInputMention[];
}>): readonly ComposerMentionRef[] {
    const references = input.mentions.flatMap((mention) => {
        // Editable Composer references have exact occurrence custody. A stale
        // range is not permission to search/rebind another equal token: doing
        // so can send provider context for text the user never selected.
        if (
            mention.start < 0
            || mention.end < mention.start
            || mention.end > input.text.length
            || input.text.slice(mention.start, mention.end) !== mention.tokenText
        ) return [];
        const reference = readReferenceFromMention(mention);
        return reference ? [{ ...reference, start: mention.start, end: mention.end }] : [];
    });
    return references.sort((left, right) => left.start - right.start || left.end - right.end);
}

function rebaseStoredMention(
    mention: ComposerStructuredInputMention,
    reference: ComposerMentionRef,
): ComposerStructuredInputMention {
    if (mention.kind === 'skill' && 'name' in mention) {
        return {
            ...mention,
            tokenText: reference.token,
            start: reference.start,
            end: reference.end,
            ...(reference.label ? { displayName: reference.label } : {}),
        };
    }
    return {
        ...mention,
        tokenText: reference.token,
        start: reference.start,
        end: reference.end,
        ...(reference.label ? { label: reference.label } : {}),
    };
}

function createOpaqueMention(reference: ComposerMentionRef): ComposerUnknownMention {
    const trigger = reference.composerReferenceTrigger;
    return {
        kind: reference.kind,
        ref: reference.ref,
        ...(reference.label ? { label: reference.label } : {}),
        ...(reference.composerReference ? { composerReference: reference.composerReference } : {}),
        ...(trigger === '@' || trigger === '$' || trigger === '/' ? { composerReferenceTrigger: trigger } : {}),
        tokenText: reference.token,
        start: reference.start,
        end: reference.end,
    };
}

/**
 * Place positionless Message references into a fresh document's text, once, at
 * the seed boundary.
 *
 * A persisted template (an Automation edit seed's stored message-level refs)
 * carries no occurrence ranges — the Message wire is deliberately positionless.
 * Before such a reference can live in an editable draft it needs the exact
 * UTF-16 `[start, end)` occurrence it binds, and choosing it is a one-time
 * placement decision, not an ongoing reconciliation: after placement the
 * document's exact-range custody owns the occurrence, and later reads never
 * re-search the text. Each token takes the leftmost unoccupied occurrence, so
 * two references rendering the same token bind two distinct occurrences, and
 * a token the text does not contain is dropped instead of being silently
 * relocated onto an unrelated occurrence.
 */
export function placePositionlessComposerReferences(input: Readonly<{
    text: string;
    references: readonly MentionRefV1[];
    /** Migration reserves already exact current occurrences instead of rebinding them. */
    occupied?: readonly Readonly<{ start: number; end: number }>[];
    /** Message admission binds every equal exact token; editable drafts retain their own ranges. */
    allOccurrences?: boolean;
}>): readonly ComposerMentionRef[] {
    const occupied: Array<Readonly<{ start: number; end: number }>> = [...(input.occupied ?? [])];
    const placed: ComposerMentionRef[] = [];
    for (const reference of input.references) {
        if (reference.token.length === 0) continue;
        let searchFrom = 0;
        while (searchFrom <= input.text.length) {
            const index = input.text.indexOf(reference.token, searchFrom);
            if (index < 0) break;
            const end = index + reference.token.length;
            const overlaps = occupied.some((range) => index < range.end && end > range.start);
            if (!overlaps) {
                occupied.push({ start: index, end });
                placed.push({ ...reference, start: index, end });
                if (!input.allOccurrences) break;
            }
            searchFrom = index + 1;
        }
    }
    return placed.sort((left, right) => left.start - right.start || left.end - right.end);
}

/**
 * Preserve a known mention's richer catalog context when its Protocol identity
 * survives a transaction. New/foreign kinds use the persisted open mention arm
 * instead of being interpreted as a host/vendor/skill spelling.
 */
export function composerStructuredMentionsFromReferences(input: Readonly<{
    /** Positional document references; ranges remain editable Composer custody. */
    references: readonly ComposerMentionRef[];
    existing: readonly ComposerStructuredInputMention[];
}>): readonly ComposerStructuredInputMention[] {
    const existingByReference = new Map<string, ComposerStructuredInputMention>();
    for (const mention of input.existing) {
        const reference = readReferenceFromMention(mention);
        if (!reference) continue;
        existingByReference.set(referenceIdentityKey(reference), mention);
    }
    return input.references.map((reference) => {
        const existing = existingByReference.get(referenceIdentityKey(reference));
        return existing ? rebaseStoredMention(existing, reference) : createOpaqueMention(reference);
    });
}
