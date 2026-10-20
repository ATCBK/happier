function normalizeNonEmptyString(value: unknown, preserveWhitespace: boolean): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = preserveWhitespace ? value : value.trim();
    return normalized.length > 0 ? normalized : null;
}

export function normalizeFileSystemPath(value: unknown, options?: Readonly<{ preserveWhitespace?: boolean }>): string | null {
    const normalized = normalizeNonEmptyString(value, options?.preserveWhitespace === true);
    if (!normalized) {
        return null;
    }

    const normalizedSeparators = normalized.replace(/\\/g, '/');
    const normalizedDevicePath = normalizedSeparators.toLowerCase().startsWith('//?/unc/')
        ? `//${normalizedSeparators.slice('//?/UNC/'.length)}`
        : normalizedSeparators.toLowerCase().startsWith('//?/')
            ? normalizedSeparators.slice('//?/'.length)
            : normalizedSeparators;
    const normalizedWindowsPath = /^[A-Za-z]:\//.test(normalizedDevicePath) || normalizedDevicePath.startsWith('//')
        ? normalizedDevicePath.toLowerCase()
        : normalizedDevicePath.replace(/^([A-Z]):/, (_match, driveLetter: string) => `${driveLetter.toLowerCase()}:`);
    const trimmedTrailingSeparators = normalizedWindowsPath.replace(/[\/]+$/, '');
    return trimmedTrailingSeparators.length > 0 ? trimmedTrailingSeparators : normalizedWindowsPath;
}

function normalizeDarwinPathAlias(path: string): string {
    const darwinAliases: Record<string, string> = {
        '/private/etc': '/etc',
        '/private/tmp': '/tmp',
        '/private/var': '/var',
    };
    for (const [aliasedRoot, publicRoot] of Object.entries(darwinAliases)) {
        if (path === aliasedRoot) {
            return publicRoot;
        }
        if (path.startsWith(`${aliasedRoot}/`)) {
            return `${publicRoot}${path.slice(aliasedRoot.length)}`;
        }
    }
    return path;
}

export function normalizeMachineFileSystemPath(
    value: unknown,
    options?: Readonly<{ platform?: string | null }>,
): string | null {
    const normalized = normalizeFileSystemPath(value);
    if (normalized === null) {
        return null;
    }
    return options?.platform === 'darwin'
        ? normalizeDarwinPathAlias(normalized)
        : normalized;
}
