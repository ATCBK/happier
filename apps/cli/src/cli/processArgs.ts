function isCliEntrypointPath(arg: string): boolean {
    const normalized = String(arg ?? '').trim().replaceAll('\\', '/');
    if (!normalized) return false;
    const relativeNormalized = normalized.replace(/^\.\//, '');
    return (
        normalized.endsWith('/package-dist/index.mjs') ||
        normalized.endsWith('/dist/index.mjs') ||
        normalized.endsWith('/apps/cli/src/index.ts') ||
        relativeNormalized === 'src/index.ts' ||
        relativeNormalized === 'apps/cli/src/index.ts'
    );
}

export function normalizeCliArgv(argv: readonly string[]): string[] {
    if (argv.length === 0) return [];
    return isCliEntrypointPath(argv[0] ?? '') ? [...argv.slice(1)] : [...argv];
}

export function readCliProcessArgs(argv: readonly string[] = process.argv): string[] {
    return normalizeCliArgv(argv.slice(2));
}

export function isTopLevelHelpRequest(args: readonly string[]): boolean {
    return args.length === 1 && (args[0] === '--help' || args[0] === '-h');
}

export function isFamilyHelpRequest(args: readonly string[]): boolean {
    if (args.length < 2 || args[0]?.startsWith('-')) return false;
    const controls = argvBeforeOptionTerminator(args);
    return controls[1] === 'help' || controls.slice(1).some((arg) => arg === '--help' || arg === '-h');
}
/** Everything following `--` is caller-owned positional input. */
export function argvBeforeOptionTerminator(argv: readonly string[]): readonly string[] {
    const terminatorIndex = argv.indexOf('--');
    return terminatorIndex < 0 ? argv : argv.slice(0, terminatorIndex);
}

