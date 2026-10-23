import { applyExpoExportMaxWorkersArgs } from '../utils/expo/exportWorkers.mjs';

// Only non-secret export diagnostics and the explicit worker override cross
// the remote builder boundary.
// Empty/disabled values also withdraw previously persisted remote overrides.
export function sourceWebExportDiagnosticEnv(env) {
  return { HAPPIER_UI_EXPORT_SOURCE_MAPS: env.HAPPIER_UI_EXPORT_SOURCE_MAPS === '1' ? '1' : '0',
    HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS: env.HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS ?? '' };
}

export function sourceWebExportArgs(env, outputDir) {
  return applyExpoExportMaxWorkersArgs(['export', '--platform', 'web',
    ...(env.HAPPIER_UI_EXPORT_SOURCE_MAPS === '1' ? ['--source-maps'] : []),
    ...(outputDir ? ['--output-dir', outputDir] : [])], env);
}
