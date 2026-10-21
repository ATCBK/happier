import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { LanguageIntelligenceCommandSchema, type DaemonLspApplyRequest, type DaemonLspApplyResponse, type DaemonLspSyncRequest, type DaemonLspSyncResponse, type DaemonLspQueryRequest, type DaemonLspQueryResponse, type DaemonLspWatchRequest, type DaemonLspWatchResponse, type DaemonLspRestartRequest, type DaemonLspRestartResponse, type LanguageIntelligenceCapabilities, type LanguageIntelligenceDiagnostic, type LanguageIntelligenceDiagnosticsEntry, } from '@happier-dev/protocol/machines/languageIntelligence';
import type { WorkspaceFileEditSetFile, DaemonWorkspaceFileReplaceApplyResponse } from '@happier-dev/protocol/machines/workspaceFiles';
import { MachineProcessesPolicyV1Schema } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { MACHINE_WATCH_WINDOW_MS } from '@happier-dev/protocol/rpc/machineWatchWindow';
import { getFileLanguageFromPath } from '@happier-dev/protocol/machines/fileLanguage';
import { armDeadlineTimer } from '@happier-dev/protocol/common/deadlineTimer';
import { DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES } from '@happier-dev/protocol/features/payload/capabilities/machineTunnelCapabilities';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import type { MachineResourcesPolicyReader } from '@/processes/toolIdleTimeouts';
import { parkWatch } from '@/daemon/lifecycle/parkWatch';
import { resolveCanonicalAbsolutePathComparisonIdentity } from '@/utils/path/expandHomeDirPath';
import { logger } from '@/ui/logger';
import type { HappierProcessRootSource } from '@/daemon/processes/roots/listHappierProcessRoots';
import { createLanguageServerDefinitions, type LanguageServerDefinition } from './languageServerDefinitions';
import { createServerSession, LanguageServerSessionError, type OpenLanguageServerProtocol, type ServerSession, type ServerSessionAnswer } from './serverSession';
import { applyWorkspaceFileTextEdits, LspDocumentTextError, readDocumentLine, resolveDocumentPosition } from './documentText';
import { LspWorkspacePathError, resolveWorkspacePath, workspaceUriToPath } from './workspaceUris';
import { resolveLanguageServerRoot } from './rootResolution';
import { normalizeLspDocumentSymbols, normalizeLspHover, readLspObject, readLspRange } from './languageServerResults';
import { LspWorkspaceEditError, normalizeWorkspaceEdit } from './workspaceEdit';
import { applyWorkspaceFileReplace } from '@/rpc/handlers/workspaceFileReplace';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';
type RequestContext = Readonly<{
    signal?: AbortSignal;
    requesterWorkAttributionV1?: RequesterWorkAttributionV1;
}>;
/** Native arguments can contain absolute URIs and remain inside the host. */
function readCodeActionCommand(value: Record<string, unknown>) {
    const command = typeof value.command === 'string' ? value : readLspObject(value.command);
    return command ? LanguageIntelligenceCommandSchema.parse({ command: command.command,
        ...(command.arguments !== undefined ? { arguments: command.arguments } : {}) }) : undefined;
}
export type LanguageServerHost = Readonly<{
    readProcessRoots(): readonly HappierProcessRootSource[];
    sync(input: DaemonLspSyncRequest, context?: RequestContext): Promise<DaemonLspSyncResponse>;
    query(input: DaemonLspQueryRequest, context?: RequestContext): Promise<DaemonLspQueryResponse>;
    apply(input: DaemonLspApplyRequest, context?: RequestContext): Promise<DaemonLspApplyResponse>;
    watch(input: DaemonLspWatchRequest, context?: RequestContext): Promise<DaemonLspWatchResponse>;
    restart(input: DaemonLspRestartRequest, context?: RequestContext): Promise<DaemonLspRestartResponse>;
    dispose(): Promise<void>;
}>;
export type LanguageServerHostOptions = Readonly<{
    readCurrentContributionRegistry?: () => ResolvedContributionRegistry | null | undefined;
    openProtocol?: OpenLanguageServerProtocol;
    readPolicy?: MachineResourcesPolicyReader;
    platform?: NodeJS.Platform;
}>;
type RootDocument = {
    languageId: string;
    references: number;
    sessions: Set<string>;
};
type RootState = {
    path: string;
    generation: string;
    revision: number;
    documents: Map<string, RootDocument>;
    sessions: Set<string>;
    listeners: Set<() => void>;
    watchers: number;
    diagnostics: Map<string, Map<string, {
        revision: number;
        entry: LanguageIntelligenceDiagnosticsEntry;
    }>>;
};
type HostedSession = {
    session: ServerSession;
    closing?: Promise<void>;
    timer: (() => void) | undefined;
    lastActivity: number;
    activeOperations: number;
};
type QueryOk = Extract<DaemonLspQueryResponse, {
    status: 'ok';
}>;
const emptyCapabilities = (): LanguageIntelligenceCapabilities => ({ hover: false, definition: false, references: false, documentSymbol: false, diagnostics: 'none', acceptsExternalChanges: false });
function combineCapabilities(sessions: readonly ServerSession[]): LanguageIntelligenceCapabilities {
    const all = sessions.map(s => s.capabilities());
    return { hover: all.some(c => c.hover), definition: all.some(c => c.definition), references: all.some(c => c.references), documentSymbol: all.some(c => c.documentSymbol), acceptsExternalChanges: all.some(c => c.acceptsExternalChanges), diagnostics: all.some(c => c.diagnostics === 'pull') ? 'pull' : all.some(c => c.diagnostics === 'push') ? 'push' : 'none', rename: all.some(c => c.rename), prepareRename: all.some(c => c.prepareRename), fileRename: all.some(c => c.fileRename), codeAction: all.some(c => c.codeAction) };
}
function unique<T>(items: T[], key: (item: T) => string): T[] { const seen = new Set<string>(); return items.filter(item => { const k = key(item); if (seen.has(k))
    return false; seen.add(k); return true; }); }
async function mergeEditSets(rootPath: string, platform: NodeJS.Platform, files: readonly WorkspaceFileEditSetFile[]): Promise<WorkspaceFileEditSetFile[]> {
    const merged = new Map<string, WorkspaceFileEditSetFile>();
    for (const file of files) {
        const previous = merged.get(file.path);
        if (previous && (previous.expectedHash !== file.expectedHash || previous.renameTo && file.renameTo && previous.renameTo !== file.renameTo)) throw new LspWorkspaceEditError('stale_query');
        // Equivalent whole contributions from stacked servers are one edit set;
        // repeated same-position inserts inside a server's array are ordered LSP edits.
        const edits = previous && JSON.stringify(previous.edits) === JSON.stringify(file.edits)
            ? previous.edits : [...(previous?.edits ?? []), ...file.edits];
        const text = (await readFile(resolveWorkspacePath({ rootPath, platform }, file.path))).toString('utf8');
        try { applyWorkspaceFileTextEdits(text, edits); } catch { throw new LspWorkspaceEditError('invalid_request'); }
        merged.set(file.path, { ...file, edits, ...(previous?.renameTo ? { renameTo: previous.renameTo } : {}) });
    }
    return [...merged.values()];
}
export function createLanguageServerHost(options: LanguageServerHostOptions = {}): LanguageServerHost {
    const platform = options.platform ?? process.platform;
    const definitions = createLanguageServerDefinitions({ readCurrentContributionRegistry: options.readCurrentContributionRegistry ?? readCurrentContributionRegistry });
    const openProtocol: OpenLanguageServerProtocol = options.openProtocol ?? (async (input) => (await import('./managedProtocol')).openLanguageServerProtocol(input));
    const roots = new Map<string, RootState>();
    const sessions = new Map<string, HostedSession>();
    let disposed = false;
    function key(path: string): string {
        const identity = resolveCanonicalAbsolutePathComparisonIdentity(path, { platform });
        if (identity === null)
            throw new LspWorkspacePathError('invalid_path', 'An absolute workspace root is required');
        return identity;
    }
    function rootFor(rootPath: string): RootState {
        resolveWorkspacePath({ rootPath, platform }, '.');
        const id = key(rootPath);
        let root = roots.get(id);
        if (!root) {
            root = { path: rootPath, generation: randomUUID(), revision: 0, documents: new Map(), sessions: new Set(), listeners: new Set(), watchers: 0, diagnostics: new Map() };
            roots.set(id, root);
        }
        return root;
    }
    const rootSessions = (root: RootState) => [...root.sessions].flatMap(id => { const hosted = sessions.get(id); return hosted ? [hosted.session] : []; });
    function heldDocument(root: RootState, path: string) {
        const documents = rootSessions(root).flatMap(session => {
            try { const document = session.document(localPath(session, root, path)); return document ? [document] : []; }
            catch { return []; }
        });
        return documents.find(document => document.unsaved) ?? documents[0];
    }
    function retireSession(id: string, session: ServerSession): void {
        const hosted = sessions.get(id);
        if (hosted?.session !== session)
            return;
        hosted.timer?.();
        sessions.delete(id);
        for (const root of roots.values()) {
            if (!root.sessions.delete(id)) continue;
            for (const [path, document] of root.documents) {
                if (document.sessions.delete(id) && document.sessions.size === 0) root.documents.delete(path);
            }
            root.revision++;
            for (const listener of root.listeners) listener();
        }
    }
    function retireEmptySession(id: string, session: ServerSession): void {
        if (session.paths().length === 0) retireSession(id, session);
    }
    async function closeDocument(id: string, session: ServerSession, path: string): Promise<void> {
        const hosted = sessions.get(id);
        if (hosted?.session !== session) return await session.close(path);
        // Keep the actual closing process visible until its native teardown
        // settles. Acquisition joins this same close before selecting a session.
        const closing = hosted.closing
            ? hosted.closing.then(() => session.close(path)) : session.close(path);
        hosted.closing = closing;
        try {
            await closing;
            if (hosted.closing === closing) retireEmptySession(id, session);
        } finally {
            if (hosted.closing === closing) hosted.closing = undefined;
        }
    }
    function localPath(session: ServerSession, root: RootState, path: string): string {
        const absolute = resolveWorkspacePath({ rootPath: root.path, platform }, path);
        const local = relative(session.workspaceRoot, absolute).replaceAll('\\', '/');
        resolveWorkspacePath({ rootPath: session.workspaceRoot, platform }, local);
        return local;
    }
    function projectChange(sessionKey: string): void {
        const session = sessions.get(sessionKey)?.session;
        if (!session)
            return;
        for (const root of roots.values()) {
            if (!root.sessions.has(sessionKey))
                continue;
            root.revision++;
            for (const [path, document] of root.documents) {
                if (!document.sessions.has(sessionKey))
                    continue;
                const entry = session.diagnostics.get(localPath(session, root, path));
                const prior = root.diagnostics.get(path)?.get(session.definition.id);
                if (!entry && !prior)
                    continue;
                let perServer = root.diagnostics.get(path);
                if (!perServer) {
                    perServer = new Map();
                    root.diagnostics.set(path, perServer);
                }
                perServer.set(session.definition.id, { revision: root.revision, entry: entry ? { ...entry, items: entry.items.map(item => ({ ...item, path })) } : { state: 'ready', version: prior!.entry.version, generation: session.status().generation, items: [] } });
            }
            for (const listener of root.listeners)
                listener();
        }
    }
    function idleMs(): number | null {
        if (!options.readPolicy)
            return MachineProcessesPolicyV1Schema.parse({}).toolIdleCloseMs;
        const policy = options.readPolicy();
        return policy.status === 'ready' ? policy.policy.processes.toolIdleCloseMs : null;
    }
    function touch(sessionKey: string): void {
        const hosted = sessions.get(sessionKey);
        if (!hosted)
            return;
        hosted.lastActivity = Date.now();
        hosted.timer?.();
        const duration = idleMs();
        if (duration === null || hosted.session.status().state === 'idle' || hosted.session.status().state === 'stopped') {
            hosted.timer = undefined;
            return;
        }
        hosted.timer = armDeadlineTimer(hosted.lastActivity + duration, () => {
            hosted.timer = undefined;
            if (hosted.activeOperations > 0 || [...roots.values()].some(root => root.sessions.has(sessionKey) && root.watchers > 0)) {
                touch(sessionKey);
                return;
            }
            const current = idleMs();
            if (current === null)
                return;
            if (Date.now() - hosted.lastActivity < current) {
                touch(sessionKey);
                return;
            }
            void hosted.session.dispose().then(() => retireSession(sessionKey, hosted.session),
                error => logger.debug('[LSP] Idle cleanup failed', { error }));
        }, { unref: true });
    }
    async function ensureSession(root: RootState, path: string, definition: LanguageServerDefinition,
        acquire: (selected: { id: string; session: ServerSession }) => Promise<void>, context?: RequestContext, isCurrent?: () => boolean): Promise<{
        id: string;
        session: ServerSession;
    }> {
        const nativeRoot = await resolveLanguageServerRoot({ rootPath: root.path, path, rootMarkers: definition.rootMarkers, platform });
        if (disposed || (isCurrent && !isCurrent())) throw new LanguageServerSessionError('cancelled');
        const id = JSON.stringify([definition.id, key(nativeRoot)]);
        let hosted = sessions.get(id);
        while (hosted?.closing) {
            await hosted.closing;
            if (disposed || (isCurrent && !isCurrent())) throw new LanguageServerSessionError('cancelled');
            hosted = sessions.get(id);
        }
        if (!hosted) {
            const session = createServerSession({ definition, rootPath: nativeRoot, workspaceRoot: nativeRoot, platform, openProtocol,
                requesterWorkAttributionV1: context?.requesterWorkAttributionV1,
                onRetired: () => { void session.dispose().then(() => retireSession(id, session),
                    error => logger.debug('[LSP] Plugin retirement cleanup failed', { error })); },
                onChange: () => { projectChange(id); touch(id); } });
            hosted = { session, timer: undefined, lastActivity: Date.now(), activeOperations: 0 };
            sessions.set(id, hosted);
        }
        root.sessions.add(id);
        const selected = { id, session: hosted.session };
        // Enqueue document acquisition before publishing the selection across
        // an await (including another stacked definition's root discovery).
        await acquire(selected);
        return selected;
    }
    function errorResponse(error: unknown): Extract<DaemonLspQueryResponse, {
        status: 'error' | 'unavailable';
    }> {
        if (error instanceof LspWorkspacePathError)
            return error.code === 'unsupported_root' ? { status: 'unavailable', reason: 'unsupported_root' } : { status: 'error', errorCode: 'path_not_allowed' };
        if (error instanceof LspDocumentTextError)
            return error.code === 'symbol_not_found' ? { status: 'error', errorCode: 'symbol_not_found', candidates: [...(error.candidates ?? [])] } : { status: 'error', errorCode: 'invalid_position' };
        if (error instanceof LspWorkspaceEditError) return error.code === 'unsaved_editor_changes'
            ? { status: 'error', errorCode: error.code, diskHash: error.diskHash! } : { status: 'error', errorCode: error.code };
        if (error instanceof LanguageServerSessionError)
            return { status: 'error', errorCode: error.code };
        const native = readLspObject(error);
        if (native?.code === 'ENOENT')
            return { status: 'error', errorCode: 'root_not_found' };
        if (native?.name === 'AbortError')
            return { status: 'error', errorCode: 'cancelled' };
        logger.debug('[LSP] Host operation failed', { error });
        return { status: 'error', errorCode: 'request_failed' };
    }
    function watchSnapshot(root: RootState, sinceRevision = -1): Extract<DaemonLspWatchResponse, {
        status: 'ok';
    }> {
        const paths: Array<[string, Record<string, LanguageIntelligenceDiagnosticsEntry>]> = [];
        for (const [path, entries] of root.diagnostics) {
            const changedEntries: Array<[string, LanguageIntelligenceDiagnosticsEntry]> = [];
            for (const [serverId, entry] of entries) {
                if (entry.revision > sinceRevision) changedEntries.push([serverId, entry.entry]);
            }
            if (changedEntries.length) paths.push([path, Object.fromEntries(changedEntries)]);
        }
        const diagnostics = Object.fromEntries(paths);
        return { status: 'ok', revision: root.revision, servers: rootSessions(root).map(session => session.status()), diagnostics };
    }
    const host: LanguageServerHost = {
        readProcessRoots: () => [...sessions.values()].flatMap(({ session }) => session.readProcessRoots()),
        async sync(input, context) {
            try {
                if (disposed)
                    return { status: 'unavailable', reason: 'session_unavailable' };
                context?.signal?.throwIfAborted();
                const root = rootFor(input.rootPath), op = input.op;
                if (op.op === 'external') {
                    for (const path of op.paths)
                        resolveWorkspacePath({ rootPath: root.path, platform }, path);
                    await Promise.all(rootSessions(root).map(session => session.external(op.paths, root.path)));
                }
                else if (op.op === 'close') {
                    const document = root.documents.get(op.path);
                    if (document && document.references > 0) {
                        const heldSessions = [...document.sessions];
                        document.references--;
                        await Promise.all(heldSessions.map(async (id) => { const hosted = sessions.get(id); if (hosted)
                            await closeDocument(id, hosted.session, localPath(hosted.session, root, op.path)); }));
                        if (document.references === 0 && root.documents.get(op.path) === document)
                            root.documents.delete(op.path);
                    }
                }
                else if (op.op === 'change') {
                    const document = root.documents.get(op.path);
                    if (!document)
                        return { status: 'error', errorCode: 'document_out_of_sync' };
                    await Promise.all([...document.sessions].map(id => { const session = sessions.get(id)?.session; return session?.change({ ...op, path: localPath(session, root, op.path) }); }));
                }
                else {
                    resolveWorkspacePath({ rootPath: root.path, platform }, op.path);
                    const matching = definitions.findDefinitionsForDocument({ languageId: op.languageId, path: op.path });
                    if (!matching.length)
                        return { status: 'unavailable', reason: 'no_capable_server' };
                    const held = root.documents.get(op.path);
                    const prior = held && held.references > 0 ? held : undefined;
                    if (op.op === 'snapshot' && !prior)
                        return { status: 'error', errorCode: 'document_out_of_sync' };
                    const document = prior ?? { languageId: op.languageId, references: 0, sessions: new Set<string>() };
                    root.documents.set(op.path, document);
                    if (op.op === 'open')
                        document.references++;
                    const isCurrent = () => !disposed && root.documents.get(op.path) === document && document.references > 0;
                    for (const definition of matching) {
                        await ensureSession(root, op.path, definition, async ({ id, session }) => {
                            if (!isCurrent()) throw new LanguageServerSessionError('cancelled');
                            document.sessions.add(id);
                            const text = { path: localPath(session, root, op.path), languageId: op.languageId, text: op.text, version: op.version, unsaved: op.unsaved };
                            if (op.op === 'open' || !session.document(text.path)) {
                                const holders = session.document(text.path) ? 1 : document.references;
                                for (let index = 0; index < holders; index++) await session.open(text);
                                if (!isCurrent()) throw new LanguageServerSessionError('cancelled');
                                const hosted = sessions.get(id)!;
                                hosted.activeOperations++;
                                try {
                                    await session.start();
                                }
                                catch (error) {
                                    if (session.status().state !== 'unavailable' && session.status().state !== 'crashed')
                                        throw error;
                                }
                                finally {
                                    hosted.activeOperations--;
                                    touch(id);
                                }
                            }
                            else
                                await session.snapshot(text);
                        }, context, isCurrent);
                    }
                }
                for (const id of root.sessions)
                    touch(id);
                const active = op.op === 'external' ? rootSessions(root)
                    : [...(root.documents.get(op.path)?.sessions ?? [])].flatMap(id => {
                        const hosted = sessions.get(id);
                        return hosted ? [hosted.session] : [];
                    });
                return { status: 'ok', generation: root.generation, ...('version' in op ? { version: op.version } : {}), servers: active.map(s => s.status()), capabilities: active.length ? combineCapabilities(active) : emptyCapabilities() };
            }
            catch (error) {
                if (context?.signal?.aborted) return { status: 'error', errorCode: 'cancelled' };
                return errorResponse(error);
            }
        },
        async query(input, context) {
            const transient: Array<{
                id: string;
                session: ServerSession;
                path: string;
            }> = [];
            try {
                if (disposed)
                    return { status: 'unavailable', reason: 'session_unavailable' };
                context?.signal?.throwIfAborted();
                const root = rootFor(input.rootPath);
                if (input.generation !== undefined && input.generation !== root.generation)
                    return { status: 'error', errorCode: 'stale_query' };
                const languageId = input.languageId ?? root.documents.get(input.path)?.languageId ?? getFileLanguageFromPath(input.path) ?? '';
                const matching = definitions.findDefinitionsForDocument({ languageId: languageId || null, path: input.path }).filter(d => !input.serverId || d.id === input.serverId);
                if (!matching.length)
                    return { status: 'unavailable', reason: 'no_capable_server' };
                const absolute = resolveWorkspacePath({ rootPath: root.path, platform }, input.path);
                let diskText: string | undefined, fileHash: string | undefined;
                const existing = heldDocument(root, input.path);
                if (input.text === 'disk' || !existing) {
                    const bytes = await readFile(absolute);
                    diskText = bytes.toString('utf8');
                    fileHash = createHash('sha256').update(bytes).digest('hex');
                }
                const selections = await Promise.allSettled(matching.map(definition => ensureSession(root, input.path, definition, async ({ id, session }) => {
                    const path = localPath(session, root, input.path), held = session.document(path);
                    if (input.text === 'disk' && held?.unsaved)
                        throw new LspWorkspaceEditError('unsaved_editor_changes', fileHash!);
                    const sourceDocument = root.documents.get(input.path);
                    const selectedDiskText = input.text === 'disk' || !held ? diskText : undefined;
                    if (held && input.text !== 'disk') fileHash = undefined;
                    const changed = held && selectedDiskText !== undefined && selectedDiskText !== held.text;
                    const document = { path, languageId: held?.languageId ?? languageId, text: selectedDiskText ?? held?.text ?? existing?.text ?? '',
                        version: held ? held.version + (changed ? 1 : 0) : existing?.version ?? 0,
                        unsaved: selectedDiskText === undefined && (held?.unsaved ?? existing?.unsaved ?? false) };
                    // Enqueue the query's own reference before any await. An
                    // editor close or sibling cleanup cannot end its custody.
                    transient.push({ id, session, path });
                    await session.open(document);
                    if (!held && sourceDocument) {
                        for (let i = 0; i < sourceDocument.references; i++) await session.open(document);
                        sourceDocument.sessions.add(id);
                    }
                }, context)));
                const failedSelection = selections.find(selection => selection.status === 'rejected');
                if (failedSelection?.status === 'rejected') throw failedSelection.reason;
                const selected = selections.flatMap(selection => selection.status === 'fulfilled' ? [selection.value] : []);
                const document = selected[0].session.document(localPath(selected[0].session, root, input.path));
                if (!document)
                    return { status: 'error', errorCode: 'session_unavailable' };
                if (input.version !== undefined && input.version !== document.version)
                    return { status: 'error', errorCode: 'stale_query' };
                const position = input.position === undefined ? undefined : resolveDocumentPosition(document.text, input.position);
                if (input.kind === 'rename' && !input.newName || input.kind === 'willRenameFiles' && !input.newPath)
                    return { status: 'error', errorCode: 'invalid_request' };
                if ((input.kind === 'hover' || input.kind === 'definition' || input.kind === 'references' || input.kind === 'prepareRename' || input.kind === 'rename' || input.kind === 'codeActions' && !input.range) && !position)
                    return { status: 'error', errorCode: 'invalid_position' };
                const requestedGeneration = root.generation;
                const answers = await Promise.allSettled(selected.map(async ({ id, session }) => { const hosted = sessions.get(id)!; hosted.activeOperations++; touch(id); try {
                    const answer = await session.query({ path: localPath(session, root, input.path), kind: input.kind, position, includeDeclaration: input.includeDeclaration, newName: input.newName, newPath: input.newPath ? localPath(session, root, input.newPath) : undefined, range: input.range, signal: context?.signal });
                    return { session, answer };
                }
                finally {
                    hosted.activeOperations--;
                    touch(id);
                } }));
                if (requestedGeneration !== root.generation)
                    return { status: 'error', errorCode: 'stale_query' };
                const ready = answers.flatMap(answer => answer.status === 'fulfilled' ? [answer.value] : []);
                if (!ready.length) {
                    const errors = answers.flatMap(answer => answer.status === 'rejected' ? [answer.reason as unknown] : []);
                    if (errors.every(error => error instanceof LanguageServerSessionError && error.code === 'unsupported'))
                        return { status: 'unavailable', reason: 'no_capable_server' };
                    const failed = selected.map(({ session }) => session.status()).find(status => status.reason);
                    if (failed?.reason)
                        return { status: 'unavailable', reason: failed.reason };
                    return errorResponse(errors[0]);
                }
                const provenance = { status: 'ok' as const, version: document.version, generation: root.generation, ...(fileHash ? { fileHash } : {}) };
                let result = await projectResults(root, input.kind, ready, provenance, { ...input, position });
                if (result.kind === 'references')
                    result = pageLanguageServerReferences(result);
                if (requestedGeneration !== root.generation || ready.some(({ session, answer }) => session.status().generation !== answer.generation || answer.version !== document.version || session.document(localPath(session, root, input.path))?.version !== answer.version || session.document(localPath(session, root, input.path))?.text !== document.text))
                    return { status: 'error', errorCode: 'stale_query' };
                const isEmpty = result.kind === 'hover' ? result.sections.length === 0 : result.kind === 'documentSymbols' ? result.symbols.length === 0 : result.kind === 'diagnostics' ? result.diagnostics.length === 0 : result.kind === 'prepareRename' ? result.targets.length === 0 : result.kind === 'codeActions' ? result.actions.length === 0 : 'files' in result ? result.files.length === 0 : result.locations.length === 0;
                return isEmpty && ready.some(answer => answer.answer.loading) ? { status: 'loading' } : result;
            }
            catch (error) {
                return errorResponse(error);
            }
            finally {
                await Promise.all(transient.map(async ({ id, session, path }) => { try {
                    await closeDocument(id, session, path);
                }
                catch (error) {
                    logger.debug('[LSP] Transient cleanup failed', { error });
                } }));
            }
        },
        async apply(input, context) {
            const retained: Array<{ id: string; session: ServerSession; path: string }> = [];
            const results: Extract<DaemonWorkspaceFileReplaceApplyResponse, { ok: true }>['results'] = [];
            try {
                context?.signal?.throwIfAborted();
                const root = rootFor(input.rootPath);
                const applyFiles = async (files: WorkspaceFileEditSetFile[]) => {
                    for (const file of files) {
                        if (heldDocument(root, file.path)?.unsaved) {
                            const bytes = await readFile(resolveWorkspacePath({ rootPath: root.path, platform }, file.path));
                            throw new LspWorkspaceEditError('unsaved_editor_changes', createHash('sha256').update(bytes).digest('hex'));
                        }
                    }
                    const response = await applyWorkspaceFileReplace({ rootPath: root.path, operation: { kind: 'editSet', files } }, root.path,
                        { kind: 'restrictedRoots', roots: [root.path] }, context?.signal ? { signal: context.signal } : undefined);
                    if (response.ok) {
                        results.push(...response.results);
                        const renamed = response.results.flatMap(result => result.status === 'replaced' && result.renameTo ? [{ path: result.path, renameTo: result.renameTo }] : []);
                        for (const session of rootSessions(root)) {
                            for (const result of response.results) {
                                if (result.status !== 'replaced' || result.renameTo) continue;
                                let path: string;
                                try { path = localPath(session, root, result.path); } catch { continue; }
                                const held = session.document(path);
                                if (held && !held.unsaved) {
                                    const text = (await readFile(resolveWorkspacePath({ rootPath: root.path, platform }, result.path))).toString('utf8');
                                    await session.snapshot({ ...held, text, version: held.version + 1 });
                                }
                            }
                            if (renamed.length) await session.didRenameFiles(renamed.map(file => ({ path: localPath(session, root, file.path), renameTo: localPath(session, root, file.renameTo) })));
                        }
                    }
                    return response;
                };
                if (input.operation.kind !== 'codeAction') {
                    if (input.operation.kind === 'rename' && input.operation.files.some(file => file.renameTo)
                        || input.operation.kind === 'fileRename' && !input.operation.files.some(file => file.path === input.path && file.renameTo)) return { status: 'error', errorCode: 'invalid_request' };
                    return await applyFiles(input.operation.files);
                }
                const operation = input.operation;
                if (operation.action.disabledReason !== undefined) return { status: 'error', errorCode: 'unsupported' };
                const bytes = await readFile(resolveWorkspacePath({ rootPath: root.path, platform }, input.path));
                const diskHash = createHash('sha256').update(bytes).digest('hex');
                if (heldDocument(root, input.path)?.unsaved) return { status: 'error', errorCode: 'unsaved_editor_changes', diskHash };
                if (diskHash !== operation.expectedHash) return { status: 'error', errorCode: 'stale_query' };
                const languageId = input.languageId ?? root.documents.get(input.path)?.languageId ?? getFileLanguageFromPath(input.path) ?? '';
                const definition = definitions.findDefinitionsForDocument({ languageId, path: input.path }).find(item => item.id === operation.action.serverId);
                if (!definition) return { status: 'unavailable', reason: 'no_capable_server' };
                const { id, session } = await ensureSession(root, input.path, definition, async ({ id, session }) => {
                    const path = localPath(session, root, input.path), previous = session.document(path);
                    retained.push({ id, session, path });
                    await session.open({ path, languageId, text: bytes.toString('utf8'), version: previous?.version ?? 0, unsaved: false });
                }, context);
                const path = localPath(session, root, input.path);
                const hosted = sessions.get(id)!;
                hosted.activeOperations++;
                try {
                    const answer = await session.query({ path, kind: 'codeActions', range: operation.action.range, signal: context?.signal });
                    const current = await projectResults(root, 'codeActions', [{ session, answer }], { status: 'ok', fileHash: diskHash, version: answer.version, generation: answer.generation },
                        { rootPath: root.path, path: input.path, kind: 'codeActions', range: operation.action.range });
                    if (current.kind !== 'codeActions') throw new LspWorkspaceEditError('invalid_request');
                    const candidates = current.actions.filter(action => action.title === operation.action.title && action.kind === operation.action.kind);
                    if (candidates.length !== 1 || candidates[0].disabledReason !== undefined) return { status: 'error', errorCode: 'unsupported' };
                    const action = candidates[0];
                    if (action.hasCommand !== operation.action.hasCommand || JSON.stringify(action.files) !== JSON.stringify(operation.action.files)) return { status: 'error', errorCode: 'stale_query' };
                    const nativeAction = Array.isArray(answer.value) ? answer.value.map(readLspObject).find(value => value
                        && value.title === action.title && (typeof value.kind === 'string' ? value.kind : undefined) === action.kind) : undefined;
                    if (!nativeAction) throw new LspWorkspaceEditError('invalid_request');
                    const command = readCodeActionCommand(nativeAction);
                    const initial = await applyFiles(action.files);
                    if (!initial.ok || initial.results.some(result => result.status !== 'replaced' || result.reason !== undefined)) return initial;
                    if (command) await session.executeCommand(command, async edit => {
                        const files = await normalizeWorkspaceEdit({ rootPath: root.path, platform, edit, document: path => heldDocument(root, path) });
                        const applied = await applyFiles(files);
                        return applied.ok && applied.results.every(result => result.status === 'replaced' && result.reason === undefined);
                    }, context?.signal);
                    return { ok: true, results };
                } finally { hosted.activeOperations--; touch(id); }
            } catch (error) {
                if (results.length) return { ok: true, results: [...results, { path: input.path, status: 'failed', reason: context?.signal?.aborted ? 'cancelled' : error instanceof LanguageServerSessionError ? error.code : 'request_failed' }], ...(context?.signal?.aborted ? { cancelled: [input.path] } : {}) };
                return errorResponse(error);
            } finally {
                await Promise.all(retained.map(({ id, session, path }) => closeDocument(id, session, path)));
            }
        },
        async watch(input, context) {
            try {
                if (disposed)
                    return { status: 'unavailable', reason: 'session_unavailable' };
                const root = rootFor(input.rootPath);
                for (const id of root.sessions)
                    touch(id);
                if (input.sinceRevision === undefined)
                    return watchSnapshot(root);
                root.watchers++;
                try {
                    const result = await parkWatch({ signal: context?.signal, windowMs: MACHINE_WATCH_WINDOW_MS, isNewer: () => root.revision > input.sinceRevision!, subscribe: listener => { root.listeners.add(listener); return () => root.listeners.delete(listener); }, read: () => watchSnapshot(root, input.sinceRevision) });
                    return result.changed ? result.snapshot : watchSnapshot(root, input.sinceRevision);
                }
                finally {
                    root.watchers--;
                    for (const id of root.sessions)
                        touch(id);
                }
            }
            catch (error) {
                return errorResponse(error);
            }
        },
        async restart(input) {
            try {
                const root = rootFor(input.rootPath), selected = rootSessions(root).filter(s => !input.serverId || s.definition.id === input.serverId);
                if (!selected.length)
                    return { status: 'unavailable', reason: 'session_unavailable' };
                root.generation = randomUUID();
                await Promise.all(selected.map(session => session.restart()));
                return { status: 'ok' };
            }
            catch (error) {
                return errorResponse(error);
            }
        },
        async dispose() { disposed = true; for (const hosted of sessions.values())
            hosted.timer?.(); await Promise.all([...sessions.values()].map(({ session }) => session.dispose())); sessions.clear(); for (const root of roots.values())
            for (const listener of root.listeners)
                listener(); roots.clear(); },
    };
    async function projectResults(root: RootState, kind: DaemonLspQueryRequest['kind'], ready: Array<{
        session: ServerSession;
        answer: ServerSessionAnswer;
    }>, provenance: Readonly<{
        status: 'ok';
        version: number;
        generation: string;
        fileHash?: string;
    }>, input: DaemonLspQueryRequest): Promise<QueryOk> {
        const normalize = (edit: unknown) => normalizeWorkspaceEdit({ rootPath: root.path, platform, edit,
            document: path => heldDocument(root, path) });
        if (kind === 'prepareRename') return { ...provenance, kind, targets: ready.flatMap(({ session, answer }) => {
            if (answer.value === null) return [];
            const value = readLspObject(answer.value);
            if (!value) throw new LspWorkspaceEditError('invalid_request');
            return [{ serverId: session.definition.id, ...(value.defaultBehavior === true ? {} : { range: readLspRange(value.range ?? value) }), ...(typeof value.placeholder === 'string' ? { placeholder: value.placeholder } : {}) }];
        }) };
        if (kind === 'rename' || kind === 'willRenameFiles') {
            const edits = await Promise.all(ready.map(({ answer }) => normalize(answer.value)));
            const merged = await mergeEditSets(root.path, platform, edits.flat());
            if (kind === 'willRenameFiles') {
                const source = await normalizeWorkspaceEdit({ rootPath: root.path, platform, edit: null,
                    document: path => heldDocument(root, path), rename: { path: input.path, newPath: input.newPath! } });
                return { ...provenance, kind, files: await mergeEditSets(root.path, platform, [...source, ...merged]) };
            }
            return { ...provenance, kind, files: merged };
        }
        if (kind === 'codeActions') {
            const actions = [];
            for (const { session, answer } of ready) {
                if (answer.value === null) continue;
                if (!Array.isArray(answer.value)) throw new LspWorkspaceEditError('invalid_request');
                for (const raw of answer.value) {
                    const value = readLspObject(raw);
                    if (!value || typeof value.title !== 'string') throw new LspWorkspaceEditError('invalid_request');
                    const command = readCodeActionCommand(value);
                    const disabledReason = readLspObject(value.disabled)?.reason;
                    const position = input.position && 'character' in input.position ? input.position : undefined;
                    if (!input.range && !position) throw new LspWorkspaceEditError('invalid_request');
                    actions.push({ serverId: session.definition.id, title: value.title, range: input.range ?? { start: position!, end: position! }, files: await normalize(value.edit),
                        ...(typeof value.kind === 'string' ? { kind: value.kind } : {}),
                        hasCommand: command !== undefined,
                        ...(typeof disabledReason === 'string' ? { disabledReason } : {}) });
                }
            }
            return { ...provenance, kind, actions };
        }
        if (kind === 'hover')
            return { ...provenance, kind, sections: ready.flatMap(({ session, answer }) => { const hover = normalizeLspHover(answer.value); return hover ? [{ serverId: session.definition.id, label: session.definition.title, ...hover }] : []; }) };
        if (kind === 'documentSymbols')
            return { ...provenance, kind, symbols: unique(ready.flatMap(({ session, answer }) => normalizeLspDocumentSymbols(session.definition.id, answer.value)), item => JSON.stringify([item.name, item.kind, item.selectionRange])), hasMore: false };
        if (kind === 'diagnostics')
            return { ...provenance, kind, diagnostics: unique(ready.flatMap(({ session, answer }) => (answer.value as LanguageIntelligenceDiagnostic[]).map(item => ({ ...item, path: relative(root.path, resolve(session.workspaceRoot, item.path)).replaceAll('\\', '/') }))), item => JSON.stringify([item.path, item.range, item.severity, item.code, item.message])), hasMore: false };
        const locations: Array<{
            serverId: string;
            path: string;
            outsideWorkspace?: boolean;
            range: ReturnType<typeof readLspRange>;
            lineText: string;
        }> = [];
        for (const { session, answer } of ready) {
            const items = answer.value === null ? [] : Array.isArray(answer.value) ? answer.value : [answer.value];
            for (const item of items) {
                const location = readLspObject(item);
                if (!location)
                    throw new Error('Invalid language-server location');
                const uri = location.uri ?? location.targetUri;
                if (typeof uri !== 'string')
                    throw new Error('Invalid language-server location URI');
                const target = workspaceUriToPath({ rootPath: root.path, platform }, uri), range = readLspRange(location.range ?? location.targetSelectionRange ?? location.targetRange);
                if (kind === 'references' && target.outsideWorkspace)
                    continue;
                let lineText = '';
                if (kind === 'references') {
                    const absolute = resolveWorkspacePath({ rootPath: root.path, platform }, target.path), held = session.document(relative(session.workspaceRoot, absolute).replaceAll('\\', '/'));
                    lineText = readDocumentLine(held?.text ?? (await readFile(absolute)).toString('utf8'), range.start.line);
                }
                locations.push({ serverId: session.definition.id, ...target, range, lineText });
            }
        }
        const deduped = unique(locations, item => JSON.stringify([item.path, item.range]));
        if (kind === 'references')
            return { ...provenance, kind, locations: deduped.map(({ outsideWorkspace, ...item }) => item), hasMore: false };
        return { ...provenance, kind, locations: deduped.map(({ lineText, ...item }) => item), hasMore: false };
    }
    return host;
}
let configuredOptions: LanguageServerHostOptions | undefined;
let sharedHost: LanguageServerHost | undefined;
export function configureLanguageServerHost(options: LanguageServerHostOptions): void {
    if (sharedHost)
        throw new Error('Language-server host is already serving');
    configuredOptions = options;
}
export function getLanguageServerHost(): LanguageServerHost { return sharedHost ??= createLanguageServerHost(configuredOptions); }
export function readLanguageServerProcessRoots(): readonly HappierProcessRootSource[] { return sharedHost?.readProcessRoots() ?? []; }
export async function disposeLanguageServerHost(): Promise<void> { const host = sharedHost; sharedHost = undefined; configuredOptions = undefined; await host?.dispose(); }
export function pageLanguageServerReferences(result: Extract<DaemonLspQueryResponse, {
    status: 'ok';
    kind: 'references';
}>): typeof result {
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES)
        return result;
    // A changed completeness flag must mean at least one location was omitted;
    // `true` itself occupies one fewer JSON byte than `false`.
    let first = 0, last = Math.max(0, result.locations.length - 1);
    while (first < last) {
        const middle = Math.ceil((first + last) / 2);
        if (Buffer.byteLength(JSON.stringify({ ...result, locations: result.locations.slice(0, middle), hasMore: true }), 'utf8') <= DEFAULT_MACHINE_TUNNEL_SERVER_ROUTED_MAX_RAW_PAYLOAD_BYTES)
            first = middle;
        else
            last = middle - 1;
    }
    return { ...result, locations: result.locations.slice(0, first), hasMore: true };
}
