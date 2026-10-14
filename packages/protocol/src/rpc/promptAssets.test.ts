import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from './index.js';

describe('Found transfer RPC surface', () => {
  it('keeps scanner-backed Found methods and its retained download transport', () => {
    expect(RPC_METHODS.SKILLS_FOUND_LIST).toBe('skills.found.list');
    expect(RPC_METHODS.SKILLS_MACHINE_INSTALL).toBe('skills.machine.install');
    expect(RPC_METHODS.SKILLS_MACHINE_UNINSTALL).toBe('skills.machine.uninstall');
    for (const phase of ['INIT', 'CHUNK', 'FINALIZE', 'ABORT'] as const) {
      expect(RPC_METHODS[`DAEMON_PROMPT_ASSETS_DOWNLOAD_${phase}`]).toBe(`daemon.promptAssets.download.${phase.toLowerCase()}`);
    }
    for (const key of ['DAEMON_PROMPT_ASSETS_DISCOVER', 'DAEMON_PROMPT_ASSETS_LIST_TYPES', 'DAEMON_PROMPT_ASSETS_DELETE',
      'DAEMON_PROMPT_ASSETS_UPLOAD_INIT', 'DAEMON_PROMPT_ASSETS_UPLOAD_CHUNK', 'DAEMON_PROMPT_ASSETS_UPLOAD_FINALIZE',
      'DAEMON_PROMPT_ASSETS_UPLOAD_ABORT']) expect(key in RPC_METHODS).toBe(false);
  });
});
