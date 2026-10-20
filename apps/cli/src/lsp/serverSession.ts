import type { PluginProtocolClientHandle } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { ProcessOwnerRef } from '@/processes/ownerTag';
import { resolveCanonicalAbsolutePathComparisonIdentity } from '@/utils/path/expandHomeDirPath';
import { logger } from '@/ui/logger';
import { disposePluginProtocolClientGracefullyForHost } from '@/plugins/runtime/invocation/services/exec';
import type { LanguageServerDefinition } from './languageServerDefinitions';
import type { LanguageIntelligenceCapabilities, LanguageIntelligenceDiagnosticsEntry, LanguageIntelligencePosition, LanguageIntelligenceServerStatus } from '@happier-dev/protocol/machines/languageIntelligence';
import { applyDocumentTextEdit } from './documentText';
import { createDiagnosticsPullScheduler } from './diagnosticsPull';
import { normalizeLspDiagnostics, readLspObject } from './languageServerResults';
import { workspacePathToUri, workspaceUriToPath } from './workspaceUris';
export type LanguageServerDocument = Readonly<{
    path: string;
    languageId: string;
    text: string;
    version: number;
    unsaved: boolean;
}>;
export type LanguageServerChange = Readonly<{
    path: string;
    version: number;
    baseVersion: number;
    edit: {
        startLine: number;
        startCharacter: number;
        endLine: number;
        endCharacter: number;
        text: string;
    };
    unsaved: boolean;
}>;
export type OpenLanguageServerProtocol = (input: Readonly<{
    definition: LanguageServerDefinition;
    rootPath: string;
    processOwner: ProcessOwnerRef;
    signal: AbortSignal;
}>) => Promise<PluginProtocolClientHandle<'jsonRpc'>>;
export type ServerSessionQuery = Readonly<{
    path: string;
    kind: 'hover' | 'definition' | 'references' | 'documentSymbols' | 'diagnostics';
    position?: LanguageIntelligencePosition;
    includeDeclaration?: boolean;
    signal?: AbortSignal;
}>;
export type ServerSessionAnswer = Readonly<{
    value: unknown;
    loading: boolean;
    generation: string;
    version: number;
}>;
export class LanguageServerSessionError extends Error {
    constructor(readonly code: 'session_unavailable' | 'document_out_of_sync' | 'stale_query' | 'cancelled' | 'request_failed' | 'unsupported', options?: ErrorOptions) { super(code, options); }
}
export type ServerSession = Readonly<{
    definition: LanguageServerDefinition;
    rootPath: string;
    workspaceRoot: string;
    diagnostics: ReadonlyMap<string, LanguageIntelligenceDiagnosticsEntry>;
    status(): LanguageIntelligenceServerStatus;
    capabilities(): LanguageIntelligenceCapabilities;
    document(path: string): LanguageServerDocument | undefined;
    paths(): readonly string[];
    open(document: LanguageServerDocument): Promise<void>;
    snapshot(document: LanguageServerDocument): Promise<void>;
    change(input: LanguageServerChange): Promise<void>;
    close(path: string): Promise<void>;
    start(): Promise<void>;
    external(paths: readonly string[], workspaceRoot?: string): Promise<void>;
    query(input: ServerSessionQuery): Promise<ServerSessionAnswer>;
    restart(): Promise<void>;
    dispose(): Promise<void>;
}>;
export type CreateServerSessionOptions = Readonly<{
    definition: LanguageServerDefinition;
    rootPath: string;
    workspaceRoot: string;
    openProtocol: OpenLanguageServerProtocol;
    onChange(): void;
    platform?: NodeJS.Platform;
}>;
export function createServerSession(options: CreateServerSessionOptions): ServerSession {
    const documents = new Map<string, LanguageServerDocument & {
        references: number;
    }>();
    const diagnostics = new Map<string, LanguageIntelligenceDiagnosticsEntry>();
    const hiddenDiagnostics: ReadonlyMap<string, LanguageIntelligenceDiagnosticsEntry> = new Map();
    const platform = options.platform ?? process.platform;
    const uriContext = { rootPath: options.workspaceRoot, platform };
    let generation = randomUUID();
    let state: LanguageIntelligenceServerStatus['state'] = 'idle';
    let reason: LanguageIntelligenceServerStatus['reason'];
    let stderrPreview: string | undefined;
    let protocol: PluginProtocolClientHandle<'jsonRpc'> | undefined;
    let lifetime: AbortController | undefined;
    let starting: Promise<void> | undefined;
    let operations: Promise<void> = Promise.resolve();
    let stopping = false;
    let disposed = false;
    let diagnosticsEnabled = false;
    let watchedFilesRegistered = false;
    let syncKind = 0;
    const progressTokens = new Set<string | number>();
    const loadingTokens = new Set<string | number>();
    let capabilities: LanguageIntelligenceCapabilities = { hover: false, definition: false, references: false, documentSymbol: false, diagnostics: 'none', acceptsExternalChanges: false };
    const changed = () => options.onChange();
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        const result = operations.then(operation);
        operations = result.then(() => undefined, () => undefined);
        return result;
    };
    const uri = (path: string) => workspacePathToUri(uriContext, path);
    const clearDiagnostics = () => {
        for (const [path, entry] of diagnostics)
            diagnostics.set(path, { ...entry, generation, items: [], state: 'unavailable' });
        changed();
    };
    const failure = (error: unknown): LanguageServerSessionError => {
        const value = readLspObject(error);
        if (value?.code === -32801)
            return new LanguageServerSessionError('stale_query', { cause: error });
        if (value?.code === -32800 || value?.code === -32802 || value?.code === 'PLUGIN_EXEC_CLIENT_ABORTED')
            return new LanguageServerSessionError('cancelled', { cause: error });
        return error instanceof LanguageServerSessionError ? error : new LanguageServerSessionError('request_failed', { cause: error });
    };
    const pulls = createDiagnosticsPullScheduler({ async pull(path, signal) {
            const document = documents.get(path), client = protocol?.client;
            if (!document || !client || state !== 'ready' || !diagnosticsEnabled)
                return;
            const requestGeneration = generation, version = document.version;
            const previous = diagnostics.get(path);
            diagnostics.set(path, { state: 'checking', version, generation, items: previous?.items ?? [] });
            changed();
            try {
                const raw = await client.request('textDocument/diagnostic', { textDocument: { uri: uri(path) } }, { signal });
                if (signal.aborted || requestGeneration !== generation || documents.get(path)?.version !== version || documents.get(path)?.text !== document.text)
                    return;
                const report = readLspObject(raw);
                if (report?.kind !== 'full')
                    throw new Error('Language server returned an unsupported diagnostic report');
                diagnostics.set(path, { state: loadingTokens.size ? 'checking' : 'ready', version, generation, items: normalizeLspDiagnostics(options.definition.id, path, report.items) });
                changed();
            }
            catch (error) {
                if (!signal.aborted && requestGeneration === generation && documents.get(path)?.version === version && documents.get(path)?.text === document.text) {
                    diagnostics.set(path, { state: 'unavailable', version, generation, items: previous?.items ?? [] });
                    changed();
                }
                throw error;
            }
        } });
    const pullSoon = (path: string) => { if (diagnosticsEnabled && capabilities.diagnostics === 'pull')
        void pulls.trigger(path).catch(error => logger.debug('[LSP] Diagnostics pull failed', { serverId: options.definition.id, error })); };
    const refresh = async (signal?: AbortSignal) => {
        if (!diagnosticsEnabled || capabilities.diagnostics !== 'pull') return;
        for (const path of [...documents.keys()]) {
            if (signal?.aborted) return;
            try { await pulls.trigger(path); }
            catch (error) { logger.debug('[LSP] Diagnostics refresh failed', { serverId: options.definition.id, path, error }); }
        }
    };
    const notifyOpen = async (document: LanguageServerDocument) => {
        await protocol?.client.notify('textDocument/didOpen', { textDocument: { uri: uri(document.path), languageId: options.definition.languageIds[document.languageId] ?? document.languageId, version: document.version, text: document.text } });
    };
    const notifySnapshot = async (document: LanguageServerDocument) => {
        if (syncKind !== 0)
            await protocol?.client.notify('textDocument/didChange', { textDocument: { uri: uri(document.path), version: document.version }, contentChanges: [{ text: document.text }] });
    };
    async function start(): Promise<void> {
        if (disposed || stopping)
            throw new LanguageServerSessionError('session_unavailable');
        if (state === 'ready')
            return;
        if (starting)
            return await starting;
        if (state === 'crashed' || state === 'unavailable' || state === 'stopped')
            throw new LanguageServerSessionError('session_unavailable');
        state = 'starting';
        generation = randomUUID();
        reason = undefined;
        stderrPreview = undefined;
        changed();
        const nativeGeneration = generation;
        lifetime = new AbortController();
        starting = (async () => {
            try {
                const rootIdentity = resolveCanonicalAbsolutePathComparisonIdentity(options.rootPath, { platform });
                if (rootIdentity === null)
                    throw new Error('Language-server root is invalid');
                const rootHash = createHash('sha256').update(rootIdentity).digest('hex').slice(0, 12);
                const opened = await options.openProtocol({ definition: options.definition, rootPath: options.rootPath, signal: lifetime!.signal, processOwner: { kind: 'service', serviceId: `lsp:${options.definition.id}:${rootHash}`, pluginId: options.definition.pluginId } });
                if (disposed || nativeGeneration !== generation) {
                    await opened.dispose();
                    throw new LanguageServerSessionError('session_unavailable');
                }
                protocol = opened;
                void opened.wait().then(() => {
                    if (!stopping && nativeGeneration === generation && (state === 'starting' || state === 'ready')) {
                        state = state === 'starting' ? 'unavailable' : 'crashed';
                        reason = state === 'crashed' ? 'crashed' : 'start_failed';
                        clearDiagnostics();
                    }
                }, error => logger.debug('[LSP] Process exit observation failed', { serverId: options.definition.id, error }));
                const client = opened.client;
                client.onRequest('client/registerCapability', request => {
                    const params = readLspObject(request.params);
                    if (Array.isArray(params?.registrations) && params.registrations.some(item => readLspObject(item)?.method === 'workspace/didChangeWatchedFiles'))
                        watchedFilesRegistered = true;
                    capabilities = { ...capabilities, acceptsExternalChanges: platform === 'linux' && watchedFilesRegistered };
                    changed();
                    return null;
                });
                client.onRequest('client/unregisterCapability', () => { watchedFilesRegistered = false; capabilities = { ...capabilities, acceptsExternalChanges: false }; changed(); return null; });
                const folders = [{ uri: pathToFileURL(options.rootPath, { windows: platform === 'win32' }).href, name: options.rootPath }];
                client.onRequest('workspace/workspaceFolders', () => folders);
                client.onRequest('workspace/configuration', request => {
                    const params = readLspObject(request.params);
                    return Array.isArray(params?.items) ? params.items.map(item => {
                        const section = readLspObject(item)?.section;
                        if (typeof section !== 'string')
                            return null;
                        let value: unknown = options.definition.settings;
                        for (const segment of section.split('.'))
                            value = readLspObject(value)?.[segment];
                        return value === undefined ? null : value as JsonValue;
                    }) : [];
                });
                client.onRequest('window/workDoneProgress/create', request => { const token = readLspObject(request.params)?.token; if (typeof token === 'string' || typeof token === 'number')
                    progressTokens.add(token); return null; });
                client.onRequest('workspace/diagnostic/refresh', () => { if (nativeGeneration === generation && !stopping) void refresh().catch(error => logger.debug('[LSP] Diagnostics refresh failed', { serverId: options.definition.id, error })); return null; });
                client.onRequest('workspace/applyEdit', () => ({ applied: false }));
                client.onRequest('window/showMessageRequest', () => null);
                client.onNotification(message => {
                    if (nativeGeneration !== generation || stopping) return;
                    const params = readLspObject(message.params);
                    if (message.method === '$/progress') {
                        const token = params?.token, value = readLspObject(params?.value);
                        if ((typeof token === 'string' || typeof token === 'number') && progressTokens.has(token)) {
                            if (value?.kind === 'begin')
                                loadingTokens.add(token);
                            if (value?.kind === 'end') {
                                loadingTokens.delete(token);
                                if (loadingTokens.size === 0) {
                                    for (const [path, entry] of diagnostics) {
                                        if (entry.state !== 'checking') continue;
                                        if (capabilities.diagnostics === 'pull') pullSoon(path);
                                        else if (capabilities.diagnostics === 'push' && entry.generation === generation && documents.get(path)?.version === entry.version) {
                                            diagnostics.set(path, { ...entry, state: 'ready' });
                                        }
                                    }
                                }
                            }
                            changed();
                            return;
                        }
                    }
                    if (message.method === 'textDocument/publishDiagnostics' && typeof params?.uri === 'string') {
                        try {
                            const location = workspaceUriToPath(uriContext, params.uri);
                            const document = documents.get(location.path);
                            if (location.outsideWorkspace || !document || (params.version !== undefined && params.version !== document.version))
                                return;
                            diagnostics.set(location.path, { state: loadingTokens.size ? 'checking' : 'ready', version: document.version, generation, items: normalizeLspDiagnostics(options.definition.id, location.path, params.diagnostics) });
                            if (diagnosticsEnabled) changed();
                            return;
                        }
                        catch (error) {
                            logger.debug('[LSP] Invalid pushed diagnostics', { serverId: options.definition.id, error });
                            return;
                        }
                    }
                    logger.debug('[LSP] Server notification', { serverId: options.definition.id, method: message.method });
                });
                const initialized = readLspObject(await client.request('initialize', {
                    processId: process.pid, rootUri: folders[0].uri, workspaceFolders: folders,
                    ...(options.definition.initializationOptions === undefined ? {} : { initializationOptions: options.definition.initializationOptions }),
                    capabilities: { general: { positionEncodings: ['utf-16'] }, textDocument: { synchronization: { dynamicRegistration: false, didSave: false }, hover: { contentFormat: ['markdown', 'plaintext'] }, definition: { linkSupport: false }, references: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true }, publishDiagnostics: { versionSupport: true }, diagnostic: {} }, window: { workDoneProgress: true }, workspace: { workspaceFolders: true, applyEdit: false, diagnostics: { refreshSupport: true }, ...(options.definition.settings === undefined ? {} : { configuration: true }), ...(platform === 'linux' ? { didChangeWatchedFiles: { dynamicRegistration: true } } : {}) } }
                }, { signal: lifetime!.signal }));
                const native = readLspObject(initialized?.capabilities);
                if (!native)
                    throw new Error('Language server initialize capabilities are missing');
                const sync = readLspObject(native.textDocumentSync);
                syncKind = typeof native.textDocumentSync === 'number' ? native.textDocumentSync : typeof sync?.change === 'number' ? sync.change : 0;
                capabilities = { hover: !!native.hoverProvider, definition: !!native.definitionProvider, references: !!native.referencesProvider, documentSymbol: !!native.documentSymbolProvider, diagnostics: native.diagnosticProvider ? 'pull' : 'push', acceptsExternalChanges: platform === 'linux' && watchedFilesRegistered };
                await client.notify('initialized', {});
                await enqueue(async () => { for (const document of documents.values())
                    await notifyOpen(document); });
                state = 'ready';
                changed();
            }
            catch (error) {
                const detail = readLspObject(error);
                if (nativeGeneration === generation && !stopping) {
                    state = 'unavailable';
                    reason = detail?.reason === 'server_missing' ? 'server_missing' : 'start_failed';
                    stderrPreview = typeof detail?.stderrPreview === 'string' ? detail.stderrPreview : undefined;
                    clearDiagnostics();
                }
                await protocol?.dispose().catch(cleanupError => logger.debug('[LSP] Failed-start cleanup failed', { serverId: options.definition.id, error: cleanupError }));
                protocol = undefined;
                throw new LanguageServerSessionError('session_unavailable', { cause: error });
            }
            finally {
                starting = undefined;
            }
        })();
        return await starting;
    }
    async function stop(): Promise<void> {
        stopping = true;
        for (const path of documents.keys())
            pulls.cancel(path);
        const opened = protocol;
        if (starting) {
            lifetime?.abort();
            await starting.catch(() => undefined);
        }
        if (opened)
            await disposePluginProtocolClientGracefullyForHost(opened, async (signal) => {
                if (state === 'ready') {
                    await opened.client.request('shutdown', undefined, { signal });
                    await opened.client.notify('exit');
                }
            });
        lifetime?.abort();
        protocol = undefined;
        state = 'stopped';
        loadingTokens.clear();
        progressTokens.clear();
        watchedFilesRegistered = false;
        stopping = false;
        clearDiagnostics();
    }
    const session: ServerSession = {
        definition: options.definition, rootPath: options.rootPath, workspaceRoot: options.workspaceRoot,
        get diagnostics() { return diagnosticsEnabled ? diagnostics : hiddenDiagnostics; },
        status: () => ({ serverId: options.definition.id, label: options.definition.title, state, loading: loadingTokens.size > 0, generation, ...(reason ? { reason } : {}), ...(stderrPreview ? { stderrPreview } : {}),
            ...(reason === 'server_missing' && options.definition.executable.kind === 'managedDependency' ? { installable: { pluginId: typeof options.definition.executable.id === 'string' ? options.definition.pluginId : options.definition.executable.id.pluginId, dependencyId: typeof options.definition.executable.id === 'string' ? options.definition.executable.id : options.definition.executable.id.localId } } : {}),
        }),
        capabilities: () => capabilities,
        document: path => documents.get(path), paths: () => [...documents.keys()],
        start,
        open: document => enqueue(async () => { const previous = documents.get(document.path); documents.set(document.path, { ...document, references: (previous?.references ?? 0) + 1 }); if (state === 'ready') {
            if (previous)
                await notifySnapshot(document);
            else
                await notifyOpen(document);
            pullSoon(document.path);
        } }),
        snapshot: document => enqueue(async () => { const previous = documents.get(document.path); if (!previous)
            throw new LanguageServerSessionError('document_out_of_sync'); documents.set(document.path, { ...document, references: previous.references }); if (state === 'ready') {
            await notifySnapshot(document);
            pullSoon(document.path);
        } }),
        change: input => enqueue(async () => { const previous = documents.get(input.path); if (!previous || previous.version !== input.baseVersion || input.version <= previous.version)
            throw new LanguageServerSessionError('document_out_of_sync'); const document = { ...previous, text: applyDocumentTextEdit(previous.text, input.edit), version: input.version, unsaved: input.unsaved }; documents.set(input.path, document); if (state === 'ready' && syncKind !== 0) {
            await protocol!.client.notify('textDocument/didChange', { textDocument: { uri: uri(input.path), version: input.version }, contentChanges: syncKind === 1 ? [{ text: document.text }] : [{ range: { start: { line: input.edit.startLine, character: input.edit.startCharacter }, end: { line: input.edit.endLine, character: input.edit.endCharacter } }, text: input.edit.text }] });
            pullSoon(input.path);
        } }),
        async close(path) { await enqueue(async () => { const previous = documents.get(path); if (!previous)
            return; if (previous.references > 1) {
            documents.set(path, { ...previous, references: previous.references - 1 });
            return;
        } documents.delete(path); pulls.cancel(path); diagnostics.delete(path); if (state === 'ready')
            await protocol!.client.notify('textDocument/didClose', { textDocument: { uri: uri(path) } }); changed(); }); if (documents.size === 0)
            await stop(); },
        external: (paths, workspaceRoot) => enqueue(async () => { if (state === 'ready' && capabilities.acceptsExternalChanges)
            await protocol!.client.notify('workspace/didChangeWatchedFiles', { changes: paths.map(path => ({ uri: workspacePathToUri({ rootPath: workspaceRoot ?? options.workspaceRoot, platform }, path), type: 2 })) }); }),
        async query(input) {
            if (input.signal?.aborted)
                throw new LanguageServerSessionError('cancelled');
            if (input.kind === 'diagnostics' && !diagnosticsEnabled) {
                diagnosticsEnabled = true;
                changed();
            }
            await start();
            await operations;
            const document = documents.get(input.path), opened = protocol;
            if (!document || !opened || state !== 'ready')
                throw new LanguageServerSessionError('session_unavailable');
            const requestGeneration = generation, version = document.version, wasLoading = loadingTokens.size > 0;
            const supported = input.kind === 'documentSymbols' ? capabilities.documentSymbol : input.kind === 'diagnostics' ? capabilities.diagnostics !== 'none' : capabilities[input.kind];
            if (!supported)
                throw new LanguageServerSessionError('unsupported');
            try {
                let value: unknown;
                let diagnosticsLoading = false;
                if (input.kind === 'diagnostics') {
                    if (capabilities.diagnostics === 'pull') {
                        const paths = [...documents.keys()];
                        const cancel = () => { for (const path of paths) pulls.cancel(path); };
                        input.signal?.addEventListener('abort', cancel, { once: true });
                        try {
                            if (input.signal?.aborted) throw new LanguageServerSessionError('cancelled');
                            await refresh(input.signal);
                            if (input.signal?.aborted) throw new LanguageServerSessionError('cancelled');
                        } finally {
                            input.signal?.removeEventListener('abort', cancel);
                        }
                    }
                    const entry = diagnostics.get(input.path);
                    if (capabilities.diagnostics === 'push' && (!entry || entry.generation !== generation || entry.version !== version || entry.state === 'unavailable')) {
                        // No push is not an authoritative empty report. Keep only
                        // observed reports in the store while the caller waits.
                        value = [];
                        diagnosticsLoading = true;
                    } else {
                        if (!entry || entry.state === 'unavailable') throw new LanguageServerSessionError('request_failed');
                        value = entry.items;
                        diagnosticsLoading = entry.state === 'checking';
                    }
                }
                else {
                    const method = input.kind === 'documentSymbols' ? 'documentSymbol' : input.kind;
                    value = await opened.client.request(`textDocument/${method}`, { textDocument: { uri: uri(input.path) }, ...(input.position ? { position: input.position } : {}), ...(input.kind === 'references' ? { context: { includeDeclaration: input.includeDeclaration ?? true } } : {}) }, { signal: input.signal });
                }
                if (requestGeneration !== generation || documents.get(input.path)?.version !== version || documents.get(input.path)?.text !== document.text)
                    throw new LanguageServerSessionError('stale_query');
                return { value, loading: diagnosticsLoading || wasLoading || loadingTokens.size > 0, generation: requestGeneration, version };
            }
            catch (error) {
                if (disposed || stopping) throw new LanguageServerSessionError('session_unavailable', { cause: error });
                if (requestGeneration !== generation) throw new LanguageServerSessionError('stale_query', { cause: error });
                throw failure(error);
            }
        },
        async restart() { await stop(); if (disposed)
            return; state = 'idle'; reason = undefined; generation = randomUUID(); if (documents.size)
            await start().catch(() => undefined); },
        async dispose() { disposed = true; await stop(); pulls.dispose(); documents.clear(); },
    };
    return session;
}
