import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  buildListWindowsScheduledTaskFolderPowerShellCommand,
  buildRemoveWindowsScheduledTaskIfPresentPowerShellCommand,
  buildReadWindowsScheduledTaskStatusPowerShellCommand,
  buildStopWindowsScheduledTaskIfRunningPowerShellCommand,
  parseWindowsScheduledTaskFolderPowerShellJson,
  parseWindowsScheduledTaskStatusPowerShellJson,
} from './windows';

describe('Windows scheduled task folder listing PowerShell helper', () => {
  it('lists only the requested task folder instead of enumerating every scheduled task', () => {
    const command = buildListWindowsScheduledTaskFolderPowerShellCommand({ taskFolder: '\\Happier\\' });

    expect(command).toContain('Schedule.Service');
    expect(command).toContain('.GetFolder("\\Happier")');
    expect(command).toContain('ConvertTo-Json');
    expect(command).not.toContain('schtasks');
  });

  it('parses task paths from invariant JSON and rejects anything else', () => {
    expect(parseWindowsScheduledTaskFolderPowerShellJson('["\\\\Happier\\\\happier-daemon.default"]'))
      .toEqual(['\\Happier\\happier-daemon.default']);
    expect(parseWindowsScheduledTaskFolderPowerShellJson('[]')).toEqual([]);
    expect(parseWindowsScheduledTaskFolderPowerShellJson('')).toBeNull();
    expect(parseWindowsScheduledTaskFolderPowerShellJson('ERROR: The system cannot find the file specified.')).toBeNull();
    expect(parseWindowsScheduledTaskFolderPowerShellJson('[1]')).toBeNull();
  });

  it.runIf(process.platform === 'win32')('reports a missing task folder as empty without parsing localized errors', () => {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      buildListWindowsScheduledTaskFolderPowerShellCommand({ taskFolder: `\\HappierMissingFolderTest${process.pid}\\` }),
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });

    expect(result.status).toBe(0);
    expect(parseWindowsScheduledTaskFolderPowerShellJson(result.stdout)).toEqual([]);
  });
});

describe('Windows scheduled task PowerShell status helper', () => {
  it('parses launch post-mortem fields from invariant JSON', () => {
    const parsed = parseWindowsScheduledTaskStatusPowerShellJson(JSON.stringify({
      exists: true,
      enabled: true,
      active: false,
      stateLabel: 'Ready',
      stateValue: 3,
      lastRunTime: '2026-04-29T16:29:54.0000000+02:00',
      lastTaskResult: 267009,
      taskToRun: 'powershell.exe -NoProfile -File C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1',
    }));

    expect(parsed).toEqual({
      exists: true,
      enabled: true,
      active: false,
      stateLabel: 'Ready',
      stateValue: 3,
      lastRunTime: '2026-04-29T16:29:54.0000000+02:00',
      lastTaskResult: 267009,
      taskToRun: 'powershell.exe -NoProfile -File C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1',
    });
  });

  it('queries launch post-mortem fields using culture-independent property names', () => {
    const command = buildReadWindowsScheduledTaskStatusPowerShellCommand({
      taskPath: '\\Happier\\',
      taskName: 'happier-daemon.default',
    });

    expect(command).toContain('Get-ScheduledTaskInfo');
    expect(command).toContain('LastTaskResult');
    expect(command).toContain('LastRunTime');
    expect(command).toContain('Actions');
    expect(command).toContain('ConvertTo-Json -Compress');
  });
});

describe('Windows scheduled task lifecycle PowerShell helpers', () => {
  it('stops only an existing running task through typed scheduler state', () => {
    const command = buildStopWindowsScheduledTaskIfRunningPowerShellCommand({
      qualifiedTaskName: 'Happier\\happier-daemon.default',
      definitionPath: 'C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1',
    });

    expect(command).toContain('Get-ScheduledTask');
    expect(command).toContain('[int]$task.State -eq 4');
    expect(command).toContain('Get-CimInstance Win32_Process');
    expect(command).toContain('-File `"C:\\Users\\test\\.happier\\services\\happier-daemon.default.ps1`"');
    expect(command).toContain('taskkill.exe /PID $serviceProcessId /T /F');
    expect(command.indexOf('taskkill.exe')).toBeLessThan(command.indexOf('Stop-ScheduledTask'));
    expect(command).toContain('Stop-ScheduledTask');
    expect(command).toContain('-ErrorAction Stop');
    expect(command.trim()).toMatch(/exit 0$/);
    expect(command).not.toContain('schtasks');
  });

  it('removes only an existing task without parsing localized command output', () => {
    const command = buildRemoveWindowsScheduledTaskIfPresentPowerShellCommand({
      qualifiedTaskName: 'Happier\\happier-daemon.default',
    });

    expect(command).toContain('Get-ScheduledTask');
    expect(command).toContain('Unregister-ScheduledTask');
    expect(command).toContain('-Confirm:$false');
    expect(command).toContain('-ErrorAction Stop');
    expect(command.trim()).toMatch(/exit 0$/);
    expect(command).not.toContain('schtasks');
  });
});
