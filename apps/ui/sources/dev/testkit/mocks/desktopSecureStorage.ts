/** The desktop SDK invoke boundary; the real credential/desktop owners stay live. */
export function createDesktopSecureStorageBoundary() {
    const values = new Map<string, string>();
    async function invoke(command: string, args?: Readonly<Record<string, unknown>>): Promise<unknown> {
        if (command !== 'desktop_secure_storage_read'
            && command !== 'desktop_secure_storage_write'
            && command !== 'desktop_secure_storage_remove') return undefined;
        const key = args?.key;
        if (typeof key !== 'string') throw new TypeError('Desktop secure storage requires a string key');
        if (command === 'desktop_secure_storage_read') return values.get(key) ?? null;
        if (command === 'desktop_secure_storage_remove') {
            values.delete(key);
            return undefined;
        }
        const value = args?.value;
        if (typeof value !== 'string') throw new TypeError('Desktop secure storage requires a string value');
        values.set(key, value);
        return undefined;
    }
    return { values, invoke };
}
