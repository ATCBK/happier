import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';

import { windowsSystemToolCommand } from './windows/windowsSystemToolPath.js';

export type BatteryFacts = Readonly<{ present: boolean; onAC?: boolean; battery?: MachineVitalsSampleV1['battery'] }>;
type PowerSupplySystem = Readonly<{
  readText(path: string): Promise<string>;
  listPowerSupplies(): Promise<readonly string[]>;
}>;
type ToolSystem = Readonly<{ runTool(command: string, args: readonly string[]): Promise<string> }>;

/** Presence remains useful when a host reports no percentage or time estimate. */
export function parseDarwinBatteryFacts(raw: string): BatteryFacts {
  const onAC = /drawing from 'AC Power'|AC attached/u.test(raw) ? true : /drawing from 'Battery Power'/u.test(raw) ? false : undefined;
  const power = onAC === undefined ? {} : { onAC };
  const battery = raw.split(/\r?\n/u).find((line) => /InternalBattery/u.test(line));
  const pct = Number(battery?.match(/(\d+)%;/u)?.[1]);
  if (!battery) return { present: false, ...power };
  if (!Number.isFinite(pct) || pct > 100 || onAC === undefined) return { present: true, ...power };
  const charging = /;\s*charging(?:;|\s)/u.test(battery);
  const remaining = battery.match(/(\d+):(\d+) remaining/u);
  const minutes = remaining ? Number(remaining[1]) * 60 + Number(remaining[2]) : undefined;
  return { present: true, ...power, battery: { pct, onAC, state: charging ? 'charging' : onAC ? 'full' : 'discharging',
    ...(minutes !== undefined ? charging ? { minutesToFull: minutes } : { minutesToEmpty: minutes } : {}) } };
}

export async function readLinuxBatteryFacts(system: PowerSupplySystem, options: Readonly<{ powerOnly?: boolean }> = {}): Promise<BatteryFacts> {
  const read = async (path: string) => { try { return (await system.readText(path)).trim(); } catch { return null; } };
  let supplies: readonly string[];
  try { supplies = await system.listPowerSupplies(); } catch { return { present: false }; }
  let batteryRoot: string | undefined;
  const acOnline: boolean[] = [];
  for (const name of supplies) {
    const root = `/sys/class/power_supply/${name}`;
    const type = await read(`${root}/type`);
    if (type === 'Battery' && await read(`${root}/scope`) !== 'Device') batteryRoot ??= root;
    else if (type === 'Mains' || type === 'USB' || type === 'USB_C') {
      const online = await read(`${root}/online`);
      if (online === '0' || online === '1') acOnline.push(online === '1');
    }
  }
  if (options.powerOnly) {
    const status = batteryRoot ? await read(`${batteryRoot}/status`) : null;
    const onAC = acOnline.length ? acOnline.some(Boolean) : status === 'Charging' ? true : status === 'Discharging' ? false : undefined;
    return { present: Boolean(batteryRoot), ...(onAC !== undefined ? { onAC } : {}) };
  }
  if (!batteryRoot) return { present: false };
  const [capacity, status] = await Promise.all([read(`${batteryRoot}/capacity`), read(`${batteryRoot}/status`)]);
  if (capacity === null || !/^\d+(?:\.\d+)?$/u.test(capacity) || Number(capacity) > 100) return { present: true };
  const state = status === 'Charging' ? 'charging' : status === 'Discharging' ? 'discharging' : status === 'Full' ? 'full' : null;
  const onAC = acOnline.length ? acOnline.some(Boolean) : state === 'charging' ? true : state === 'discharging' ? false : null;
  if (!state || onAC === null) return { present: true };
  return { present: true, battery: { pct: Number(capacity), state, onAC } };
}

export async function readWindowsBatteryPresence(system: ToolSystem): Promise<boolean> {
  try {
    const count = (await system.runTool(windowsSystemToolCommand('powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-Command',
      "@(Get-CimInstance Win32_Battery | Where-Object { $_.Name -notmatch 'UPS|Uninterruptible' -and $_.DeviceID -notmatch 'UPS|Uninterruptible' }).Count",
    ])).trim();
    return /^\d+$/u.test(count) && Number(count) > 0;
  } catch { return false; }
}
