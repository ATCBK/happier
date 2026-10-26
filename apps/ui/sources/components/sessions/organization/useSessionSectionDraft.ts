import * as React from 'react';
import { resolveSessionSectionCreatePlacementV1 } from '@happier-dev/protocol/sessions/organization/folders';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionSectionGroupKey, type SessionSection } from '@/sync/domains/session/organization/sections';

/** The one inline New section field a list shows (lab `clsections:custom`), at most one at a time. */
export type SessionSectionDraft = Readonly<{
    key: number;
    serverId: string | null;
    name: string;
    phase: 'editing' | 'creating';
    failed: boolean;
}>;

/** Where the field draws, using the create owner's admitted neighbor before the ordinary-group fallback. */
export type SessionSectionDraftAnchor = Readonly<{ groupKey: string; placement: 'before' | 'after' }>;

export type SessionSectionDraftController = Readonly<{
    draft: SessionSectionDraft | null;
    anchor: SessionSectionDraftAnchor | null;
    /** Opens the field on a Home; `create` runs on Enter and says whether the section exists. */
    request: (serverId: string | null, create: (name: string) => Promise<boolean>) => Promise<boolean>;
    /** Column-level New section (View ⋯ / Organize): the list's own create on the active Home. */
    openNew: () => void;
    submit: (name: string) => void;
    cancel: () => void;
}>;

export const SessionSectionDraftContext = React.createContext<SessionSectionDraftController | null>(null);

export function useSessionSectionDraftController(): SessionSectionDraftController | null {
    return React.useContext(SessionSectionDraftContext);
}

const LEADING_HEADER_KINDS: ReadonlySet<string> = new Set(['attention', 'needsYou', 'working', 'pinned', 'loading']);

export function resolveSessionSectionDraftAnchor(items: ReadonlyArray<SessionListIndexItem>, source: Readonly<{
    serverId: string | null;
    sections: readonly SessionSection[];
}>): SessionSectionDraftAnchor | null {
    if (source.serverId) {
        const sections = source.sections.filter(section => section.address.serverId === source.serverId);
        const placement = resolveSessionSectionCreatePlacementV1(sections.map(section => ({
            sectionId: section.address.sectionId, sortKey: section.sortKey,
        })));
        if (placement.beforeSectionId) {
            const groupKey = buildSessionSectionGroupKey({ serverId: source.serverId, sectionId: placement.beforeSectionId });
            if (items.some(item => item.type === 'header' && item.groupKey === groupKey)) return { groupKey, placement: 'before' };
        }
    }
    let lastSection: string | null = null;
    let lastHeader: string | null = null;
    for (const item of items) {
        if (item.type !== 'header' || !item.groupKey) continue;
        // Attention shelves, Pinned and the sections lead; the first ordinary group follows them.
        if (item.headerKind === 'folder') lastSection = item.groupKey;
        else if (!LEADING_HEADER_KINDS.has(String(item.headerKind ?? ''))) return { groupKey: item.groupKey, placement: 'before' };
        lastHeader = item.groupKey;
    }
    const after = lastSection ?? lastHeader;
    return after ? { groupKey: after, placement: 'after' } : null;
}

/** The draft's state and its one pending request. Creation itself stays with the caller's Action path. */
export function useSessionSectionDraft(): Omit<SessionSectionDraftController, 'anchor' | 'openNew'> {
    const [draft, setDraft] = React.useState<SessionSectionDraft | null>(null);
    const pending = React.useRef<Readonly<{ key: number; create: (name: string) => Promise<boolean>; settle: (created: boolean) => void }> | null>(null);
    const nextKey = React.useRef(0);

    const settle = React.useCallback((key: number, created: boolean) => {
        const current = pending.current;
        if (!current || current.key !== key) return;
        pending.current = null;
        current.settle(created);
        setDraft((value) => value?.key === key ? null : value);
    }, []);

    const request = React.useCallback((serverId: string | null, create: (name: string) => Promise<boolean>) => (
        new Promise<boolean>((resolve) => {
            const previous = pending.current;
            if (previous) settle(previous.key, false);
            const key = ++nextKey.current;
            pending.current = { key, create, settle: resolve };
            setDraft({ key, serverId, name: '', phase: 'editing', failed: false });
        })
    ), [settle]);

    const submit = React.useCallback((raw: string) => {
        const current = pending.current;
        if (!current) return;
        const name = raw.trim();
        if (!name) {
            settle(current.key, false);
            return;
        }
        setDraft((value) => value?.key === current.key ? { ...value, name, phase: 'creating', failed: false } : value);
        void current.create(name).catch(() => false).then((created) => {
            if (created) {
                settle(current.key, true);
                return;
            }
            // A failed create keeps what the person typed, so Enter can try again.
            setDraft((value) => value?.key === current.key ? { ...value, phase: 'editing', failed: true } : value);
        });
    }, [settle]);

    const cancel = React.useCallback(() => {
        const current = pending.current;
        if (current) settle(current.key, false);
    }, [settle]);

    return { draft, request, submit, cancel };
}
