// @ts-check

/**
 * @typedef {{
 *   summary: string;
 *   usage: string;
 *   options?: string[];
 *   bullets: string[];
 *   examples: string[];
 * }} CommandHelpSpec
 */

/** @type {Record<string, CommandHelpSpec>} */
export const COMMAND_HELP_CHECKS = {
  'perf-validate': {
    summary: 'Compare deterministic counts, paired scenario timings, and post-GC heap growth.',
    usage: 'node scripts/pipeline/run.mjs perf-validate --baseline-ref <ref> --out <dir> [--candidate-ref <ref>] [--baseline-results-dir <dir> | --candidate-only] [--repeats <n>] [--profile <pr|full>] [--dry-run] [--release]',
    options: [
      '--baseline-ref <ref>              Required Git comparison baseline.',
      '--candidate-ref <ref>             Defaults to current source.',
      '--baseline-results-dir <dir>      Reuse canonical exact-base JSON instead of rebuilding it.',
      '--candidate-only                  Capture head results with comparison unavailable.',
      '--out <dir>                       Comparison report and profile directory.',
      '--repeats <n>                     At least five paired repetitions.',
      '--dry-run                         Plan without building or starting services.',
      '--release                         Mark the run as release performance evidence.',
      '--profile <pr|full>               Short PR scenarios or the full nightly/release set.',
    ],
    bullets: ['Scenario counts, timing, heap and bundle measurements are informational until deliberate-regression failure and ten unchanged successful runs establish a stable gate.', 'Existing validated count contracts gate in their test jobs. Setup failures are incomplete evidence. Release dispatch remains maintainer-owned.'],
    examples: ['node scripts/pipeline/run.mjs perf-validate --baseline-ref cli-v0.2.4 --out .happier/qa/perf/release --repeats 5 --release'],
  },
  'checks-plan': {
    summary: 'Print the resolved CI check plan for a given profile.',
    usage:
      'node scripts/pipeline/run.mjs checks-plan --profile <none|fast|full|custom> [--custom-checks <csv>] [--github-output <path>] [--dry-run]',
    options: [
      '--profile <name>                  Required; none|fast|full|custom.',
      '--custom-checks <csv>             Required when --profile custom.',
      '--github-output <path>            Optional; writes KEY=VALUE lines for Actions.',
      '--dry-run',
    ],
    bullets: ['Useful to see exactly what `checks` would run before you execute it.'],
    examples: [
      'node scripts/pipeline/run.mjs checks-plan --profile fast',
      'node scripts/pipeline/run.mjs checks-plan --profile custom --custom-checks e2e_core,build_docs',
    ],
  },

  checks: {
    summary: 'Run selected local checks and report all independent failures.',
    usage:
      'node scripts/pipeline/run.mjs checks --profile <none|fast|full|custom> [--custom-checks <csv>] [--install-deps <auto|true|false>] [--dry-run]',
    options: [
      '--profile <name>                  Required; none|fast|full|custom.',
      '--custom-checks <csv>             Required when --profile custom.',
      '--install-deps <auto|true|false>  (default: auto).',
      '--dry-run',
    ],
    bullets: [
      'Use this when iterating on CI locally instead of waiting for GitHub runners.',
      'Custom selects exactly the named lanes: unit,integration,typecheck,release_contracts,ui_e2e,e2e_core,e2e_core_slow,server_db_contract,stress,build_website,build_docs,cli_smoke_linux,release_assets_e2e,self_host_systemd,self_host_launchd,self_host_schtasks,self_host_daemon.',
      'fast/full preserve local coverage; hosted fast/full also select platform jobs. Self-host checks require explicit custom opt-in locally.',
      'e2e_core_slow includes the fast core lane. release_contracts includes installer synchronization checks. Dependency installation remains a prerequisite.',
      'Uses your local toolchain; if GitHub differs, prefer running checks in a clean container/VM.',
    ],
    examples: [
      'node scripts/pipeline/run.mjs checks --profile fast',
      'node scripts/pipeline/run.mjs checks --profile custom --custom-checks e2e_core_slow,server_db_contract',
    ],
  },

  'smoke-cli': {
    summary: 'Run the CLI smoke test (sanity-check a built CLI package).',
    usage:
      'node scripts/pipeline/run.mjs smoke-cli [--package-dir <dir>] [--workspace-name <name>] [--skip-build true|false] [--dry-run]',
    options: [
      '--package-dir <dir>               (default: apps/cli).',
      '--workspace-name <name>           (default: @happier-dev/cli).',
      '--skip-build <bool>               true|false (default: false).',
      '--dry-run',
    ],
    bullets: ['Useful before publishing npm packages or CLI binaries.'],
    examples: ['node scripts/pipeline/run.mjs smoke-cli --skip-build false'],
  },
};
