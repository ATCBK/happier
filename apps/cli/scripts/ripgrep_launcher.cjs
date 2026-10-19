#!/usr/bin/env node

/**
 * Ripgrep runner - executed as a subprocess to run the packaged binary
 * This file is intentionally written in CommonJS to avoid ESM complexities
 *
 * Fallback chain:
 * - Use the packaged target-specific rg executable
 * - Fall back to system ripgrep when the packaged executable is unavailable
 * - Report unavailable when neither executable exists
 */

const path = require('path');
const fs = require('fs');
const { normalizeChildProcessExitCode, withWindowsHide } = require('./childProcessOptions.cjs');
const { resolvePackagedRipgrepBinaryPath } = require('./ripgrep_runtime_paths.cjs');

// Find ripgrep in system PATH (cross-platform)
function findSystemRipgrep() {
    const { execFileSync } = require('child_process');

    const commands = [
        process.platform === 'win32' && { cmd: 'where', args: ['rg'] },
        process.platform !== 'win32' && { cmd: 'which', args: ['rg'] }
    ].filter(Boolean);

    for (const { cmd, args } of commands) {
        try {
            const result = execFileSync(cmd, args, withWindowsHide({
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }));

            if (result) {
                const paths = result.trim().split('\n').filter(Boolean);
                if (paths.length > 0) {
                    return paths[0].trim();
                }
            }
        } catch {
            continue;
        }
    }

    const commonPaths = [];
    if (process.platform === 'win32') {
        commonPaths.push(
            'C:\\Program Files\\ripgrep\\rg.exe',
            'C:\\Program Files (x86)\\ripgrep\\rg.exe'
        );
    } else if (process.platform === 'darwin') {
        commonPaths.push(
            '/opt/homebrew/bin/rg',
            '/usr/local/bin/rg'
        );
    } else if (process.platform === 'linux') {
        commonPaths.push(
            '/usr/bin/rg',
            '/usr/local/bin/rg',
            '/opt/homebrew/bin/rg'
        );
    }

    for (const testPath of commonPaths) {
        if (fs.existsSync(testPath)) {
            return testPath;
        }
    }

    return null;
}

function createRipgrepWrapper(binaryPath) {
    return {
        ripgrepMain: (args, paths) => {
            const { spawnSync } = require('child_process');
            // rg's pattern-file input accepts the same newline-separated regexes
            // as -e. Carry them on stdin, avoiding Windows escaping amplification.
            const patterns = [];
            const nativeArgs = [];
            let operands = false;
            for (let i = 0; i < args.length; i++) {
                const arg = args[i];
                if (arg === '--') operands = true;
                if (!operands && (arg === '-e' || arg === '--regexp') && i + 1 < args.length) {
                    patterns.push(args[++i]);
                } else if (!operands && arg.startsWith('--regexp=')) {
                    patterns.push(arg.slice('--regexp='.length));
                } else {
                    nativeArgs.push(arg);
                }
            }
            if (patterns.length) nativeArgs.unshift('--file', '-');
            if (paths && !operands) nativeArgs.push('--');
            // CreateProcessW allows 32,767 UTF-16 units including the NUL.
            // Use that real portable process boundary for batching on all hosts;
            // it limits each launch, never the number of searchable files.
            const quotedLength = arg => arg && !/[ \t"]/.test(arg) ? arg.length
                : 2 + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1').length;
            const baseLength = quotedLength(binaryPath) + nativeArgs.reduce((size, arg) => size + 1 + quotedLength(arg), 0) + 1;
            let index = 0;
            let matched = false;
            do {
                const batch = [];
                let commandLength = baseLength;
                while (paths && index < paths.length) {
                    const length = 1 + quotedLength(paths[index]);
                    if (commandLength + length > 32767) {
                        if (!batch.length) throw new Error('Ripgrep operand exceeds the platform command-line boundary');
                        break;
                    }
                    batch.push(paths[index++]);
                    commandLength += length;
                }
                const result = spawnSync(binaryPath, [...nativeArgs, ...batch], withWindowsHide({
                    stdio: [patterns.length ? 'pipe' : 'inherit', 'inherit', 'inherit'],
                    ...(patterns.length ? { input: patterns.join('\n') + '\n' } : {}),
                    cwd: process.cwd()
                }));
                if (result.error) throw result.error;
                const code = normalizeChildProcessExitCode(result.status);
                if (code === 0) matched = true;
                // Signal termination is a failed search, not a successful miss.
                // The tree owner terminates descendants before this launcher.
                // Never replace a cancelled child with another native batch
                // that could escape the already captured process tree.
                if (result.signal) return 2;
                if (code > 1) return code;
            } while (paths && index < paths.length);
            return matched ? 0 : 1;
        }
    };
}

function createUnavailableRipgrep() {
    return {
        ripgrepMain: () => {
            console.error('Search functionality unavailable without ripgrep');
            console.error('See installation instructions above');
            return 127;
        }
    };
}

function resolvePackagedRipgrepPath(toolsDir, platform = process.platform) {
    const binaryPath = resolvePackagedRipgrepBinaryPath(toolsDir, platform);
    return fs.existsSync(binaryPath) ? binaryPath : null;
}

function loadRipgrep() {
    const toolsDir = path.join(__dirname, '..', 'tools', 'unpacked');
    const packagedRipgrep = resolvePackagedRipgrepPath(toolsDir);
    if (packagedRipgrep) {
        return createRipgrepWrapper(packagedRipgrep);
    }

    // Development and npm layouts can legitimately lack an unpacked tool.
    const systemRipgrep = findSystemRipgrep();
    if (systemRipgrep) {
        console.error(`Using system ripgrep: ${systemRipgrep}`);
        return createRipgrepWrapper(systemRipgrep);
    }

    console.warn('\n⚠️  ripgrep not available - search functionality limited');
    console.warn('Install ripgrep for full functionality:');

    if (process.platform === 'win32') {
        console.warn('  • Windows: winget install BurntSushi.ripgrep');
        console.warn('  • Or download from: https://github.com/BurntSushi/ripgrep/releases');
    } else {
        console.warn('  • macOS/Linux: brew install ripgrep');
        console.warn('  • npm: npm install -g @silentsilas/ripgrep-bin');
    }
    console.warn('');

    return createUnavailableRipgrep();
}

function main(argv = process.argv.slice(2)) {
    let parsedArgs;
    let paths;
    try {
        if (!argv[0]) {
            console.error('Missing arguments: expected JSON-encoded argv as the first parameter.');
            console.error('Example: node scripts/ripgrep_launcher.cjs \'["--version"]\'');
            return 1;
        }
        const payload = JSON.parse(argv[0] === '--stdin' ? fs.readFileSync(0, 'utf8') : argv[0]);
        parsedArgs = Array.isArray(payload) ? payload : payload.args;
        paths = Array.isArray(payload) ? undefined : payload.paths;
        if (!Array.isArray(parsedArgs) || !parsedArgs.every((arg) => typeof arg === 'string')) {
            throw new TypeError('expected an array of strings');
        }
        if (paths !== undefined && (!Array.isArray(paths) || !paths.every(value => typeof value === 'string'))) {
            throw new TypeError('expected source paths as an array of strings');
        }
    } catch (error) {
        console.error('Failed to parse arguments:', error.message);
        return 1;
    }

    try {
        if (paths && paths.length === 0) return 1;
        return loadRipgrep().ripgrepMain(parsedArgs, paths);
    } catch (error) {
        console.error('Ripgrep error:', error.message);
        return 2;
    }
}

module.exports = { main, resolvePackagedRipgrepPath };

if (require.main === module) {
    const exitCode = main();
    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
        console.error(`Ripgrep error: invalid exit code ${exitCode}`);
        process.exit(1);
    }
    process.exit(exitCode);
}
