import { logger } from '@/ui/logger';

/** Process CPU includes other work in this runner; it is not phase-exclusive CPU. */
export async function traceSkillPreparationPhase<T>(
  phase: string,
  work: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const startedCpu = process.cpuUsage();
  logger.infoFile('[skills] Preparation phase', { phase, status: 'started' });
  let status: 'completed' | 'failed' = 'failed';
  try {
    const result = await work();
    status = 'completed';
    return result;
  } finally {
    const cpu = process.cpuUsage(startedCpu);
    logger.infoFile('[skills] Preparation phase', {
      phase, status, durationMs: Math.round(performance.now() - startedAt),
      processUserCpuMs: Math.round(cpu.user / 1000),
      processSystemCpuMs: Math.round(cpu.system / 1000),
    });
  }
}
