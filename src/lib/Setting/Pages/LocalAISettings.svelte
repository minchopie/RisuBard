<script lang="ts">
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import NumberInput from 'src/lib/UI/GUI/NumberInput.svelte'
    import { localAI } from 'src/ts/localAI.svelte'
    import { localAIRequest, refreshLocalAI } from 'src/ts/localAI'
    import { onDestroy } from 'svelte'

    let working = $state(false)
    let message = $state('')
    let context = $state(localAI.context)
    let output = $state(localAI.output)
    let controller = $state<AbortController>()
    let picker = $state<HTMLInputElement>()
    $effect(() => { context = localAI.context; output = localAI.output })

    async function configure(enabled: boolean, applyLimits = false) {
        working = true; message = ''
        try {
            // Switching modes must not apply an old or unsaved limits form.
            if (!applyLimits) await refreshLocalAI()
            const response = await localAIRequest('', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled, context: applyLimits ? context : localAI.context, output: applyLimits ? output : localAI.output }) })
            const result = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(result.error ?? `설정을 저장하지 못했어요 (${response.status}). 앱을 다시 열어 주세요.`)
            await refreshLocalAI()
            message = result.error || (enabled ? '기기 내 모델로 대화와 보조 AI 요청을 처리해요.' : '기존 온라인 모델 설정으로 돌아왔어요.')
        } catch (error) { message = error instanceof Error ? error.message : String(error) }
        finally { working = false }
    }
    async function importModel(event: Event) {
        const file = (event.currentTarget as HTMLInputElement).files?.[0]
        if (!file) return
        working = true; controller = new AbortController(); message = '모델을 앱에 복사하고 실행을 확인하고 있어요…'
        try {
            const response = await localAIRequest('/model', {
                method: 'POST', body: file, signal: controller.signal,
                headers: { 'Content-Type': 'application/octet-stream', 'x-model-size': String(file.size), 'x-model-name': encodeURIComponent(file.name) },
            })
            const result = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(result.error ?? `모델을 가져오지 못했어요 (${response.status}). 기존 모델은 보존돼요.`)
            message = result.error || (result.enabled ? '모델 준비 완료. 이제 인터넷 없이 대화할 수 있어요.' : '모델 준비 완료. 기기 내 AI 사용을 누르면 인터넷 없이 대화할 수 있어요.')
        } catch (error) {
            message = controller.signal.aborted ? '모델 선택을 취소했어요. 저장 상태를 다시 확인했어요.'
                : error instanceof TypeError ? '모델 가져오기 연결이 끊겼어요. 현재 모델 표시와 저장 공간을 확인한 뒤 다시 시도해 주세요.'
                : error instanceof Error ? error.message : String(error)
        }
        finally {
            await refreshLocalAI().catch(() => { message += ' 설정 확인 실패. 앱을 다시 열어 주세요.' })
            working = false; controller = undefined; if (picker) picker.value = ''
        }
    }
    onDestroy(() => controller?.abort())
</script>

{#if localAI.available}
    <section class="local-ai" aria-labelledby="local-ai-title">
        <h2 id="local-ai-title">기기 내 AI · 오프라인</h2>
        <p>태블릿·스마트폰에 저장한 GGUF 텍스트 모델로 실행해요. 처음 한 번 모델 파일을 준비해 주세요. 모델 크기와 문맥이 클수록 메모리·배터리를 더 사용해요.</p>
        <p>현재: {localAI.enabled ? '기기 내 AI 사용' : '기존 온라인 설정 사용'} · {localAI.model?.name ?? '모델 미선택'}</p>
        <p>토큰 수를 계산할 때도 모델을 불러와요. 첫 계산이나 오래 쉬었다가 보낼 때는 준비 시간이 걸릴 수 있어요.</p>
        <div class="controls">
            <ShButton disabled={working} onclick={() => configure(!localAI.enabled)}>{localAI.enabled ? '온라인 설정으로 전환' : '기기 내 AI 사용'}</ShButton>
            <ShButton disabled={working} onclick={() => picker?.click()}>GGUF 모델 파일 선택</ShButton>
            {#if controller}<ShButton onclick={() => controller?.abort()}>취소</ShButton>{/if}
        </div>
        <input bind:this={picker} type="file" accept=".gguf" onchange={importModel} hidden />
        {#if working && controller}<p>모델을 준비하는 동안 이 화면을 열어 두세요. 화면을 닫거나 취소를 누르면 가져오기를 중단해요.</p>{/if}
        <div class="limits">
            <label for="local-ai-context">문맥 토큰</label>
            <NumberInput id="local-ai-context" bind:value={context} min={128} max={32768} disabled={working} />
            <label for="local-ai-output">최대 응답 토큰</label>
            <NumberInput id="local-ai-output" bind:value={output} min={1} max={context - 1} disabled={working} />
            <ShButton disabled={working} onclick={() => configure(localAI.enabled, true)}>적용</ShButton>
        </div>
        <p>온라인 모델·API 키 설정은 보존돼요. 오프라인 실패 시 온라인 API로 자동 전환하지 않아요. 이미지 인식·웹 검색·NAS·GitHub 등은 인터넷 또는 별도 지원이 필요해요.</p>
        <p role="status" aria-live="polite">{message || localAI.error}</p>
    </section>
{/if}

<style>
    .local-ai { padding: 1rem; margin-bottom: 1rem; border: 1px solid var(--risu-theme-darkborderc); border-radius: .75rem; min-width: 0; }
    h2 { font-size: 1.1rem; font-weight: 650; }
    p { margin: .65rem 0; line-height: 1.6; overflow-wrap: anywhere; }
    .controls, .limits { display: flex; flex-wrap: wrap; gap: .65rem; align-items: center; margin: 1rem 0; }
</style>
