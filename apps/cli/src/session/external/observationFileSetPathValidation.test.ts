import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentExternalSessionsResolvedIdentity } from '@happier-dev/plugin-sdk/sessions/external';
import { describe, expect, it } from 'vitest';

import { validateExternalSessionObservationWatchFileChanges } from './observationFileSetPathValidation';

function linkedSource(root: string): AgentExternalSessionsResolvedIdentity {
    return {
        source: { kind: 'fixture', root },
        remoteSessionId: 'native-session',
        linkData: {},
    };
}

describe('external-session observation path validation', () => {
    it('retains a removed authorized file but refuses its replacement by a dangling link outside the source', async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'external-observation-file-removed-')));
        try {
            const source = join(root, 'source');
            const outside = join(root, 'outside');
            const file = join(source, 'native.jsonl');
            await mkdir(source);
            await mkdir(outside);
            await writeFile(file, '{}\n');
            const admitted = validateExternalSessionObservationWatchFileChanges({
                requested: { files: [file] }, linkedSource: linkedSource(source),
                filesystemReadAllowedPaths: new Set(['']),
            });
            expect(admitted?.files).toEqual([file]);
            await unlink(file);
            const validate = () => validateExternalSessionObservationWatchFileChanges({
                requested: { files: [file] }, linkedSource: linkedSource(source),
                filesystemReadAllowedPaths: new Set(['']),
                previouslyAuthorizedFiles: new Set(admitted!.files),
            });
            expect(validate()?.files).toEqual([file]);
            await symlink(join(outside, 'absent.jsonl'), file, 'file');
            expect(validate()).toBeNull();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('admits canonical topology directories inside the resolved source grant', async () => {
        const root = await mkdtemp(join(tmpdir(), 'external-observation-topology-'));
        const sessions = join(root, 'sessions');
        const archivedSessions = join(root, 'archived_sessions');
        const file = join(sessions, '2026', '07', '25', 'rollout.jsonl');
        await mkdir(join(sessions, '2026', '07', '25'), { recursive: true });
        await mkdir(archivedSessions, { recursive: true });
        await writeFile(file, '{}\n', 'utf8');

        expect(validateExternalSessionObservationWatchFileChanges({
            requested: {
                files: [await realpath(file)],
                topologyDirectories: [
                    await realpath(sessions),
                    await realpath(archivedSessions),
                ],
            },
            linkedSource: linkedSource(root),
            filesystemReadAllowedPaths: new Set(['']),
        })).toEqual({
            files: [await realpath(file)],
            topologyDirectories: [
                await realpath(sessions),
                await realpath(archivedSessions),
            ],
        });
    });

    it('admits an authorized missing topology directory so its creation can be observed', async () => {
        const root = await mkdtemp(join(tmpdir(), 'external-observation-topology-missing-'));
        const sessions = join(root, 'sessions');
        const archivedSessions = join(root, 'archived_sessions');
        const file = join(sessions, 'rollout.jsonl');
        await mkdir(sessions, { recursive: true });
        await writeFile(file, '{}\n', 'utf8');

        expect(validateExternalSessionObservationWatchFileChanges({
            requested: {
                files: [await realpath(file)],
                topologyDirectories: [
                    await realpath(sessions),
                    archivedSessions,
                ],
            },
            linkedSource: linkedSource(root),
            filesystemReadAllowedPaths: new Set(['']),
        })).toEqual({
            files: [await realpath(file)],
            topologyDirectories: [
                await realpath(sessions),
                join(await realpath(root), 'archived_sessions'),
            ],
        });
    });

    it('rejects topology directories that escape the source lexically or through a symlink', async () => {
        const root = await mkdtemp(join(tmpdir(), 'external-observation-topology-escape-'));
        const sourceRoot = join(root, 'source');
        const outsideRoot = join(root, 'outside');
        const sessions = join(sourceRoot, 'sessions');
        const file = join(sessions, 'rollout.jsonl');
        await mkdir(sessions, { recursive: true });
        await mkdir(outsideRoot, { recursive: true });
        await writeFile(file, '{}\n', 'utf8');
        const escapedLink = join(sourceRoot, 'escaped');
        await symlink(outsideRoot, escapedLink, 'dir');
        const danglingLink = join(sourceRoot, 'dangling');
        await symlink(join(outsideRoot, 'absent'), danglingLink, 'dir');

        for (const topologyDirectory of [outsideRoot, escapedLink, join(escapedLink, 'not-yet-created'), join(danglingLink, 'not-yet-created')]) {
            expect.soft(validateExternalSessionObservationWatchFileChanges({
                requested: {
                    files: [await realpath(file)],
                    topologyDirectories: [topologyDirectory],
                },
                linkedSource: linkedSource(sourceRoot),
                filesystemReadAllowedPaths: new Set(['']),
            })).toBeNull();
        }
    });

    it('does not turn a topology directory into file read authority', async () => {
        const root = await mkdtemp(join(tmpdir(), 'external-observation-topology-authority-'));
        const sessions = join(root, 'sessions');
        const declaredFile = join(sessions, 'declared.jsonl');
        const undeclaredFile = join(sessions, 'undeclared.jsonl');
        await mkdir(sessions, { recursive: true });
        await writeFile(declaredFile, '{}\n', 'utf8');
        await writeFile(undeclaredFile, '{}\n', 'utf8');

        const admitted = validateExternalSessionObservationWatchFileChanges({
            requested: {
                files: [await realpath(declaredFile)],
                topologyDirectories: [await realpath(sessions)],
            },
            linkedSource: linkedSource(root),
            filesystemReadAllowedPaths: new Set(['']),
        });

        expect(admitted?.files).toEqual([await realpath(declaredFile)]);
        expect(admitted?.files).not.toContain(await realpath(undeclaredFile));
    });
});
