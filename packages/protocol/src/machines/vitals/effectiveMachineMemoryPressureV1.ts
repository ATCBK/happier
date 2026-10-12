import type { MachineVitalsSampleV1 } from './machineVitalsSampleV1.js';

/** Effective rule signal, not a fabricated native pressure percentage or UI metric. */
export function effectiveMachineMemoryPressureV1(memory: MachineVitalsSampleV1['memory']): 'calm' | 'elevated' | 'critical' | 'not_reported' {
  if (!memory.reported) return 'not_reported';
  const commitExhausted = memory.pressure.source === 'none' && memory.commitLimitBytes !== undefined
    && memory.commitLimitBytes > 0 && memory.commitUsedBytes !== undefined && memory.commitUsedBytes >= memory.commitLimitBytes;
  if (memory.lowMemorySignal || commitExhausted) return 'critical';
  // Windows exposes a binary low-memory notification, not a richer pressure metric.
  // Its observed negative supplies rule recovery while the raw UI metric stays unreported.
  if (memory.pressure.source === 'none' && memory.lowMemorySignal === false) return 'calm';
  return memory.pressure.level;
}
