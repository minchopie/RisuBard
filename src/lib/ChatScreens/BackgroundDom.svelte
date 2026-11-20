<script lang="ts">
    import { ParseMarkdown, risuChatParser } from "src/ts/parser/parser.svelte";
    import { type character } from "src/ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { moduleBackgroundEmbedding, ReloadGUIPointer, selIdState } from "src/ts/stores.svelte";

    import { onDestroy } from 'svelte';

    let backgroundHTML = $derived(DBState.db?.characters?.[selIdState.selId]?.backgroundHTML)
    let currentChar:character = $derived(DBState.db?.characters?.[selIdState.selId])

    let renderedBackground = $state('')
    let request = 0
    let previousIndex: number | undefined
    let previousCharacter: string | undefined

    $effect.pre(() => {
        const index = selIdState.selId
        const char = currentChar
        const charId = char?.chaId
        const html = backgroundHTML
        const embedding = $moduleBackgroundEmbedding
        const current = ++request

        if (index !== previousIndex || charId !== previousCharacter) {
            renderedBackground = ''
        }
        previousIndex = index
        previousCharacter = charId
        if (index < 0 || !(html || embedding)) {
            renderedBackground = ''
            return
        }

        void $ReloadGUIPointer
        void ParseMarkdown(risuChatParser((html || '') + '\n' + (embedding || ''), {chara:char}), char, 'back')
            .then(md => {
                if (current === request) renderedBackground = md
            }, error => {
                if (current !== request) return
                renderedBackground = ''
                console.error('Failed to render chat background', error)
            })
    })

    onDestroy(() => { request++ })
</script>


{#if backgroundHTML || $moduleBackgroundEmbedding}
    {#if selIdState.selId > -1}
        <div class="absolute top-0 left-0 w-full h-full">
            {@html renderedBackground}
        </div>
    {/if}
{/if}