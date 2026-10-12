import { GITHUB_API_VERSION, GITHUB_PLUGIN_ID } from './githubProviderContracts.js';

const RESERVED_GITHUB_HEADERS = new Set(['accept', 'authorization', 'user-agent', 'x-github-api-version']);

/** GitHub's required REST headers, shared by identity, source and SCM requests. */
export function createGithubRequestHeaders(input: Readonly<{
  authorization?: string;
  userAgent?: string;
  headers?: Readonly<Record<string, string>>;
}>): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(input.headers ?? {}).filter(
      ([name]) => !RESERVED_GITHUB_HEADERS.has(name.toLowerCase()),
    )),
    Accept: 'application/vnd.github+json',
    ...(input.authorization ? { Authorization: input.authorization } : {}),
    'User-Agent': input.userAgent ?? GITHUB_PLUGIN_ID,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}
