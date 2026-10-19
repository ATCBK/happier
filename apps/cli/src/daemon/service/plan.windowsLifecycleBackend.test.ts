import { describe, expect, it } from 'vitest';

import { planDaemonServiceLifecycle } from './plan';

describe('daemon service lifecycle planning for Windows system services', () => {
  it('restarts the selected system scheduled task', () => {
    const plan = planDaemonServiceLifecycle({
      platform: 'win32',
      mode: 'system',
      action: 'restart',
      channel: 'stable',
      instanceId: 'company',
      userHomeDir: 'C:\\Users\\test',
      happierHomeDir: 'C:\\ProgramData\\happier',
    });

    expect(plan.commands).toEqual([
      { cmd: 'schtasks', args: ['/End', '/TN', 'Happier\\happier-daemon.company'] },
      { cmd: 'schtasks', args: ['/Run', '/TN', 'Happier\\happier-daemon.company'] },
    ]);
  });
});
