type BrowserRecordStorageModule = typeof import('@/sync/domains/state/browserRecordStorage');

/** IndexedDB boundary fixture; keeps the synchronous transactional update contract. */
export function createBrowserRecordStorageModuleMock(): BrowserRecordStorageModule {
    const records = new Map<string, string>();
    const updateBrowserRecord: BrowserRecordStorageModule['updateBrowserRecord'] = async (key, update) => {
        const next = update(records.get(key));
        if (next.value === undefined) records.delete(key);
        else records.set(key, next.value);
        return next.result;
    };
    return {
        // This fixture substitutes record transactions; callers needing raw IndexedDB must install that OS boundary.
        openBrowserRecordDatabase: async () => { throw new Error('Raw IndexedDB is not configured by the browser record fixture'); },
        readBrowserRecord: async (key) => records.get(key),
        updateBrowserRecord,
        writeBrowserRecord: (key, value) => updateBrowserRecord(key, () => ({ value, result: undefined })),
        deleteBrowserRecord: (key) => updateBrowserRecord(key, () => ({ value: undefined, result: undefined })),
        listBrowserRecords: async (prefix) => new Map([...records].filter(([key]) => key.startsWith(prefix))),
        clearBrowserRecords: async () => { records.clear(); },
        clearEmbedBrowserRecords: () => { records.clear(); },
    };
}
