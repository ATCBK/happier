import * as React from 'react';
import { useNewSessionCapabilities } from '@/sync/domains/capabilities/session/useNewSessionCapabilities';
import { useSessionCapabilities } from '@/sync/domains/capabilities/session/useSessionCapabilities';
import { buildSessionCapabilitiesModel, type SessionCapabilitiesModelInput } from './sessionCapabilitiesModel';
import { readSessionCapabilityApplyChange, type SessionCapabilityChange } from './sessionCapabilityApplyNotice';

export type NewSessionCapabilitiesDraft = Parameters<typeof useNewSessionCapabilities>[0];
export type SessionCapabilitiesTarget = Readonly<{ kind: 'draft'; draft: NewSessionCapabilitiesDraft }>
    | Readonly<{ kind: 'session'; sessionId: string; serverId: string | null; readOnly: boolean }>;
type Presentation = Omit<SessionCapabilitiesModelInput, 'view' | 'selection' | 'state' | 'readOnly' | 'change'>;

/** Detail hooks belong inside the open popover/sheet leaf; P2 remains the only selection store. */
export function useExistingSessionCapabilitiesPopover(target: Extract<SessionCapabilitiesTarget, { kind: 'session' }>, presentation: Presentation) {
    const state = useSessionCapabilities(target.sessionId, undefined, { serverId: target.serverId });
    const [change, setChange] = React.useState<SessionCapabilityChange | null>(null);
    const key = state.scopeKey;
    const receiptKey = React.useRef(key);
    const metadataChange = React.useMemo(() => readSessionCapabilityApplyChange(state.metadata, (kind, id) => {
        if (kind === 'native_skill') return id;
        const item = (kind === 'mcp_server' ? state.preview?.mcp.items : state.preview?.skills.items)?.find(item => item.id === id);
        return item ? item.title ?? item.name : null;
    }), [state.metadata, state.preview]);
    const changeForTarget = metadataChange ?? (receiptKey.current === key ? change : null);
    React.useEffect(() => { receiptKey.current = key; setChange(null); }, [key]);
    const setItem = React.useCallback(async (kind: SessionCapabilityChange['kind'], id: string, value: SessionCapabilityChange['state'], suppliedTitle?: string) => {
        if (target.readOnly) return { ok: false as const, message: 'read_only' };
        const item = (kind === 'mcp_server' ? state.preview?.mcp.items : state.preview?.skills.items)?.find(item => item.id === id);
        const title = suppliedTitle ?? (kind === 'native_skill' ? id : item ? item.title ?? item.name : null);
        const result = await state.setItem(kind, id, value);
        if (result.ok && title && receiptKey.current === key) setChange({ kind, title, state: value });
        return result;
    }, [target.readOnly, state.setItem, state.preview, key]);
    const model = React.useMemo(() => buildSessionCapabilitiesModel({ ...presentation,
        view: state.preview ? { ...state.preview, pendingApply: state.pendingApply } : null, selection: state.selection,
        state: state.status === 'ready' ? 'ready' : state.status === 'unavailable' ? 'error' : 'resolving',
        readOnly: target.readOnly, change: changeForTarget }), [presentation, state.preview, state.pendingApply, state.selection, state.status, target.readOnly, changeForTarget]);
    const dismissNotice = React.useCallback(() => setChange(null), []);
    const undoLast = React.useCallback(() => target.readOnly
        ? Promise.resolve({ ok: false as const, message: 'read_only' })
        : state.undoLast(), [target.readOnly, state.undoLast]);
    return { model, setItem, metadata: state.metadata, selection: state.selection, pendingApply: state.pendingApply, applyTiming: state.applyTiming,
        undoLast, demandPreview: state.demandPreview, refresh: state.refresh, error: state.error, dismissNotice };
}

/** Draft/Workflow/Trigger edits reuse the same P2 draft owner and never write an existing Session. */
export function useNewSessionCapabilitiesPopover(draft: NewSessionCapabilitiesDraft, presentation: Presentation) {
    const state = useNewSessionCapabilities(draft);
    const model = React.useMemo(() => buildSessionCapabilitiesModel({ ...presentation, view: state.preview, selection: state.selection,
        state: state.previewStatus === 'ready' ? 'ready' : state.previewStatus === 'unreachable' ? 'machine_unreachable'
            : state.previewStatus === 'error' ? 'error' : 'resolving', readOnly: false }), [presentation, state.preview, state.selection, state.previewStatus]);
    return { model, setItem: state.setItem, demandPreview: state.demandPreview, refresh: state.refresh, error: state.error };
}
