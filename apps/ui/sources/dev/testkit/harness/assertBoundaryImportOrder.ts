type CachedModule = Readonly<{ exports?: unknown; importers?: ReadonlySet<string> }>;
const boundaryOriginals = new WeakSet<object>();

/** Preserve importOriginal provenance when Vitest evicts a re-registered mock. */
export function recordBoundaryImportOriginal(module: object): void {
    boundaryOriginals.add(module);
}

/** Refuse a late doMock: it cannot repair references held by earlier consumers. */
export function assertBoundaryImportOrder(installer: string, modules: readonly string[]): void {
    // Vitest 3.2's worker cache holds the exports returned by importActual.
    // Keep this runner detail here; never import a live transport to check it.
    const cache = (globalThis as {
        __vitest_worker__?: { moduleCache?: ReadonlyMap<string, CachedModule> };
    }).__vitest_worker__?.moduleCache;
    if (!cache) {
        throw new Error(`[testkit] ${installer} cannot verify import order: Vitest's module cache is unavailable`);
    }
    for (const [id, entry] of cache) {
        if (id.startsWith('mock:') || !entry.exports) continue;
        const normalizedId = id.replaceAll('\\', '/');
        const module = modules.find(target => target.startsWith('@/')
            ? normalizedId.endsWith(`/sources/${target.slice(2)}.ts`)
            : normalizedId.includes(`/node_modules/${target}/`));
        if (!module) continue;
        // Record the actual namespace, rather than the transient mock cache:
        // doMock evicts that cache on the next import, but existing consumers
        // retain their valid, call-time delegate. New real namespaces after
        // resetModules still require their own correctly installed boundary.
        if (typeof entry.exports === 'object' && boundaryOriginals.has(entry.exports)) continue;
        throw new Error(
            `[testkit] ${installer}: ${module} was imported before boundary installation. `
            + 'Install the boundary before loading screens or runtime consumers; use a dynamic import after installation. '
            + 'A late vi.doMock leaves earlier consumers bound to the real, disconnected transport.',
            { cause: { importers: [...(entry.importers ?? [])] } },
        );
    }
}
