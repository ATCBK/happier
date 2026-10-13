// Isolated fork workers share one Vitest parent while retaining package cwd.
process.chdir(process.env.HAPPIER_VITEST_PROJECT_ROOT);
