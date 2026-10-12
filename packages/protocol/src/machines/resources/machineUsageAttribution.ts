import type { MachineProcessesAnswerV1 } from '../processes/machineProcessesV1.js';

export type MachineAttributedUsage = Readonly<{
  memoryBytes: number | null;
  cpuPercent: number | null;
}>;

/** What the machine's own vitals report as in use; `null` fields when that reading was not reported. */
export type MachineUsageFacts = Readonly<{
  usedMemoryBytes: number | null;
  cpuBusyPercent: number | null;
}>;

/**
 * The one split of a machine's use into Happier and everything else, shared by the Overview's "Using the most"
 * and the Processes tab's closing rows. The producer's `totals.happier` counts owned rows only; left-behind
 * processes are listed on their own, so they belong to neither remainder. Process CPU is already a share of
 * the whole machine and is never divided again. Unknown stays `null`; remainders clamp at zero.
 */
export function attributeMachineUsage(
  totals: MachineProcessesAnswerV1['totals'],
  machine: MachineUsageFacts | null,
): Readonly<{
  happier: MachineAttributedUsage;
  everythingElse: MachineAttributedUsage;
}> {
  const happier = {
    memoryBytes: totals.happier.memoryBytes,
    cpuPercent: totals.happier.cpuPercent ?? null,
  };
  const used = machine?.usedMemoryBytes ?? null;
  const busy = machine?.cpuBusyPercent ?? null;
  return {
    happier,
    everythingElse: {
      memoryBytes:
        used === null || happier.memoryBytes === null
          ? null
          : Math.max(
              0,
              used - happier.memoryBytes - (totals.leftBehind.memoryBytes ?? 0),
            ),
      cpuPercent:
        busy === null || happier.cpuPercent === null
          ? null
          : Math.max(
              0,
              busy - happier.cpuPercent - (totals.leftBehind.cpuPercent ?? 0),
            ),
    },
  };
}
