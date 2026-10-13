import type { McpRegistryServerV1, McpRegistryInputV1, McpRegistryArgumentV1 } from '../../../registries/registryItemsV1.js';
import { McpServerCatalogEntryV1Schema, type McpServerCatalogEntryV1 } from '../settingsV1.js';
import { resolveValueRefPlaintextV1, type ValueRefV1 } from '../../../valueRefs/valueRefV1.js';

export type McpRegistryMissingValueV1 = Readonly<{ serverName: string; key: string; target: 'env' | 'header' | 'url-variable' | 'argument' }>;
/** Registry wire data declares no OAuth fact. The existing auth choice supplies it. */
export function selectMcpRegistryServerTransportV1(server: McpRegistryServerV1, options: Readonly<{ oauth?: boolean; previous?: McpServerCatalogEntryV1 }> = {}) {
  const commandKind = options.previous?.stdio?.command === 'uvx' ? 'pypi' : options.previous?.stdio?.command === 'docker' ? 'oci' : 'npm';
  const packages = server.packages.filter(pkg => pkg.transport === 'stdio' && ['npm', 'pypi', 'oci'].includes(pkg.ecosystem));
  const pkg = options.previous?.transport === 'stdio' ? packages.find(pkg => pkg.ecosystem === commandKind) ?? packages[0]
    : ['npm', 'pypi', 'oci'].flatMap(kind => packages.filter(pkg => pkg.ecosystem === kind))[0];
  const remote = server.remotes.find(item => item.transport === (options.previous?.transport === 'sse' ? 'sse' : 'streamable-http')) ?? server.remotes[0];
  if (remote && (options.oauth || options.previous && options.previous.transport !== 'stdio' || !pkg)) {
    return { transport: remote.transport === 'sse' ? 'sse' as const : 'http' as const, remote: { url: remote.url }, inputs: remote.inputs,
      arguments: [] as readonly McpRegistryArgumentV1[] };
  }
  if (!pkg) throw Object.assign(new Error('Unsupported registry package'), { code: 'unsupported_entry' });
  // Unpinned executable/package selectors are never admitted as reviewed versions.
  if (pkg.ecosystem !== 'oci' && (!pkg.version || /[\s*~^<>=|]/u.test(pkg.version) || pkg.version === 'latest'))
    throw Object.assign(new Error('Unpinned registry package'), { code: 'unsupported_entry' });
  const specifier = pkg.ecosystem === 'npm' ? `${pkg.identifier}@${pkg.version}`
    : pkg.ecosystem === 'pypi' ? `${pkg.identifier}==${pkg.version}` : pkg.identifier;
  const command = pkg.ecosystem === 'npm' ? 'npx' : pkg.ecosystem === 'pypi' ? 'uvx' : 'docker';
  return { transport: 'stdio' as const, stdio: { command, specifier, prefix: pkg.ecosystem === 'npm' ? ['-y'] : pkg.ecosystem === 'oci' ? ['run', '--rm', '-i'] : [] },
    inputs: pkg.environment, runtimeArguments: pkg.runtimeArguments, arguments: pkg.packageArguments };
}
export function mapMcpRegistryServerV1(input: Readonly<{ server: McpRegistryServerV1; id: string; name: string; nowMs: number;
  inputs?: Readonly<Record<string, ValueRefV1>>; previous?: McpServerCatalogEntryV1; oauth?: boolean }>):
  Readonly<{ ok: true; entry: McpServerCatalogEntryV1 }> | Readonly<{ ok: false; missingValues: readonly McpRegistryMissingValueV1[] }> {
  const selected = selectMcpRegistryServerTransportV1(input.server, input);
  const missing: McpRegistryMissingValueV1[] = [];
  const supplied = (name: string) => input.inputs && Object.hasOwn(input.inputs, name) ? input.inputs[name] : undefined;
  const read = (item: Pick<McpRegistryInputV1, 'name' | 'value' | 'default' | 'required' | 'variables' | 'target' | 'choices'>): ValueRefV1 | undefined => {
    const existing = item.target === 'env' ? input.previous?.env[item.name]
      : item.target === 'header' ? input.previous?.remote?.headers[item.name] : input.previous?.remote?.urlTemplate?.vars[item.name];
    const own = supplied(item.name) ?? existing;
    if (own) {
      if (item.choices && (own.t !== 'literal' || !item.choices.includes(own.v))) throw Object.assign(new Error('Invalid registry choice'), { code: 'invalid_registry_input' });
      return own;
    }
    if (item.value !== undefined && item.variables) {
      const vars: Record<string, Extract<ValueRefV1, { t: 'literal' | 'savedSecret' }>> = {};
      for (const [name, variable] of Object.entries(item.variables)) {
        const choice = supplied(name) ?? (variable.value !== undefined || variable.default !== undefined
          ? { t: 'literal' as const, v: variable.value ?? variable.default! } : undefined);
        if (!choice || choice.t !== 'literal' && choice.t !== 'savedSecret') missing.push({ serverName: input.name, key: name, target: item.target });
        else vars[name] = choice;
      }
      return { t: 'template', template: item.value, vars };
    }
    if (item.value !== undefined || item.default !== undefined) return { t: 'literal', v: item.value ?? item.default! };
    if (item.required) missing.push({ serverName: input.name, key: item.name, target: item.target });
    return undefined;
  };
  const env = { ...(input.previous?.env ?? {}) };
  const headers = { ...(input.previous?.remote?.headers ?? {}) };
  const urlVars: Record<string, Extract<ValueRefV1, { t: 'literal' | 'savedSecret' }>> = {};
  for (const item of selected.inputs) {
    const value = read(item);
    if (!value) continue;
    if (item.target === 'env') env[item.name] = value;
    else if (item.target === 'header') headers[item.name] = value;
    else if (value.t === 'literal' || value.t === 'savedSecret') urlVars[item.name] = value;
    else missing.push({ serverName: input.name, key: item.name, target: 'url-variable' });
  }
  const args = (values: readonly McpRegistryArgumentV1[]) => values.flatMap((arg, index) => {
    const name = arg.name ?? arg.valueHint ?? `argument:${index}`;
    if (arg.secret || Object.values(arg.variables ?? {}).some(variable => variable.secret))
      throw Object.assign(new Error('Secret arguments cannot enter Agent launch data'), { code: 'unsupported_entry' });
    const value = read({ ...arg, name, target: 'env' });
    if (!value) return arg.type === 'named' && arg.name && !arg.required ? [arg.name] : [];
    const literal = resolveValueRefPlaintextV1(value, () => null);
    if (literal === null) { missing.push({ serverName: input.name, key: name, target: 'argument' }); return []; }
    return arg.type === 'named' && arg.name ? [arg.name, literal] : [literal];
  });
  const runtimeArgs = 'runtimeArguments' in selected ? args(selected.runtimeArguments ?? []) : [];
  const packageArgs = args(selected.arguments);
  if (missing.length) return { ok: false, missingValues: missing };
  const base = { ...(input.previous ?? {}), id: input.id, name: input.name, title: input.previous?.title ?? input.server.title,
    description: input.server.description, env, transport: selected.transport, createdAt: input.previous?.createdAt ?? input.nowMs, updatedAt: input.nowMs };
  if (selected.transport === 'stdio') {
    const { remote: _remote, ...local } = base;
    return { ok: true, entry: McpServerCatalogEntryV1Schema.parse({ ...local, stdio: {
      ...input.previous?.stdio, command: selected.stdio!.command,
      args: [...selected.stdio!.prefix, ...runtimeArgs, selected.stdio!.specifier, ...packageArgs],
    } }) };
  }
  const { stdio: _stdio, ...remoteBase } = base;
  const rawUrl = selected.remote!.url;
  const template = Object.keys(urlVars).length ? { t: 'template' as const, template: rawUrl, vars: urlVars } : undefined;
  // Stored URL is a credential-free endpoint; values materialize only in the private bridge file.
  const endpoint = new URL(rawUrl.replace(/\{[^{}]+\}/gu, 'input'));
  if (template) endpoint.search = '';
  const safeUrl = template ? endpoint.href : rawUrl;
  return { ok: true, entry: McpServerCatalogEntryV1Schema.parse({ ...remoteBase, remote: { url: safeUrl, headers,
    ...(template ? { urlTemplate: template } : {}), ...(input.oauth || input.previous?.remote?.auth ? { auth: { kind: 'oauth' } } : {}) } }) };
}
