import { resolveAbsolutePath } from '@/utils/path/pathUtils';

export function formatPathRelativeToHome(path: string, homeDir?: string | null): string {
    if (!homeDir) return path;

    const normalizedHome = homeDir.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    const normalizedPath = resolveAbsolutePath(path, normalizedHome).replace(/[\\/]+/g, '/');

    if (normalizedPath === normalizedHome || normalizedPath.replace(/[\\/]+$/, '') === normalizedHome) {
        return '~';
    }

    if (!normalizedPath.startsWith(normalizedHome)) {
        return path;
    }

    const remainder = normalizedPath.slice(normalizedHome.length);
    if (!/^[\\/]+/.test(remainder)) {
        return path;
    }

    return `~/${remainder.replace(/^[\\/]+/, '').replace(/[\\/]+/g, '/')}`;
}

/**
 * Session workspace labels share one home-directory rule, including the composer chip. A path Session
 * at the machine home is `~`; "No folder" belongs only to managed Sessions, which never reach this.
 */
export function formatSessionPath(path: string, homeDir?: string): string {
    // Literal home aliases remain meaningful before the machine's home metadata hydrates.
    return formatPathRelativeToHome(path, homeDir || '~');
}
