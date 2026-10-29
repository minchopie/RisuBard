<script lang="ts">
    import { ParseMarkdown } from 'src/ts/parser/parser.svelte'
    import { ColorSchemeTypeStore } from 'src/ts/gui/colorscheme'
    import { DBState } from 'src/ts/stores.svelte'
    import { ChevronLeftIcon, ChevronRightIcon, CircleQuestionMarkIcon, LocateFixedIcon } from '@lucide/svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import type { Message } from 'src/ts/storage/database.svelte'
    import { OOC_TURN_MARKER, buildOocGroups } from 'src/ts/risubard/oocTurns'
    import { language } from 'src/lang'

    let { messages, hideOoc = false, onHideChange, onNavigate }: {
        messages: Message[]
        hideOoc?: boolean
        onHideChange: (value: boolean) => void
        onNavigate?: (index: number) => void
    } = $props()
    let query = $state('')
    let selectedGroupId = $state('')
    let helpOpen = $state(false)
    let fontSize = $state(DBState.db.risuBardOocFontSize ?? 14)
    let markdownEnabled = $state(DBState.db.risuBardOocMarkdown !== false)
    let scroller = $state<HTMLElement | null>(null)
    let groups = $derived(buildOocGroups(messages))
    let matchingGroups = $derived(groups.map(group => ({ ...group, entries: group.entries.filter(({ message }) =>
        !query.trim() || message.data.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) }))
        .filter(group => group.entries.length > 0))
    let selectedGroup = $derived(matchingGroups.find(group => group.id === selectedGroupId) ?? matchingGroups[0])
    let groupIndex = $derived(matchingGroups.findIndex(group => group.id === selectedGroup?.id))

    function selectGroup(id: string) {
        selectedGroupId = id
        if (scroller) scroller.scrollTop = 0
    }

    function navigate(index: number) {
        onHideChange(false)
        onNavigate?.(index)
    }

    function setFontSize(event: Event) {
        const input = event.currentTarget as HTMLInputElement
        const value = input.valueAsNumber
        if (!Number.isFinite(value)) return
        fontSize = Math.min(48, Math.max(8, value))
        input.value = String(fontSize)
        DBState.db.risuBardOocFontSize = fontSize
    }
</script>

<section class="ooc-notepad" data-ooc-notepad aria-label="OOC 메모장" bind:this={scroller}>
    <header>
        <div class="heading">
            <div class="title"><h2>OOC 메모장</h2>
                <button type="button" class="icon-button" data-ooc-help aria-label="OOC 메모장 도움말" title="OOC 메모장 도움말" onclick={() => helpOpen = true}><CircleQuestionMarkIcon size={16} /></button>
            </div>
            <div class="display-options">
                <label><input type="checkbox" data-ooc-hide checked={hideOoc}
                    onchange={(event) => onHideChange(event.currentTarget.checked)} />{language.risuBardHideOocTurns}</label>
                <label title="메모장 글자 크기"><input class="font-size" type="number" min="8" max="48" step="1" aria-label="메모장 글자 크기" value={fontSize} onchange={setFontSize} />px</label>
                <label title="마크다운 서식"><input type="checkbox" data-ooc-md checked={markdownEnabled}
                    onchange={(event) => { markdownEnabled = event.currentTarget.checked; DBState.db.risuBardOocMarkdown = markdownEnabled }} />MD</label>
            </div>
        </div>
        <div class="search-row">
            <select data-ooc-group aria-label="OOC 그룹" value={selectedGroup?.id ?? ''} disabled={!matchingGroups.length}
                onchange={(event) => selectGroup(event.currentTarget.value)}>
                {#each matchingGroups as group (group.id)}<option value={group.id}>{group.startTurn === undefined ? group.label : `턴 ${group.label}`}</option>{/each}
                {#if !matchingGroups.length}<option value="">OOC 없음</option>{/if}
            </select>
            <button type="button" class="icon-button" data-ooc-group-previous aria-label="이전 OOC 그룹" title="이전 OOC 그룹" disabled={groupIndex <= 0}
                onclick={() => selectGroup(matchingGroups[groupIndex - 1].id)}><ChevronLeftIcon size={18} /></button>
            <button type="button" class="icon-button" data-ooc-group-next aria-label="다음 OOC 그룹" title="다음 OOC 그룹" disabled={groupIndex < 0 || groupIndex >= matchingGroups.length - 1}
                onclick={() => selectGroup(matchingGroups[groupIndex + 1].id)}><ChevronRightIcon size={18} /></button>
            <input class="search" type="search" placeholder="OOC 내용 검색" aria-label="OOC 내용 검색" bind:value={query} />
        </div>
    </header>
    <div class="entries">
        {#each selectedGroup?.entries ?? [] as { message, index, turn } (index)}
            <article class:user={message.role === 'user'} data-ooc-message-index={index}>
                <div class="message-label">
                    <span>{message.role === 'user' ? '사용자' : 'AI 응답'}</span>
                    <span>{turn === undefined ? `메시지 ${index + 1}` : `턴 ${turn}`}</span>
                    {#if message.disabled}<span>비활성</span>{/if}
                    <button type="button" class="source-button" data-ooc-source disabled={!onNavigate} onclick={() => navigate(index)}><LocateFixedIcon size={14} />원문으로 이동</button>
                </div>
                <div class="content" class:chattext={markdownEnabled} class:prose={markdownEnabled}
                    class:prose-invert={$ColorSchemeTypeStore === 'dark'}
                    style:font-size={`${fontSize}px`}
                    style:line-height={`${(DBState.db.lineHeight ?? 1.25) / 0.875}`}
                >
                    {#if markdownEnabled}
                    {#await ParseMarkdown(message.data.split(OOC_TURN_MARKER).join(''))}
                        <span class="whitespace-pre-wrap">{message.data.split(OOC_TURN_MARKER).join('')}</span>
                    {:then html}
                        {@html html}
                    {:catch}
                        <span class="whitespace-pre-wrap">{message.data.split(OOC_TURN_MARKER).join('')}</span>
                    {/await}
                    {:else}
                        <span class="whitespace-pre-wrap">{message.data.split(OOC_TURN_MARKER).join('')}</span>
                    {/if}
                </div>
            </article>
        {:else}
            <p class="empty">{groups.length ? '검색 결과가 없습니다.' : '현재 챗에 OOC 턴이 없습니다.'}</p>
        {/each}
    </div>
</section>

<ShDialog bind:open={helpOpen} ariaLabel="OOC 메모장 도움말" closeOnEscape>
    {#snippet title()}OOC 메모장{/snippet}
    <div class="help-content">
        <p>AI 응답 원문에 <code>{OOC_TURN_MARKER}</code>가 포함되어 있으면 OOC 턴으로 인식하고 대응 사용자 입력도 함께 표시합니다.</p>
        <p>원본 채팅을 직접 보여주는 메모장입니다. 원본 수정, 재생성, 삭제는 여기에도 반영되며 별도 복사본을 저장하지 않습니다.</p>
        <p>OOC 응답과 대응 사용자 입력은 바드위키 분석, 재분석, 리부트와 과거 원문 검색에서 항상 제외됩니다.</p>
        <p>답변을 만들 때는 마지막 일반 응답 뒤에 이어진 OOC 묶음을 모두 넣고, ‘답변에 그대로 넣을 최근 응답 수’는 그 앞의 일반 대화만으로 셉니다. 중간에 일반 응답이 한 번이라도 있으면 그 앞의 OOC는 넣지 않습니다. 프롬프트에 <code>ooc</code> 토글(대소문자 무관)이 있으면 그 값이 0일 때 OOC 묶음을 넣지 않습니다. 토글이 없는 프롬프트는 직전 응답이 OOC인지만 보고 판단합니다.</p>
        <p><strong>주의:</strong> 이어진 OOC 묶음에는 개수 제한이 없습니다. OOC를 길게 이어갈수록 매 답변에 들어가는 토큰이 계속 늘어납니다. 대화가 길어졌다면 OOC 토글을 끄고 스토리로 돌아가세요.</p>
        <p>‘챗에서 OOC 턴 숨김’은 모든 챗의 화면 표시만 조절합니다. ‘원문으로 이동’을 누르면 숨김을 해제하고 해당 메시지로 이동합니다.</p>
        <p>연속된 AI 턴 번호를 한 그룹으로 묶습니다. 검색은 모든 OOC 그룹을 대상으로 하며, 드롭다운과 화살표로 검색에 맞는 그룹을 이동합니다. 글자 크기와 MD 설정은 메모장에만 적용됩니다.</p>
    </div>
</ShDialog>

<style>
    .ooc-notepad { flex: 1; min-height: 0; overflow: auto; color: var(--color-textcolor); padding: clamp(.8rem, 3vw, 1.5rem); }
    header { display: grid; gap: .65rem; margin-bottom: 1rem; }
    .heading, .title, .display-options, .search-row { display: flex; align-items: center; gap: .5rem; }
    .heading { flex-wrap: wrap; justify-content: space-between; }
    .title { flex-shrink: 0; }
    .display-options { flex-wrap: wrap; min-width: 0; }
    h2 { font-size: 1.1rem; font-weight: 700; }
    .message-label, .empty { color: var(--color-textcolor2); font-size: .8rem; }
    label { display: flex; align-items: center; gap: .35rem; font-size: .8rem; cursor: pointer; white-space: nowrap; }
    input[type='checkbox'] { accent-color: var(--color-primary); }
    .search, select, .font-size { padding: .45rem .5rem; border: 1px solid var(--color-darkborderc); border-radius: .4rem; background: var(--color-darkbg); color: var(--color-textcolor); }
    .search { flex: 1; min-width: 0; }
    select { max-width: 9rem; font-size: .8rem; }
    .font-size { width: 3.6rem; padding: .15rem .25rem; }
    .icon-button, .source-button { display: inline-flex; align-items: center; justify-content: center; gap: .3rem; padding: .35rem; border-radius: .3rem; flex-shrink: 0; }
    button:hover:not(:disabled) { background: var(--color-darkbutton); color: var(--color-primary); }
    button:disabled { opacity: .4; }
    input:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
    .entries { display: grid; gap: .9rem; }
    article { min-width: 0; border: 1px solid var(--color-darkborderc); border-radius: .5rem; background: var(--color-darkbg); padding: 1rem; }
    article.user { border-left: 3px solid var(--color-primary); }
    .message-label { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-bottom: .5rem; }
    .source-button { margin-left: auto; white-space: nowrap; }
    .content { max-width: none; overflow-wrap: anywhere; }
    .help-content { display: grid; gap: .8rem; font-size: .9rem; line-height: 1.65; }
    .help-content code { overflow-wrap: anywhere; }
    .empty { padding: 2rem .5rem; text-align: center; }
</style>
