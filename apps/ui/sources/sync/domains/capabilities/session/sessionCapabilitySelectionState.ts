import type {
    DaemonMcpServersPreviewResponse,
    ManagedMcpPreviewEntryV1,
} from '@happier-dev/protocol';
import { SessionMcpSelectionV1Schema } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import { SessionCapabilitySelectionAuthoringV1Schema, SessionSkillSelectionV1Schema,
    type SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';

type PreviewSuccess = Extract<DaemonMcpServersPreviewResponse, { ok: true }>;

function normalizeSelection(selection: SessionCapabilitySelectionV1 | null | undefined): SessionCapabilitySelectionV1 {
    return SessionCapabilitySelectionAuthoringV1Schema.parse(selection ?? {});
}

export function countSelectedSessionMcpPreviewEntries(
    preview: PreviewSuccess | null | undefined,
    params?: Readonly<{
        visibleManagedServerIds?: ReadonlySet<string> | null;
    }>,
): number {
    if (!preview) return 0;
    // The new-session chip badge should reflect detected/provider servers only.
    // (Managed/Happier servers are configured separately and should not contribute to this badge.)
    void params;
    return preview.detected.filter((entry) => entry.selected).length;
}

export function setManagedSessionMcpServersEnabled(
    selection: SessionCapabilitySelectionV1 | null | undefined,
    enabled: boolean,
): SessionCapabilitySelectionV1 {
    const normalized = normalizeSelection(selection);
    return normalizeSelection({
        ...normalized,
        mcp: { ...SessionMcpSelectionV1Schema.parse(normalized.mcp ?? {}), managedServersEnabled: enabled },
    });
}

export function toggleManagedSessionMcpSelection(
    selection: SessionCapabilitySelectionV1 | null | undefined,
    entry: Pick<ManagedMcpPreviewEntryV1, 'serverId' | 'selected' | 'selectable' | 'defaultSelected'>,
): SessionCapabilitySelectionV1 {
    const normalized = normalizeSelection(selection);
    if (!entry.selectable) return normalized;
    const mcp = SessionMcpSelectionV1Schema.parse(normalized.mcp ?? {});
    const forceIncludeServerIds = new Set(mcp.forceIncludeServerIds);
    const forceExcludeServerIds = new Set(mcp.forceExcludeServerIds);

    if (entry.selected) {
        forceIncludeServerIds.delete(entry.serverId);
        if (entry.defaultSelected) {
            forceExcludeServerIds.add(entry.serverId);
        } else {
            forceExcludeServerIds.delete(entry.serverId);
        }
    } else {
        forceExcludeServerIds.delete(entry.serverId);
        if (!entry.defaultSelected) {
            forceIncludeServerIds.add(entry.serverId);
        }
    }

    return normalizeSelection({
        ...normalized,
        mcp: { ...mcp, forceIncludeServerIds: Array.from(forceIncludeServerIds), forceExcludeServerIds: Array.from(forceExcludeServerIds) },
    });
}

export function setSessionCapabilitySelectionItem(selection: SessionCapabilitySelectionV1,
    kind: 'mcp_server' | 'skill' | 'native_skill', id: string, state: 'on' | 'off' | 'inherit'): SessionCapabilitySelectionV1 {
    const normalized = normalizeSelection(selection);
    if (kind === 'native_skill') {
        const skills = SessionSkillSelectionV1Schema.parse(normalized.skills ?? {});
        const excludes = new Set(skills.excludeNativeSkillNames);
        if (state === 'off') excludes.add(id); else excludes.delete(id);
        return normalizeSelection({ ...normalized, skills: { ...skills, excludeNativeSkillNames: [...excludes] } });
    }
    if (kind === 'mcp_server') {
        const mcp = SessionMcpSelectionV1Schema.parse(normalized.mcp ?? {});
        const includes = new Set(mcp.forceIncludeServerIds), excludes = new Set(mcp.forceExcludeServerIds);
        includes.delete(id); excludes.delete(id);
        if (state === 'on') includes.add(id); else if (state === 'off') excludes.add(id);
        return normalizeSelection({ ...normalized, mcp: { ...mcp, forceIncludeServerIds: [...includes], forceExcludeServerIds: [...excludes] } });
    }
    const skills = SessionSkillSelectionV1Schema.parse(normalized.skills ?? {});
    const includes = new Set(skills.forceIncludeSkillIds), excludes = new Set(skills.forceExcludeSkillIds);
    includes.delete(id); excludes.delete(id);
    if (state === 'on') includes.add(id); else if (state === 'off') excludes.add(id);
    return normalizeSelection({ ...normalized, skills: { ...skills, forceIncludeSkillIds: [...includes], forceExcludeSkillIds: [...excludes] } });
}
