import type { AppConfig } from "./config.ts";
import { scienceRelayCredential, type ServiceCredential } from "./included-services.ts";
import { isRemoteMcpServer, parseStoredMcpServer, type McpOAuthClientConfig } from "./mcp-registry.ts";

export type CloudMcpAuth = { token: string } | "needs-max" | null;

/** Security: the relay token is returned only for an address under the relay base itself (same origin, path below
 * it, no credentials, query or fragment), never for another server whatever its stored entry claims. */
export function relayToken(url: string, credential: ServiceCredential | null): string | null {
  if (!credential) return null;
  try {
    const target = new URL(url);
    const base = new URL(credential.api);
    if (target.origin !== base.origin || target.username || target.password || target.search || target.hash) return null;
    return target.pathname.startsWith(`${base.pathname.replace(/\/+$/, "")}/`) ? credential.token : null;
  } catch {
    return null;
  }
}

/** The sign-in manager's view of the stored servers: an app's own OAuth registration, and MausBot Cloud auth for
 * servers under the relay base or marked as Cloud entries, which need Max while no usable relay token is held. */
export function storedMcpAuth(
  config: () => Pick<AppConfig, "mcpServers">,
  credential: () => ServiceCredential | null = scienceRelayCredential,
): { clients(name: string, url: string): McpOAuthClientConfig | undefined; cloud(name: string, url: string): CloudMcpAuth } {
  const stored = (name: string) => {
    const raw = config().mcpServers?.[name];
    const parsed = raw === undefined ? null : parseStoredMcpServer(name, raw);
    return parsed?.ok && isRemoteMcpServer(parsed.server) ? parsed.server : null;
  };
  return {
    clients: (name, url) => {
      const server = stored(name);
      return server && server.url === url ? server.oauth : undefined;
    },
    cloud: (name, url) => {
      const token = relayToken(url, credential());
      if (token) return { token };
      const server = stored(name);
      return server && server.url === url && server.catalog?.auth === "cloud" ? "needs-max" : null;
    },
  };
}
