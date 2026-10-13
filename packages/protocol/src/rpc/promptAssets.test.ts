import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from './index.js';

describe('RPC_METHODS prompt assets surface', () => {
  it('defines prompt asset method constants', () => {
    expect(RPC_METHODS.DAEMON_PROMPT_ASSETS_LIST_TYPES).toBe('daemon.promptAssets.listTypes');
    expect(RPC_METHODS.SKILLS_FOUND_LIST).toBe('skills.found.list');
    expect('DAEMON_PROMPT_ASSETS_DISCOVER' in RPC_METHODS).toBe(false);
    expect(RPC_METHODS.SKILLS_MACHINE_INSTALL).toBe('skills.machine.install');
    expect(RPC_METHODS.SKILLS_MACHINE_UNINSTALL).toBe('skills.machine.uninstall');
    expect('DAEMON_PROMPT_ASSETS_READ' in RPC_METHODS).toBe(false);
    expect(RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_INIT).toBe('daemon.promptAssets.upload.init');
    expect(RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_CHUNK).toBe('daemon.promptAssets.upload.chunk');
    expect(RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_FINALIZE).toBe('daemon.promptAssets.upload.finalize');
    expect(RPC_METHODS.DAEMON_PROMPT_ASSETS_UPLOAD_ABORT).toBe('daemon.promptAssets.upload.abort');
    expect('DAEMON_PROMPT_ASSETS_WRITE' in RPC_METHODS).toBe(false);
    expect(RPC_METHODS.DAEMON_PROMPT_ASSETS_DELETE).toBe('daemon.promptAssets.delete');
  });
});
