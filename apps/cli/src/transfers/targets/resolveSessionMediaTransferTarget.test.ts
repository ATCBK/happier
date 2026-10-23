import { describe, expect, it } from 'vitest';

import {
  resolveConfiguredSessionMediaTransferTarget,
  normalizeSessionMediaWorkspaceRelativeDir,
  resolveSessionMediaTransferTarget,
} from './resolveSessionMediaTransferTarget';

describe('resolveSessionMediaTransferTarget', () => {
  it('uses the canonical attachment path boundary for mixed separators and invalid paths', () => {
    expect(normalizeSessionMediaWorkspaceRelativeDir('media\\nested/files')).toBe('media/nested/files');
    for (const value of ['media\0files', 'C:\\media', '\\\\host\\share', 'media/../files']) {
      expect(normalizeSessionMediaWorkspaceRelativeDir(value)).toBeNull();
    }
  });
  it('maps persisted media categories to workspace upload roots', () => {
    const config = {
      uploadLocation: 'workspace',
      workspaceRelativeDir: '.happier/uploads',
      vcsIgnoreStrategy: 'git_info_exclude',
      vcsIgnoreWritesEnabled: true,
    } as const;

    expect(resolveSessionMediaTransferTarget({ config, tempUploadRoot: '/tmp/uploads', category: 'generated' })).toEqual({
      uploadBasePath: '.happier/uploads/generated',
      additionalAllowedReadDirs: [],
      additionalAllowedWriteDirs: [],
    });
    expect(resolveSessionMediaTransferTarget({ config, tempUploadRoot: '/tmp/uploads', category: 'artifacts' })).toEqual({
      uploadBasePath: '.happier/uploads/artifacts',
      additionalAllowedReadDirs: [],
      additionalAllowedWriteDirs: [],
    });
    expect(resolveSessionMediaTransferTarget({ config, tempUploadRoot: '/tmp/uploads', category: 'messages' })).toEqual({
      uploadBasePath: '.happier/uploads/messages',
      additionalAllowedReadDirs: [],
      additionalAllowedWriteDirs: [],
    });
  });

  it('rejects durable generated media outside workspace storage', () => {
    const result = resolveConfiguredSessionMediaTransferTarget({
      config: {
        uploadLocation: 'os_temp',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'none',
        vcsIgnoreWritesEnabled: false,
      },
      tempUploadRoot: '/tmp/happier/uploads/session-1',
      workingDirectory: '/repo',
      category: 'generated',
    });

    expect(result).toMatchObject({
      success: false,
      error: 'Session media category generated must use workspace storage',
    });
  });
});
