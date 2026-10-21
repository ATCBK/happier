import { buildComposerReferenceMentionPayloadV1 } from '@happier-dev/protocol/runtime/input/composerReferenceProviderV1';
import { buildMentionRefForKindV1, MENTION_KIND_V1, MENTION_BOUNDS, type BuiltInMentionKindV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { formatWidgetInstanceRefKeyV1, type WidgetInstanceRefV1 } from '@happier-dev/protocol/widgets';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { resolveSkillCatalogItemIdentityV1 } from '@happier-dev/protocol/runtime/catalog/skills';
import type { ComposerReferenceCandidateV1 } from '@happier-dev/protocol/plugins/contributions/composer-reference-providers';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ComposerSessionSuggestionItem } from './suggestionSession';
import type { ComposerSkillMention, ComposerVendorPluginMention } from './draftValues/sessionDraftValueTypes';

function referenceLabel(label: string): string {
    const folded = label.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');
    return folded.length > MENTION_BOUNDS.maxLabelChars
        ? `${folded.slice(0, MENTION_BOUNDS.maxLabelChars - 1)}…` : folded;
}

/** Selection stores identity and its human-readable token; context stays send-time owned. */
function buildBuiltInReferenceSelection<TKind extends BuiltInMentionKindV1>(kind: TKind, identity: string, label: string) {
    label = referenceLabel(label);
    const ref = buildMentionRefForKindV1(kind, identity);
    return { label, ref, token: formatInlineReferenceTokenV1({ label, ref }), payload: { kind, ref, label } };
}

export function buildComposerFileReferenceSelection(path: string, label: string) {
    return buildBuiltInReferenceSelection(MENTION_KIND_V1.file, path, label);
}

export function buildComposerWorkflowReferenceSelection(id: string, label: string) {
    return buildBuiltInReferenceSelection(MENTION_KIND_V1.workflow, id, label);
}

export function buildComposerWidgetReferenceSelection(ref: WidgetInstanceRefV1, label: string) {
    return buildBuiltInReferenceSelection(MENTION_KIND_V1.widget, formatWidgetInstanceRefKeyV1(ref), label);
}

export function buildComposerSessionReferenceSelection(item: Pick<ComposerSessionSuggestionItem, 'id' | 'title'>) {
    return buildBuiltInReferenceSelection(MENTION_KIND_V1.session, item.id, item.title);
}

export function buildContributedComposerReferenceSelection(input: Readonly<{
    reference: PluginContributionIdentityV1; candidate: ComposerReferenceCandidateV1; trigger: '@' | '$' | '/';
}>) {
    const label = referenceLabel(input.candidate.label);
    const payload = buildComposerReferenceMentionPayloadV1({ ...input, candidate: { ...input.candidate, label } });
    return { label, ref: payload.ref, token: formatInlineReferenceTokenV1({ label, ref: payload.ref }), payload };
}

export function buildComposerVendorPluginReferenceSelection(payload: Omit<ComposerVendorPluginMention, 'tokenText' | 'start' | 'end'>) {
    const label = referenceLabel(payload.label ?? payload.vendorPluginRef);
    const ref = buildMentionRefForKindV1(MENTION_KIND_V1.vendorPlugin, payload.vendorPluginRef);
    return { label, ref, token: formatInlineReferenceTokenV1({ label, ref }), payload: { ...payload, label } };
}

export function buildComposerSkillReferenceSelection(payload: Omit<ComposerSkillMention, 'tokenText' | 'start' | 'end'>) {
    const identity = resolveSkillCatalogItemIdentityV1(payload);
    if (!identity) return null;
    const label = referenceLabel(payload.displayName ?? payload.name);
    const ref = buildMentionRefForKindV1(MENTION_KIND_V1.skill, identity.id);
    return { label, ref, token: formatInlineReferenceTokenV1({ label, ref }), payload: { ...payload, displayName: label } };
}
