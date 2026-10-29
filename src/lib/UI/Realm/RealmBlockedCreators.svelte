<script lang="ts">
    import { language } from 'src/lang';
    import { removeBlockedRealmCreator } from 'src/ts/realmBlocking';
    import { DBState } from 'src/ts/stores.svelte';
    import ShButton from '../GUI/ShButton.svelte';
    import ShDialog from '../GUI/ShDialog.svelte';

    interface Props {
        open: boolean;
        onUnblock?: () => void | Promise<void>;
    }

    let { open = $bindable(), onUnblock = () => {} }: Props = $props();
    let blockedCreators = $derived(DBState.db.blockedRealmCreators ?? []);
</script>

<ShDialog bind:open size="sm" closeOnEscape={true} closeOnOutsideClick={true}>
    {#snippet title()}{language.blockedRealmCreators}{/snippet}
    {#if blockedCreators.length === 0}
        <p class="text-sm text-textcolor2">{language.noBlockedRealmCreators}</p>
    {:else}
        <ul class="flex max-h-[60dvh] flex-col gap-2 overflow-y-auto">
            {#each blockedCreators as creator (creator.id)}
                <li class="flex min-w-0 items-center gap-3 rounded-xl border border-darkborderc p-3">
                    <div class="min-w-0 grow">
                        <div class="truncate text-sm font-medium text-textcolor">{creator.name}</div>
                        <div class="truncate text-xs text-textcolor2">{creator.id}</div>
                    </div>
                    <ShButton variant="outline" size="sm" onclick={async () => {
                        DBState.db.blockedRealmCreators = removeBlockedRealmCreator(blockedCreators, creator.id);
                        await onUnblock();
                    }}>{language.unblockRealmCreator}</ShButton>
                </li>
            {/each}
        </ul>
    {/if}
</ShDialog>
