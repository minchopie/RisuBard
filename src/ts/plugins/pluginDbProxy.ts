// `db.plugins` from a plugin's setDatabase(): only installs are honored.
// `approve` filters the list down to the plugins the user just approved
// (handlePluginInstallViaPlugin), so assigning that result dropped every plugin
// it does not list — the plain round-trip `setDatabase(await getDatabase())`
// emptied the whole list without a prompt. An approved plugin replaces the
// installed one of the same name (an update) or is appended; none is removed.
// The list is read, merged and written in one synchronous step after the
// approval: another setDatabase() may have installed a plugin while this one
// waited, and concurrent prompts can be answered by the same click.
export async function installApprovedPlugins<T extends { name: string }>(
    requested: T[],
    approve: (plugins: T[]) => Promise<T[]>,
    list: { get(): T[]; set(plugins: T[]): void },
): Promise<void> {
    const approved = await approve(requested);
    const next = [...list.get()];
    for (const plugin of approved) {
        const index = next.findIndex((p) => p.name === plugin.name);
        if (index === -1) next.push(plugin);
        else next[index] = plugin;
    }
    list.set(next);
}
