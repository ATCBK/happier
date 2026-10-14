import * as fs from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getClaudeProjectPath, resolveClaudeProjectId } from './path.js';

vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof fs>();
    return { ...actual, realpathSync: vi.fn(actual.realpathSync) };
});

// Golden vectors evaluated with Claude Code 2.1.296's installed OO/Mse functions.
const nativeProjectVectors = [
    {
        name: 'the observed long Linux Session cwd',
        cwd: '/home/happier/.happier/dev-targets/nl1/stack-state/agent-qa-machine-resources/cli/servers/stack_agent-qa-machine-resources__id_default/session-directories/c09e0e01ab94b01f42e8705122524cefab1417e6557dad2a2c4c7c3e79951ad9',
        projectId: '-home-happier--happier-dev-targets-nl1-stack-state-agent-qa-machine-resources-cli-servers-stack-agent-qa-machine-resources--id-default-session-directories-c09e0e01ab94b01f42e8705122524cefab1417e6557da-n61aw6',
    },
    {
        name: 'a long Windows cwd',
        cwd: 'C:\\Users\\Alice\\' + 'machine-resources\\session-directory\\'.repeat(7) + 'workspace',
        projectId: 'C--Users-Alice-machine-resources-session-directory-machine-resources-session-directory-machine-resources-session-directory-machine-resources-session-directory-machine-resources-session-directory-machi-vuldd7',
    },
    {
        name: 'a long macOS cwd with underscores',
        cwd: '/Users/alice/' + 'machine_resources/session_directory/'.repeat(7) + 'workspace',
        projectId: '-Users-alice-machine-resources-session-directory-machine-resources-session-directory-machine-resources-session-directory-machine-resources-session-directory-machine-resources-session-directory-machine-g2wigb',
    },
    { name: 'exactly 200 characters', cwd: '/repo/' + 'a'.repeat(194), projectId: '-repo-' + 'a'.repeat(194) },
    { name: '201 characters', cwd: '/repo/' + 'a'.repeat(195), projectId: '-repo-' + 'a'.repeat(194) + '-c4eqp9' },
    { name: 'a hash of the original unsanitized cwd', cwd: '/repo/' + 'a'.repeat(194) + 'é', projectId: '-repo-' + 'a'.repeat(194) + '-c4eqlh' },
    { name: 'UTF-16 surrogate pairs and a negative signed hash', cwd: '/repo/' + 'a'.repeat(194) + '😀', projectId: '-repo-' + 'a'.repeat(194) + '-km2s7j' },
] as const;

describe('Claude native project path', () => {
    afterEach(() => vi.mocked(fs.realpathSync).mockReset());

    it.each(nativeProjectVectors)('resolves $name to the native project directory', ({ cwd, projectId }) => {
        // The OS boundary returns the physical cwd spelling on each platform.
        vi.mocked(fs.realpathSync).mockReturnValue(cwd);
        expect(resolveClaudeProjectId(cwd)).toBe(projectId);
        expect(getClaudeProjectPath(cwd, '/native-config')).toBe(join('/native-config', 'projects', projectId));
    });
});
