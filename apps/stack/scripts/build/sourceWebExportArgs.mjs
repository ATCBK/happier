import { applyExpoExportMaxWorkersArgs } from '../utils/expo/command.mjs';

export function sourceWebExportArgs(env, outputDir) {
  return applyExpoExportMaxWorkersArgs(['export', '--platform', 'web',
    ...(env.HAPPIER_UI_EXPORT_SOURCE_MAPS === '1' ? ['--source-maps'] : []),
    ...(outputDir ? ['--output-dir', outputDir] : [])], env);
}
