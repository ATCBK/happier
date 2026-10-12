import { stat } from 'node:fs/promises';

/** Source compilation owns its last-green files, independently of installation. */
export async function buildUiSourceAsset({ outputs, retainLastGreen = false, build }) {
    try {
        return await build();
    } catch (error) {
        // OS and publication failures are not source drift.
        if (!retainLastGreen || !Array.isArray(error?.errors) || error.errors.length === 0
            || /EACCES|EPERM|ENOSPC|permission denied/i.test(error.message)) throw error;
        const files = await Promise.all(outputs.map(file => stat(file).catch(failure => {
            if (failure.code === 'ENOENT') return null;
            throw failure;
        })));
        if (!files.every(file => file?.isFile() && file.size > 0)) throw error;
        console.warn(`[ui] source asset refresh failed; retained last-green ${outputs.join(', ')}. ${error.message}`);
        return { retained: true };
    }
}
