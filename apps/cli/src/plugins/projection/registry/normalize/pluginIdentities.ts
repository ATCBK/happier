/** One plugin identity may contribute once to a reference universe. */
export function assertUniquePluginIdentities(plugins: readonly Readonly<{ pluginId: string }>[]): void {
  const seenPluginIds = new Set<string>();
  for (const plugin of plugins) {
    if (seenPluginIds.has(plugin.pluginId)) {
      throw new Error(`Duplicate plugin identity '${plugin.pluginId}' in contribution reference universe`);
    }
    seenPluginIds.add(plugin.pluginId);
  }
}
