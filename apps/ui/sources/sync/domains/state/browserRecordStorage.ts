/** Device-local large records. A successful write means the IndexedDB transaction committed. */
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';

const STORE = 'records';

type BrowserRecordStore = 'records' | 'pictures';
const connections = new Map<BrowserRecordStore, Promise<IDBDatabase>>();
const memoryRecords = new Map<string, string>();

/** Hard embed retirement never opens or clears full-app IndexedDB storage. */
export function clearEmbedBrowserRecords(): void {
    if (isEmbedWindowContext()) memoryRecords.clear();
}

/** One connection owner, with picture bytes isolated from 0.2's version-one records database. */
export function openBrowserRecordDatabase(store: BrowserRecordStore = 'records'): Promise<IDBDatabase> {
    if (isEmbedWindowContext()) return Promise.reject(new Error('Device picture storage is unavailable in an embed.'));
    let connection = connections.get(store);
    if (connection) return connection;
    connection = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('Browser storage is unavailable; local changes cannot be saved.'));
            return;
        }
        // Do not upgrade the records database: 0.2's same-origin opener explicitly requests version 1.
        const request = indexedDB.open(store === 'records' ? 'happier-local-records' : 'happier-atmosphere-pictures');
        request.onupgradeneeded = () => {
            request.result.createObjectStore(store);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Browser storage upgrade is blocked by another tab.'));
        request.onsuccess = () => {
            const database = request.result;
            const openedConnection = connections.get(store);
            const invalidateConnection = () => {
                if (connections.get(store) === openedConnection) connections.delete(store);
            };
            database.onclose = () => {
                invalidateConnection();
                console.warn('Browser record storage connection closed unexpectedly; the next operation will reopen it.');
            };
            database.onversionchange = () => {
                database.close();
                invalidateConnection();
            };
            resolve(database);
        };
    }).catch((error: unknown) => {
        connections.delete(store);
        throw error;
    });
    connections.set(store, connection);
    return connection;
}

export async function readBrowserRecord(key: string): Promise<string | undefined> {
    if (isEmbedWindowContext()) return memoryRecords.get(key);
    const database = await openBrowserRecordDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readonly');
        const request = transaction.objectStore(STORE).get(key);
        transaction.oncomplete = () => {
            if (request.result !== undefined && typeof request.result !== 'string') {
                reject(new Error('Invalid browser record; stored data was preserved.'));
            } else {
                resolve(request.result);
            }
        };
        transaction.onabort = () => reject(transaction.error ?? new Error('Browser record read aborted.'));
        transaction.onerror = () => reject(transaction.error);
    });
}

/** The synchronous callback runs within one transaction, including concurrent tabs. */
export async function updateBrowserRecord<T>(
    key: string,
    update: (current: string | undefined) => { value: string | undefined; result: T },
): Promise<T> {
    if (isEmbedWindowContext()) {
        // The synchronous update preserves the transaction owner's read/modify/write semantics
        // in the frame's one JavaScript realm, without cross-tab storage or coordination.
        const next = update(memoryRecords.get(key));
        if (next.value === undefined) memoryRecords.delete(key);
        else memoryRecords.set(key, next.value);
        return next.result;
    }
    const database = await openBrowserRecordDatabase();
    return new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readwrite', { durability: 'strict' });
        const store = transaction.objectStore(STORE);
        const request = store.get(key);
        let result: T;
        request.onsuccess = () => {
            try {
                if (request.result !== undefined && typeof request.result !== 'string') {
                    throw new Error('Invalid browser record; stored data was preserved.');
                }
                const next = update(request.result);
                result = next.result;
                if (next.value === undefined) store.delete(key);
                else store.put(next.value, key);
            } catch (error) {
                transaction.abort();
                reject(error);
            }
        };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(transaction.error ?? new Error('Browser record write aborted.'));
        transaction.onerror = () => reject(transaction.error);
    });
}

export function writeBrowserRecord(key: string, value: string): Promise<void> {
    return updateBrowserRecord(key, () => ({ value, result: undefined }));
}

export function deleteBrowserRecord(key: string): Promise<void> {
    return updateBrowserRecord(key, () => ({ value: undefined, result: undefined }));
}

export async function clearBrowserRecords(): Promise<void> {
    if (isEmbedWindowContext()) { memoryRecords.clear(); return; }
    const database = await openBrowserRecordDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readwrite', { durability: 'strict' });
        transaction.objectStore(STORE).clear();
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('Browser record clear aborted.'));
        transaction.onerror = () => reject(transaction.error);
    });
}

export async function listBrowserRecords(prefix: string): Promise<Map<string, string>> {
    if (isEmbedWindowContext()) return new Map(Array.from(memoryRecords).filter(([key]) => key.startsWith(prefix)));
    const database = await openBrowserRecordDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readonly');
        const request = transaction.objectStore(STORE).openCursor();
        const records = new Map<string, string>();
        request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
                if (typeof cursor.value !== 'string') {
                    transaction.abort();
                    reject(new Error('Invalid browser record; stored data was preserved.'));
                    return;
                }
                records.set(cursor.key, cursor.value);
            }
            cursor.continue();
        };
        transaction.oncomplete = () => resolve(records);
        transaction.onabort = () => reject(transaction.error ?? new Error('Browser record listing aborted.'));
        transaction.onerror = () => reject(transaction.error);
    });
}
