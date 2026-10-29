<script lang="ts">
    import { BanIcon, BookIcon, DownloadIcon, FlagIcon, FolderIcon, FileIcon, ArrowLeftIcon, ImageIcon, LinkIcon, LoaderCircleIcon, PackageIcon, SmileIcon, TrashIcon } from '@lucide/svelte';
    import { onDestroy } from 'svelte';
    import { language } from 'src/lang';
    import { alertConfirm, alertInput, alertNormal, notifyInfo } from 'src/ts/alert';
    import { hubURL, type hubType, downloadRisuHub, getRealmInfo } from 'src/ts/characterCards';
    import { DBState } from 'src/ts/stores.svelte';
    import RealmLicense from './RealmLicense.svelte';
    import MultiLangDisplay from '../GUI/MultiLangDisplay.svelte';
    import ShButton from '../GUI/ShButton.svelte';
    import ShDialog from '../GUI/ShDialog.svelte';
    import { tooltip } from 'src/ts/gui/tooltip';
    import { downloadProtonModule, findSingleProtonLink, type ProtonModuleFolder } from 'src/ts/realm/protonModule';
    import { importRisum } from 'src/ts/process/modules';
    import { addBlockedRealmCreator } from 'src/ts/realmBlocking';

    interface Props {
        openedData: hubType;
    }

    let { openedData = $bindable() }: Props = $props();
    let isKorean = $derived(DBState.db.language === 'ko');
    let moduleLink = $derived(findSingleProtonLink(openedData.desc));
    let moduleStage = $state<'idle' | 'choosing' | 'checking' | 'downloading' | 'importing' | 'done' | 'unsupported' | 'password' | 'error'>('idle');
    let moduleBusy = $derived(['checking', 'downloading', 'importing'].includes(moduleStage));
    let characterBusy = $state(false);
    let busy = $derived(moduleBusy || characterBusy);
    let folder = $state<ProtonModuleFolder | null>(null);
    let folderTrail = $state<{ uid: string, name: string }[]>([]);
    let importedFiles = $state<string[]>([]);
    let lastRequest: { nodeUid?: string, parents: { uid: string, name: string }[] } = { parents: [] };
    let downloadedBytes = $state(0);
    let totalBytes = $state<number | undefined>();
    let moduleController: AbortController | undefined;
    onDestroy(() => moduleController?.abort());
    $effect(() => {
        openedData.id;
        moduleController?.abort();
        moduleController = undefined;
        moduleStage = 'idle';
        folder = null;
        folderTrail = [];
        importedFiles = [];
    });
    let ui = $derived(isKorean ? {
        madeBy: '제작자',
        viewOriginal: '원본 캐릭터 보기',
        emotions: '감정 이미지 포함',
        assets: '추가 에셋 포함',
        lorebook: '로어북 포함',
        download: '다운로드 후 채팅',
        importModule: '모듈 가져오기',
        checkingModule: '링크 확인 중…',
        downloadingModule: '모듈 다운로드 중…',
        importingModule: '모듈 임포트 중…',
        moduleDone: '모듈을 가져왔습니다. 모듈 설정에서 사용할 수 있습니다.',
        moduleUnsupported: '지원하지 않는 파일입니다. Proton Drive에서 열어주세요.',
        chooseModule: '가져올 모듈 파일을 선택하세요.',
        supportedModules: '.risum 파일을 가져올 수 있습니다. 폴더를 눌러 내부 파일을 확인하세요.',
        emptyFolder: '폴더가 비어 있습니다.',
        parentFolder: '상위 폴더',
        unsupportedFile: '지원하지 않는 형식',
        importedFile: '가져옴',
        modulePassword: '추가 비밀번호가 필요한 링크입니다. Proton Drive에서 열어주세요.',
        moduleError: '모듈을 가져오지 못했습니다. 다시 시도하거나 원본을 열어주세요.',
        openOriginal: '원본 열기',
        retry: '다시 시도',
        cancel: '취소',
        copyLink: 'RisuRealm 링크 복사',
        report: '캐릭터 신고',
        reportConfirm: '이 캐릭터를 신고할까요?',
        reportPrompt: '관리자에게 전달할 신고 내용을 입력하세요. 저작권 문제는 이메일을 이용해 주세요.',
        remove: '캐릭터 삭제',
        removeConfirm: '이 캐릭터를 RisuRealm에서 삭제할까요?',
    } : {
        madeBy: 'Made by',
        viewOriginal: 'View original character',
        emotions: 'Emotion images',
        assets: 'Additional assets',
        lorebook: 'Lorebook',
        download: 'Download & Chat',
        importModule: 'Import module',
        checkingModule: 'Checking link…',
        downloadingModule: 'Downloading module…',
        importingModule: 'Importing module…',
        moduleDone: 'Module imported. You can use it in module settings.',
        moduleUnsupported: 'This file is not supported. Open it in Proton Drive.',
        chooseModule: 'Choose a module file to import.',
        supportedModules: 'You can import .risum files. Open a folder to browse its files.',
        emptyFolder: 'This folder is empty.',
        parentFolder: 'Parent folder',
        unsupportedFile: 'Unsupported format',
        importedFile: 'Imported',
        modulePassword: 'This link requires an additional password. Open it in Proton Drive.',
        moduleError: 'Could not import the module. Try again or open the original.',
        openOriginal: 'Open original',
        retry: 'Try again',
        cancel: 'Cancel',
        copyLink: 'Copy RisuRealm link',
        report: 'Report character',
        reportConfirm: 'Report this character?',
        reportPrompt: 'Write a report text that would be sent to the admin (for copyright issues, use email)',
        remove: 'Remove character',
        removeConfirm: 'Do you want to remove this character from Realm?',
    });

    function close() {
        if (busy) return;
        openedData = null;
    }

    async function blockCreator() {
        const creatorId = openedData.creator;
        if (!creatorId || busy) return;
        const creatorName = openedData.authorname ?? openedData.creatorName ?? creatorId;
        const conf = await alertConfirm(language.blockRealmCreatorConfirm.replace('{{creator}}', creatorName));
        if (!conf) return;
        DBState.db.blockedRealmCreators = addBlockedRealmCreator(
            DBState.db.blockedRealmCreators ?? [],
            { id: creatorId, name: creatorName },
        );
        openedData = null;
        alertNormal(language.realmCreatorBlockedSuccess);
    }

    async function getCharacter() {
        if (busy) return;
        characterBusy = true;
        try { await downloadRisuHub(openedData.id, { creator: openedData.creator }); }
        finally { characterBusy = false; }
    }

    async function getModule(nodeUid?: string, parents: typeof folderTrail = []) {
        if (!moduleLink || busy) return;
        lastRequest = { nodeUid, parents };
        const controller = new AbortController();
        moduleController = controller;
        moduleStage = 'checking';
        downloadedBytes = 0;
        totalBytes = undefined;
        try {
            const result = await downloadProtonModule(moduleLink, {
                nodeUid,
                signal: controller.signal,
                onProgress: (downloaded, total) => {
                    if (moduleController !== controller) return;
                    moduleStage = 'downloading';
                    downloadedBytes = downloaded;
                    totalBytes = total;
                },
            });
            if (moduleController !== controller) return;
            controller.signal.throwIfAborted();
            if (result.kind === 'folder') {
                folder = result;
                folderTrail = [...parents, { uid: result.uid, name: result.name }];
                moduleStage = 'choosing';
                return;
            }
            if (result.kind === 'external') {
                moduleStage = result.reason;
                return;
            }
            moduleStage = 'importing';
            if (await importRisum(result.data) === false) {
                moduleStage = folder ? 'choosing' : 'idle';
                return;
            }
            moduleStage = 'done';
            if (nodeUid) importedFiles = [...importedFiles, nodeUid];
        } catch {
            if (moduleController === controller) moduleStage = controller.signal.aborted ? (folder ? 'choosing' : 'idle') : 'error';
        } finally {
            if (moduleController === controller) moduleController = undefined;
        }
    }
</script>

<ShDialog
    open={true}
    onOpenChange={(open) => { if (!open) close(); }}
    size="lg"
    tier="base"
    closable={!busy}
    closeOnEscape={!busy}
    closeOnOutsideClick={!busy}
    contentClass="max-h-[calc(100dvh-1rem)] gap-0 rounded-2xl p-0 overflow-hidden"
    bodyClass="min-h-0 min-w-0 flex-1 overflow-y-auto"
    closeClass="right-5 top-5 z-10 rounded-full border border-darkborderc bg-darkbg/90 p-1.5"
>
    {#snippet title()}
        <span class="sr-only">{openedData.name}</span>
    {/snippet}

    <div class="grid min-w-0 gap-0 md:grid-cols-[15rem_minmax(0,1fr)]">
        <div class="relative min-h-56 overflow-hidden border-b border-darkborderc bg-bgcolor md:min-h-[26rem] md:border-b-0 md:border-r">
            {#if DBState.db.hideAllImages}
                <div class="flex size-full min-h-56 items-center justify-center text-5xl text-textcolor2">?</div>
            {:else}
                <img class="absolute inset-0 size-full object-cover object-top" alt={openedData.name} src={`${hubURL}/resource/` + openedData.img} />
                <div class="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-media-bg/55 to-transparent"></div>
            {/if}
            <div class="absolute bottom-3 left-3 flex flex-wrap gap-1.5 pr-3">
                {#each openedData.tags.slice(0, 4) as tag}
                    <span class="rounded-full border border-media-text/15 bg-media-bg/55 px-2 py-1 text-xs text-media-text backdrop-blur-sm">#{tag}</span>
                {/each}
            </div>
        </div>

        <div class="flex min-w-0 flex-col p-5 sm:p-6">
            <div class="pr-10">
                <h1 class="wrap-break-word text-2xl font-semibold tracking-tight text-textcolor">{openedData.name}</h1>
                {#if openedData.authorname}
                    <p class="mt-1 text-sm text-borderc">{ui.madeBy} {openedData.authorname}</p>
                {/if}
                {#if openedData.original}
                    <button class="mt-2 text-sm text-borderc hover:underline" onclick={() => {
                        const original = openedData.original;
                        close();
                        void getRealmInfo(original);
                    }}>{ui.viewOriginal}</button>
                {/if}
            </div>

            <div class="mt-5 max-h-none min-w-0 overflow-visible rounded-xl border border-darkborderc bg-bgcolor/30 p-3 text-sm leading-relaxed selection:bg-primary/35 md:max-h-64 md:overflow-y-auto">
                <MultiLangDisplay value={openedData.desc} markdown={true} linkify={true} />
            </div>

            <div class="mt-4 flex flex-wrap items-center gap-2 text-sm text-textcolor2">
                <span use:tooltip={language.popularityLevelDesc}>
                    {language.popularityLevel.replace('{}', openedData.download.toString())}
                </span>
                {#if openedData.hasEmotion}<span class="rounded-md border border-darkborderc p-1.5" title={ui.emotions}><SmileIcon size={16} /></span>{/if}
                {#if openedData.hasAsset}<span class="rounded-md border border-darkborderc p-1.5" title={ui.assets}><ImageIcon size={16} /></span>{/if}
                {#if openedData.hasLore}<span class="rounded-md border border-darkborderc p-1.5" title={ui.lorebook}><BookIcon size={16} /></span>{/if}
            </div>

            <div class="mt-3"><RealmLicense license={openedData.license} /></div>

            <div class="mt-auto flex flex-wrap items-center gap-2 border-t border-darkborderc pt-4">
                <ShButton variant="primary" className="grow" disabled={busy} onclick={getCharacter}><DownloadIcon size={17} /> {ui.download}</ShButton>

                {#if moduleLink}
                    <ShButton variant="outline" className="grow" disabled={busy || (moduleStage === 'done' && !folder)} onclick={() => moduleStage === 'error' ? getModule(lastRequest.nodeUid, lastRequest.parents) : getModule()}>
                        {#if moduleBusy}<LoaderCircleIcon size={17} class="animate-spin" />{:else}<PackageIcon size={17} />{/if}
                        {moduleStage === 'checking' ? ui.checkingModule : moduleStage === 'downloading' ? ui.downloadingModule : moduleStage === 'importing' ? ui.importingModule : moduleStage === 'error' ? ui.retry : ui.importModule}
                    </ShButton>
                {/if}

                <ShButton variant="ghost" size="icon" aria-label={ui.copyLink} onclick={async () => {
                    await navigator.clipboard.writeText(`https://realm.risuai.net/character/${openedData.id}`);
                    notifyInfo(language.clipboardSuccess);
                }}><LinkIcon size={18} /></ShButton>

                <ShButton variant="ghost" size="icon" aria-label={ui.report} onclick={async () => {
                    const conf = await alertConfirm(ui.reportConfirm);
                    if (!conf) return;
                    const report = await alertInput(ui.reportPrompt);
                    const response = await fetch(hubURL + '/hub/report', {
                        method: 'POST',
                        body: JSON.stringify({ id: openedData.id, report }),
                    });
                    alertNormal(await response.text());
                }}><FlagIcon size={18} /></ShButton>

                {#if openedData.creator && (DBState.db.account?.token?.split('-') ?? [])[1] !== openedData.creator}
                    <ShButton variant="ghost" size="icon" aria-label={language.blockRealmCreator} className="text-danger" disabled={busy} onclick={blockCreator}><BanIcon size={18} /></ShButton>
                {/if}

                {#if (DBState.db.account?.token?.split('-') ?? [])[1] === openedData.creator}
                    <ShButton variant="ghost" size="icon" aria-label={ui.remove} className="text-danger" onclick={async () => {
                        const conf = await alertConfirm(ui.removeConfirm);
                        if (!conf) return;
                        const response = await fetch(hubURL + '/hub/remove', {
                            method: 'POST',
                            body: JSON.stringify({ id: openedData.id, token: DBState.db.account?.token }),
                        });
                        alertNormal(await response.text());
                    }}><TrashIcon size={18} /></ShButton>
                {/if}
            </div>
            {#if moduleLink && moduleStage !== 'idle'}
                <div class="mt-3 space-y-2 text-sm text-textcolor2">
                    <p role="status" aria-live="polite">
                        {#if moduleStage === 'downloading'}
                            {(downloadedBytes / 1048576).toFixed(1)} MiB{totalBytes ? ` / ${(totalBytes / 1048576).toFixed(1)} MiB` : ''}
                        {:else if moduleStage === 'done'}{ui.moduleDone}
                        {:else if moduleStage === 'unsupported'}{ui.moduleUnsupported}
                        {:else if moduleStage === 'password'}{ui.modulePassword}
                        {:else if moduleStage === 'error'}{ui.moduleError}
                        {:else if moduleStage === 'importing'}{ui.importingModule}
                        {:else if moduleStage === 'choosing'}{ui.chooseModule}
                        {:else}{ui.checkingModule}{/if}
                    </p>
                    {#if moduleStage === 'downloading' && totalBytes && totalBytes > 0}
                        <progress class="h-2 w-full accent-primary" aria-label={ui.downloadingModule} max={totalBytes} value={downloadedBytes}></progress>
                    {/if}
                    {#if moduleStage === 'checking' || moduleStage === 'downloading'}
                        <ShButton variant="outline" size="sm" onclick={() => moduleController?.abort()}>{ui.cancel}</ShButton>
                    {:else if ['unsupported', 'password', 'error'].includes(moduleStage)}
                        <ShButton variant="outline" size="sm" href={moduleLink} target="_blank" rel="noopener noreferrer">{ui.openOriginal}</ShButton>
                    {/if}
                </div>
            {/if}
            {#if folder}
                <div class="mt-3 min-w-0 space-y-2" aria-label={ui.chooseModule}>
                    <div class="flex min-w-0 items-center gap-2">
                        {#if folderTrail.length > 1}
                            <ShButton variant="outline" size="sm" disabled={busy} onclick={() => getModule(folderTrail[folderTrail.length - 2].uid, folderTrail.slice(0, -2))}><ArrowLeftIcon size={16} />{ui.parentFolder}</ShButton>
                        {/if}
                        <p class="min-w-0 break-words text-sm text-textcolor">{folderTrail.map(entry => entry.name).join(' / ')}</p>
                    </div>
                    <p class="text-xs text-textcolor2">{ui.supportedModules}</p>
                    <ul class="max-h-60 overflow-y-auto rounded-lg border border-darkborderc divide-y divide-darkborderc">
                        {#each folder.entries as entry (entry.uid)}
                            <li>
                                <button type="button" data-module-entry={entry.uid}
                                    class="flex w-full min-w-0 items-center gap-2 px-3 py-2.5 text-left text-sm text-textcolor hover:bg-selected focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-default disabled:opacity-60"
                                    disabled={busy || !entry.supported || importedFiles.includes(entry.uid)}
                                    onclick={() => getModule(entry.uid, folderTrail)}>
                                    {#if entry.type === 'folder'}<FolderIcon size={18} class="shrink-0" />{:else}<FileIcon size={18} class="shrink-0" />{/if}
                                    <span class="min-w-0 flex-1 break-all">{entry.name}</span>
                                    {#if !entry.supported}<span class="shrink-0 text-xs">{ui.unsupportedFile}</span>
                                    {:else if importedFiles.includes(entry.uid)}<span class="shrink-0 text-xs">{ui.importedFile}</span>{/if}
                                </button>
                            </li>
                        {:else}
                            <li class="p-3 text-sm text-textcolor2">{ui.emptyFolder}</li>
                        {/each}
                    </ul>
                    <ShButton variant="outline" size="sm" href={moduleLink} target="_blank" rel="noopener noreferrer">{ui.openOriginal}</ShButton>
                </div>
            {/if}
        </div>
    </div>
</ShDialog>
