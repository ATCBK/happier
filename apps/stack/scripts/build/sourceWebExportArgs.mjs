import { applyExpoExportMaxWorkersArgs } from '../utils/expo/command.mjs';

// Only this non-secret diagnostic option crosses the remote builder boundary.
// Explicit zero also withdraws a previously persisted remote opt-in.
export function sourceWebExportDiagnosticEnv(env) {
  return { HAPPIER_UI_EXPORT_SOURCE_MAPS: env.HAPPIER_UI_EXPORT_SOURCE_MAPS === '1' ? '1' : '0' };
}

export function sourceWebExportArgs(env, outputDir) {
  return applyExpoExportMaxWorkersArgs(['export', '--platform', 'web',
    ...(env.HAPPIER_UI_EXPORT_SOURCE_MAPS === '1' ? ['--source-maps'] : []),
    ...(outputDir ? ['--output-dir', outputDir] : [])], env);
}
