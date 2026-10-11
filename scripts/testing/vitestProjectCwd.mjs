// Projects share one Vitest parent, but isolated fork workers retain package cwd.
process.chdir(process.env.HAPPIER_VITEST_PROJECT_ROOT);
