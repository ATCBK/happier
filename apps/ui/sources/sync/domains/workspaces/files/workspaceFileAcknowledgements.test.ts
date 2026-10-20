import { expect, it } from 'vitest';
import { acknowledgeWorkspaceFileWrites, subscribeAcknowledgedWorkspaceFileWrites } from './workspaceFileAcknowledgements';

it('matches canonical Windows file identity without crossing Account, Machine, or sibling roots', () => {
    const target = { serverId: 'home', accountId: 'account', machineId: 'machine', rootPath: 'C:\\repo' };
    const hashes: Array<string | null> = [];
    const dispose = subscribeAcknowledgedWorkspaceFileWrites(target, 'src\\file.txt', write => { hashes.push(write.hash); });
    try {
        acknowledgeWorkspaceFileWrites({ ...target, rootPath: 'C:/repo' }, [{ path: 'src/file.txt', hash: 'own' }]);
        acknowledgeWorkspaceFileWrites({ ...target, accountId: 'other' }, [{ path: 'src/file.txt', hash: 'other-account' }]);
        acknowledgeWorkspaceFileWrites({ ...target, machineId: 'other' }, [{ path: 'src/file.txt', hash: 'other-machine' }]);
        acknowledgeWorkspaceFileWrites({ ...target, rootPath: 'C:/repo-other' }, [{ path: 'src/file.txt', hash: 'sibling' }]);
        expect(hashes).toEqual(['own']);
    } finally { dispose(); }
    acknowledgeWorkspaceFileWrites(target, [{ path: 'src/file.txt', hash: 'after-unmount' }]);
    expect(hashes).toEqual(['own']);
});

it('does not turn committed bytes into a failed write when one mounted observer throws', () => {
    const target = { serverId: 'home', accountId: 'account', machineId: 'machine', rootPath: '/repo' };
    const disposeBroken = subscribeAcknowledgedWorkspaceFileWrites(target, 'file.txt', () => { throw new Error('retired reader'); });
    const hashes: Array<string | null> = [];
    const dispose = subscribeAcknowledgedWorkspaceFileWrites(target, 'file.txt', write => { hashes.push(write.hash); });
    try {
        expect(() => acknowledgeWorkspaceFileWrites(target, [{ path: 'file.txt', hash: 'committed' }])).not.toThrow();
        expect(hashes).toEqual(['committed']);
    } finally { disposeBroken(); dispose(); }
});
