export function applyStackInfraProcessKind(env) {
  if (!(env.HAPPIER_STACK_ENV_FILE ?? '').toString().trim()) {
    return env;
  }
  return { ...env, HAPPIER_STACK_PROCESS_KIND: 'infra' };
}
