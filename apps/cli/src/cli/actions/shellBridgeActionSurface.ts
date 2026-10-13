/** Shell bridge provenance lowers a generated invocation to the Agent caller surface. */
export function resolveShellBridgeActionSurfaceV1(args: readonly string[]): 'cli' | 'agent' {
  return args.includes('--agent-bridge') ? 'agent' : 'cli';
}
