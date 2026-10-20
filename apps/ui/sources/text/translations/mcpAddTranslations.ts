// The MCP server Add modal (P7 U7.10): Catalog details, Paste a config and the Custom handoff. Mounted under
// `capabilities.mcpAdd`. Non-English locales carry the English block until the locale sweep.

type Count = Readonly<{ count: number }>;
type Source = Readonly<{ source: string }>;

const compact = (count: number): string =>
  count >= 1000
    ? `${(count / 1000).toFixed(count >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k`
    : String(count);

export type McpAddTranslation = Readonly<{
  title: string;
  subtitle: string;
  modes: Readonly<{ catalog: string; paste: string; custom: string }>;
  searchPlaceholder: (params: Readonly<{ count: number | null }>) => string;
  groupAll: string;
  groupPicks: string;
  groupSource: (params: Source) => string;
  noMatch: (params: Readonly<{ query: string }>) => string;
  nothingHere: string;
  clear: string;
  add: string;
  addServer: string;
  addAndSignIn: string;
  open: string;
  inCatalog: string;
  via: (params: Source) => string;
  detail: Readonly<{
    needsTitle: string;
    needsBody: string;
    nothingNeeded: string;
    keySaved: string;
    runsTitle: string;
    signInTitle: (params: Readonly<{ name: string }>) => string;
    signInBody: string;
    runsRemote: string;
    runsNpx: string;
    runsUvx: string;
    runsDocker: string;
    nextTitle: string;
    nextSaved: string;
    nextSavedKey: string;
    nextSignIn: string;
    nextSessions: string;
    nextUntouched: string;
    signInNote: (params: Readonly<{ host: string }>) => string;
    runsNote: string;
    stillNeeded: (params: Count) => string;
    unsupported: string;
    deprecated: string;
    loading: string;
    loadFailed: string;
    retry: string;
    chooseValue: string;
  }>;
  paste: Readonly<{
    label: string;
    placeholder: string;
    reads: string;
    empty: string;
    found: (params: Count) => string;
    foundBody: string;
    local: string;
    remote: string;
    transport: string;
    http: string;
    sse: string;
    keySaved: (params: Readonly<{ key: string; name: string }>) => string;
    needsValues: string;
    otherValues: string;
    skipped: (params: Readonly<{ name: string }>) => string;
    skippedPaste: (params: Readonly<{ name: string }>) => string;
    addN: (params: Count) => string;
    footNote: string;
    stillNeeded: (params: Count) => string;
    unreadable: string;
    noServers: string;
    warnings: string;
    addFailed: string;
  }>;
}>;

const en: McpAddTranslation = {
  title: 'Add a server',
  subtitle: 'From a registry, a config you already use, or your own command.',
  modes: { catalog: 'Catalog', paste: 'Paste a config', custom: 'Custom' },
  searchPlaceholder: ({ count }) =>
    count === null || count === 0
      ? 'Search servers'
      : `Search ${compact(count)} servers`,
  groupAll: 'In your registries',
  groupPicks: 'Happier picks',
  groupSource: ({ source }) => `From ${source}`,
  noMatch: ({ query }) => `No servers match “${query}”`,
  nothingHere: 'Nothing to browse here yet',
  clear: 'Clear',
  add: 'Add',
  addServer: 'Add server',
  addAndSignIn: 'Add and sign in',
  open: 'Open',
  inCatalog: 'Added',
  via: ({ source }) => `via ${source}`,
  detail: {
    needsTitle: 'What it needs',
    needsBody: 'From the server’s declared inputs.',
    nothingNeeded: 'Nothing to set up.',
    keySaved: 'A key is saved to your secrets. Only your devices can read it.',
    runsTitle: 'What runs where',
    signInTitle: ({ name }) => `Sign in to ${name}`,
    signInBody:
      'You approve access once, on any device. Every machine then uses that sign-in; agents never see the token.',
    runsRemote: 'Remote. Each machine connects to it directly.',
    runsNpx:
      'Runs on each machine with npx. Happier provides it, so there’s nothing to install.',
    runsUvx:
      'Runs on each machine with uvx. A machine without uv can’t start it yet.',
    runsDocker:
      'Runs in Docker on each machine, so Docker has to be installed there.',
    nextTitle: 'What happens next',
    nextSaved: 'It’s saved to your Account, end-to-end encrypted.',
    nextSavedKey:
      'It’s saved to your Account, end-to-end encrypted, with its key as a Saved Secret.',
    nextSignIn:
      'You sign in to it once, on this device; every machine then uses that sign-in.',
    nextSessions:
      'The next session on each machine gets it. Running sessions don’t change.',
    nextUntouched: 'Your agents’ own config files aren’t touched.',
    signInNote: ({ host }) => `Opens ${host} in your browser to approve.`,
    runsNote: 'Nothing runs until a session starts.',
    stillNeeded: ({ count }) =>
      count === 1 ? 'One value still needed' : `${count} values still needed`,
    unsupported: 'Happier can’t run this server’s package type yet.',
    deprecated: 'Marked deprecated in its registry.',
    loading: 'Reading it…',
    loadFailed: 'Couldn’t read this server. Try again.',
    retry: 'Try again',
    chooseValue: 'Needs a value',
  },
  paste: {
    label: 'Config to add',
    placeholder: '{ "mcpServers": { … } }   or an install link',
    reads: 'Also reads Cursor, VS Code, Codex and install links',
    empty: 'Paste a server config or an install link to see what it adds.',
    found: ({ count }) =>
      count === 1 ? 'Found 1 server' : `Found ${count} servers`,
    foundBody:
      'Nothing runs until you add them. Sign-ins and keys are asked for next.',
    local: 'Local',
    remote: 'Remote',
    transport: 'Connects over',
    http: 'Streamable HTTP',
    sse: 'SSE',
    keySaved: ({ key, name }) =>
      `${key} was pasted as plain text. It will be saved as the secret ${name}, never kept in the config.`,
    needsValues: 'Needs a value',
    otherValues: 'Other values',
    skipped: ({ name }) => `${name} is already added. Skipped.`,
    skippedPaste: ({ name }) => `${name} appears twice in this paste. Skipped.`,
    addN: ({ count }) => (count === 1 ? 'Add server' : `Add ${count} servers`),
    footNote: 'Keys found in a paste are moved into Saved Secrets.',
    stillNeeded: ({ count }) =>
      count === 1 ? 'One value still needed' : `${count} values still needed`,
    unreadable: 'This isn’t a config or an install link Happier can read.',
    noServers: 'No servers in this paste.',
    warnings: 'Left out',
    addFailed: 'Couldn’t add these servers. Try again.',
  },
};

const locales = [
  'en',
  'ca',
  'de',
  'es',
  'fr',
  'it',
  'ja',
  'pl',
  'pt',
  'ru',
  'zhHans',
  'zhHant',
] as const;

export const mcpAddTranslations = Object.fromEntries(
  locales.map((locale) => [locale, en]),
) as Record<(typeof locales)[number], McpAddTranslation>;
