const plainRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/** A guest-driven turn's app-server: shell, unified exec and image reads (codex-cli 0.159.0
 * `features`) off, web search too. */
export const GUEST_CONFINED_CODEX_ARGS = [
  "-c", "features.shell_tool=false", "-c", "features.unified_exec=false", "-c", "features.view_image=false", "-c", 'web_search="disabled"',
] as const;

export function codexShellDisabled(config: unknown): boolean {
  const features = plainRecord(plainRecord(config)?.features);
  return features?.shell_tool === false && features?.unified_exec === false && features?.view_image === false;
}

/** Codex's elevated Windows sandbox re-applies its ACLs before every command and fails the
 * command on any path it cannot update ("setup refresh had errors": openai/codex#52862,
 * openai/codex#53946); the unelevated one has no such step. Codex picks `windows.sandbox`, else
 * the removed `elevated_windows_sandbox` flag (codex-cli 0.162.1). */
export function codexWindowsSandboxOverride(config: unknown, platform: NodeJS.Platform = process.platform): Record<string, string> | null {
  if (platform !== "win32") return null;
  const record = plainRecord(config);
  const configured = plainRecord(record?.windows)?.sandbox;
  const elevated = typeof configured === "string" ? configured === "elevated" : plainRecord(record?.features)?.elevated_windows_sandbox === true;
  return elevated ? { "windows.sandbox": "unelevated" } : null;
}
