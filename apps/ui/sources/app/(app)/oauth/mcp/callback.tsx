import { McpOAuthCallbackPage } from '@/components/settings/mcpServers/signIn/McpOAuthCallbackPage';

/** The MCP sign-in return at `MCP_OAUTH_CALLBACK_URL_V1` (C34); public before sign-in via `isPublicRouteForUnauthenticated`. */
export default function McpOAuthCallbackRoute() {
    return <McpOAuthCallbackPage />;
}
