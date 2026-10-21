import type { SkillListItemV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import type { SkillFoundListResultV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { resolveSkillCatalogItemIdentityV1, type SkillCatalogItemIdentityV1 } from '@happier-dev/protocol/runtime/catalog/skills';
import type { CapabilityApplyTimingV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import { buildMentionRefForKindV1, MENTION_KIND_V1, MentionRefV1Schema, type MentionRefV1 } from '@happier-dev/protocol/runtime/input/mentionRefV1';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';

export type SkillComposerRow = Readonly<{
    key: string; name: string; description: string | null; identity: SkillCatalogItemIdentityV1;
    source: 'session' | 'library' | 'found'; skillId: string | null;
}>;
export type SkillComposerGroup = Readonly<{
    kind: 'session' | 'library' | 'found'; machineId?: string; observedAt?: number; rows: readonly SkillComposerRow[];
}>;
export type SkillComposerGroupsInput = Readonly<{
    open: boolean; query: string; agentId: string;
    sessionItems: readonly unknown[]; libraryItems: readonly SkillListItemV1[];
    machineId: string | null;
    found: Readonly<{ machineId: string; observedAt: number; result: SkillFoundListResultV1 }> | null;
}>;
export function buildSkillComposerGroups(input: SkillComposerGroupsInput): readonly SkillComposerGroup[] {
    if (!input.open) return [];
    const seen = new Set<string>();
    const query = input.query.trim().toLowerCase();
    const rows = (items: readonly Readonly<{ value: unknown; source: SkillComposerRow['source']; skillId: string | null; description: string | null }>[]) =>
        items.flatMap(item => {
            const identity = resolveSkillCatalogItemIdentityV1(item.value);
            if (!identity || seen.has(identity.id)) return [];
            // Session identity deduplication precedes search so a filtered session
            // row cannot leak back into the library under different display data.
            seen.add(identity.id);
            if (query && !`${identity.name} ${item.description ?? ''}`.toLowerCase().includes(query)) return [];
            return [{ key: identity.id, name: identity.name, description: item.description, identity, source: item.source, skillId: item.skillId }];
        });
    const sessionRows = rows(input.sessionItems.flatMap(value => {
        if (!value || typeof value !== 'object') return [];
        const item = value as Readonly<Record<string, unknown>>;
        if (item.userInvocable === false) {
            // A weaker Found observation cannot override the Session's invocation eligibility.
            const identity = resolveSkillCatalogItemIdentityV1(value);
            if (identity) seen.add(identity.id);
            return [];
        }
        if (item.enabled === false) return [];
        return [{ value, source: 'session' as const, skillId: null, description: typeof item.description === 'string' ? item.description : null }];
    }));
    const libraryRows = rows(input.libraryItems.filter(item => item.userInvocable).map(item => ({
        value: { id: item.skillId, name: item.name, origin: 'happier' }, source: 'library' as const,
        skillId: item.skillId, description: item.description,
    })));
    const foundRows = rows(input.machineId && input.found?.machineId === input.machineId
        ? input.found.result.items.filter(item => item.userInvocable !== false && item.agents.includes(input.agentId)).map(item => ({
            value: { name: item.name, origin: 'vendor', backendId: input.agentId }, source: 'found' as const, skillId: null, description: item.description,
        })) : []);
    return [
        ...(sessionRows.length ? [{ kind: 'session' as const, rows: sessionRows }] : []),
        ...(libraryRows.length ? [{ kind: 'library' as const, rows: libraryRows }] : []),
        ...(foundRows.length ? [{ kind: 'found' as const, machineId: input.machineId!, observedAt: input.found!.observedAt, rows: foundRows }] : []),
    ];
}
export type SkillComposerSelectionOwner = Readonly<{
    /** Existing Sessions use P8's shared sheet controller, including its acknowledged-live receipt. */
    setItem(kind: 'skill' | 'native_skill' | 'mcp_server', id: string, state: 'on' | 'off' | 'inherit', title?: string):
        void | Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; message: string }>>;
}>;
export async function pickSkillComposerRow(row: SkillComposerRow, owner: SkillComposerSelectionOwner): Promise<
    Readonly<{ ok: true; mention: MentionRefV1 }> | Readonly<{ ok: false; message: string }>
> {
    const ref = buildMentionRefForKindV1(MENTION_KIND_V1.skill, row.identity.id);
    const mention = MentionRefV1Schema.parse({ kind: MENTION_KIND_V1.skill, ref,
        token: formatInlineReferenceTokenV1({ label: row.name, ref }), label: row.name });
    if (row.source === 'library' && row.skillId) {
        const result = await owner.setItem('skill', row.skillId, 'on', row.name);
        if (result && !result.ok) return result;
    }
    return { ok: true, mention };
}

/** The library and Found facts the `$` kind groups the session's own catalog with. */
export type SkillComposerSourceFacts = Readonly<{
    libraryItems: readonly SkillListItemV1[];
    found: SkillComposerGroupsInput['found'];
}>;

/**
 * What a composer host hands the `$` suggestion kind (P6 U6.8 through the composer registry): the Agent
 * and Machine the groups are for, last-known facts for an immediate first paint, a current read once
 * the picker asks, and the selection owner a library pick turns the skill on through (P8's Session
 * controller or P2's draft). The kind applies `buildSkillComposerGroups` and `pickSkillComposerRow`;
 * the host decides nothing about groups or selection.
 */
export type SkillComposerSource = Readonly<{
    agentId: string;
    machineId: string | null;
    machineName: string | null;
    peek(): SkillComposerSourceFacts;
    read(): Promise<SkillComposerSourceFacts>;
    owner: SkillComposerSelectionOwner;
    /**
     * The Session controller's own apply timing for skills, read when the picker builds its rows (the
     * source keeps its identity). `new_sessions_only` means a library skill cannot join this running
     * Session; a draft has no timing.
     */
    applyTiming(): CapabilityApplyTimingV1 | null;
}>;
