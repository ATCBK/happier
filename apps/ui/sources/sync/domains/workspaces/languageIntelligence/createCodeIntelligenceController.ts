import type { CodeIntelligenceFallbackInput, CodeIntelligenceFallbackLocation, CodeIntelligenceFallbackResult } from '@happier-dev/protocol/machines/codeIntelligenceFallback';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { Rect } from '@/components/ui/code/editor/codeEditorTypes';
import { readCodeLineIdentifiers, resolveCodeIdentifier, type CodeIdentifier, type CodeIntelligencePosition } from './codeIdentifiers';

export type CodeIntelligenceSelection = Readonly<{
    position: CodeIntelligencePosition;
    identifier: CodeIdentifier;
    names: readonly CodeIdentifier[];
    anchor?: Rect;
}>;
type InspectionPosition = CodeIntelligencePosition & Readonly<{ anchor?: Rect }>;
export type CodeIntelligenceSnapshot = Readonly<{
    mode: 'fallback';
    status: 'idle' | 'searching' | 'ready' | 'unavailable';
    selection: CodeIntelligenceSelection | null;
    kind: 'definition' | 'references' | null;
    result: Extract<CodeIntelligenceFallbackResult, { status: 'ok' }> | null;
    reason?: string;
}>;
export type CodeIntelligenceControllerInput = Readonly<{
    scope: WorkspaceScopeBase;
    path: string;
    languageId: string | null;
    accountLifetime: ServerAccountScopeLifetime;
    getText(): string;
    flushPendingChange?(): Promise<void>;
    query(input: CodeIntelligenceFallbackInput, signal: AbortSignal): Promise<CodeIntelligenceFallbackResult>;
    openLocation(location: CodeIntelligenceFallbackLocation): void | Promise<void>;
}>;

export function createCodeIntelligenceController(input: CodeIntelligenceControllerInput) {
    let snapshot: CodeIntelligenceSnapshot = { mode: 'fallback', status: 'idle', selection: null, kind: null, result: null };
    const listeners = new Set<() => void>();
    let pending: AbortController | null = null;
    let disposed = false;
    let lastInspectedText: string | null = null;

    function publish(next: CodeIntelligenceSnapshot): void {
        if (disposed || next === snapshot) return;
        snapshot = next;
        for (const listener of listeners) listener();
    }
    function abortPending(): void {
        pending?.abort();
        pending = null;
    }
    function sameSelection(left: CodeIntelligenceSelection | null, right: CodeIntelligenceSelection | null): boolean {
        return left === right || Boolean(left && right && left.position.line === right.position.line
            && left.identifier.startCharacter === right.identifier.startCharacter && left.identifier.endCharacter === right.identifier.endCharacter
            && left.identifier.symbol === right.identifier.symbol && sameAnchor(left.anchor, right.anchor) && left.names.length === right.names.length
            && left.names.every((name, index) => name.symbol === right.names[index].symbol
                && name.startCharacter === right.names[index].startCharacter && name.endCharacter === right.names[index].endCharacter));
    }
    function sameAnchor(left: Rect | undefined, right: Rect | undefined): boolean {
        return left === right || Boolean(left && right && left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height);
    }
    function select(text: string, position: InspectionPosition): CodeIntelligenceSelection | null {
        const identifier = resolveCodeIdentifier(text, position, input.languageId);
        if (!identifier) return null;
        const line = text.split(/\r\n|\r|\n/u)[position.line];
        return { position: { line: position.line, character: position.character }, identifier, names: readCodeLineIdentifiers(line, input.languageId),
            ...(position.anchor ? { anchor: position.anchor } : {}) };
    }
    function available(): boolean {
        return !disposed && input.accountLifetime.isCurrent() && input.accountLifetime.scope.serverId === input.scope.serverId;
    }
    function retire(): void {
        abortPending();
        publish({ mode: 'fallback', status: 'unavailable', selection: null, kind: null, result: null, reason: 'account_unavailable' });
    }
    const retirement = input.accountLifetime.onRetire(retire);

    async function query(kind: 'definition' | 'references', position: CodeIntelligencePosition): Promise<void> {
        if (!available()) { if (!disposed) retire(); return; }
        abortPending();
        const request = new AbortController();
        pending = request;
        try {
            if (input.flushPendingChange) await input.flushPendingChange();
            if (request.signal.aborted || !available()) return;
            const text = input.getText();
            const selection = select(text, position);
            if (!selection) {
                publish({ mode: 'fallback', status: 'idle', selection: null, kind: null, result: null });
                return;
            }
            const prior = sameSelection(snapshot.selection, selection) && snapshot.kind === kind ? snapshot.result : null;
            publish({ mode: 'fallback', status: 'searching', selection, kind, result: prior });
            const response = await input.query({
                rootPath: input.scope.rootPath, path: input.path, kind,
                line: position.line + 1, symbol: selection.identifier.symbol,
                ...(input.languageId ? { languageId: input.languageId } : {}),
            }, request.signal);
            if (request.signal.aborted || !available()) return;
            if (text !== input.getText()) {
                publish({ mode: 'fallback', status: 'idle', selection: null, kind: null, result: null });
                return;
            }
            if (response.status !== 'ok') {
                publish({ mode: 'fallback', status: 'unavailable', selection, kind, result: null, reason: response.reason });
                return;
            }
            publish({ mode: 'fallback', status: 'ready', selection, kind, result: response });
            if (kind === 'definition' && response.locations[0]) await input.openLocation(response.locations[0]);
        } catch {
            if (!request.signal.aborted && available()) publish({ mode: 'fallback', status: 'unavailable', selection: snapshot.selection, kind, result: null, reason: 'transport_failed' });
        } finally {
            if (pending === request) pending = null;
        }
    }
    return {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        inspect: (position: InspectionPosition | null): void => {
            if (!available()) return;
            const text = input.getText();
            const previous = snapshot.selection;
            // Pointer motion within one unchanged token does not retokenize the document.
            if (text === lastInspectedText && position && previous && previous.position.line === position.line
                && position.character >= previous.identifier.startCharacter && position.character <= previous.identifier.endCharacter
                && sameAnchor(position.anchor, previous.anchor)) return;
            lastInspectedText = text;
            const selection = position ? select(text, position) : null;
            if (!sameSelection(snapshot.selection, selection)) publish({ ...snapshot, selection });
        },
        definition: (position: CodeIntelligencePosition) => query('definition', position),
        references: (position: CodeIntelligencePosition) => query('references', position),
        cancel: (): void => { abortPending(); if (snapshot.status === 'searching') publish({ ...snapshot, status: snapshot.result ? 'ready' : 'idle' }); },
        dismiss: (): void => { abortPending(); publish({ mode: 'fallback', status: 'idle', selection: null, kind: null, result: null }); },
        dispose: (): void => { abortPending(); retirement.dispose(); disposed = true; listeners.clear(); },
    };
}
export type CodeIntelligenceController = ReturnType<typeof createCodeIntelligenceController>;
