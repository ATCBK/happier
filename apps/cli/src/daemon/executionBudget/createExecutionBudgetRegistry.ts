import { configuration } from '@/configuration';
import { ExecutionBudgetRegistry } from './ExecutionBudgetRegistry';

/** One custody/configuration owner for Session and detached daemon execution budgets, including uncapped work. */
export function createExecutionBudgetRegistry(
    maxConcurrentExecutionRuns: number | null = configuration.executionRunsMaxConcurrentPerSession,
): ExecutionBudgetRegistry {
    return new ExecutionBudgetRegistry({
        maxConcurrentExecutionRuns,
        maxConcurrentOneShotTasks: configuration.oneShotTasksMaxConcurrentPerSession,
        ...(typeof configuration.executionBudgetMaxConcurrentTotalPerSession === 'number'
            ? { maxConcurrentTotal: configuration.executionBudgetMaxConcurrentTotalPerSession }
            : {}),
        ...(configuration.executionBudgetMaxConcurrentByClass
            && Object.keys(configuration.executionBudgetMaxConcurrentByClass).length > 0
            ? { maxConcurrentByClass: configuration.executionBudgetMaxConcurrentByClass }
            : {}),
    });
}
