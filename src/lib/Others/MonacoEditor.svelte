<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import * as monaco from 'monaco-editor';
    import { DBState } from 'src/ts/stores.svelte';
    import { MONACO_APP_THEME, resolveMonacoTheme } from 'src/ts/gui/monacoTheme';
    import { registerLuaMonaco } from 'src/ts/gui/codearea/luaMonaco';
    import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
    import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
    import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
    import TypeScriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
    import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
    // Set up workers once globally
    if (!('MonacoEnvironment' in self)) {
        (self as any).MonacoEnvironment = {
            getWorker(_: string, label: string) {
                switch (label) {
                    case 'json':
                        return new JsonWorker();
                    case 'css':
                    case 'scss':
                    case 'less':
                        return new CssWorker();
                    case 'html':
                    case 'handlebars':
                    case 'razor':
                        return new HtmlWorker();
                    case 'typescript':
                    case 'javascript':
                        return new TypeScriptWorker();
                    default:
                        return new EditorWorker();
                }
            }
        };
    }

    registerLuaMonaco()

    interface Props {
        value: string;
        language?: string;
        theme?: string;
        readonly?: boolean;
        onchange?: (value: string) => void;
    }

    let {
        value = $bindable(''),
        language = 'markdown',
        theme,
        readonly = false,
        onchange,
    }: Props = $props();

    let container: HTMLDivElement;
    let editor = $state.raw<monaco.editor.IStandaloneCodeEditor>();

    onMount(() => {
        if (theme === undefined) {
            monaco.editor.defineTheme(MONACO_APP_THEME, resolveMonacoTheme(DBState.db.colorScheme));
        }
        const instance = monaco.editor.create(container, {
            value,
            language,
            theme: theme ?? MONACO_APP_THEME,
            readOnly: readonly,
            // Avoid Chrome EditContext modifier-state and global hotkey conflicts.
            editContext: false,
            automaticLayout: true,
            minimap: { enabled: false },
            wordWrap: 'on',
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            fontSize: 14,
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
            padding: { top: 8, bottom: 8 },
            renderLineHighlight: 'gutter',
            overviewRulerBorder: false,
            scrollbar: {
                verticalScrollbarSize: 6,
                horizontalScrollbarSize: 6,
            },
        });

        editor = instance;
        instance.onDidChangeModelContent(() => {
            const newValue = instance.getValue();
            value = newValue;
            onchange?.(newValue);
        });

        return () => {
            editor?.dispose();
        };
    });

    onDestroy(() => {
        editor?.dispose();
    });

    $effect(() => {
        if (theme !== undefined) {
            if (editor) monaco.editor.setTheme(theme);
            return;
        }
        // Reading every core/uiColors field inside the effect tracks in-place
        // option edits as well as replacing the whole active color scheme.
        const appTheme = resolveMonacoTheme(DBState.db.colorScheme);
        if (editor) {
            monaco.editor.defineTheme(MONACO_APP_THEME, appTheme);
            monaco.editor.setTheme(MONACO_APP_THEME);
        }
    });

    $effect(() => {
        if (editor && value !== editor.getValue()) {
            editor.setValue(value);
        }
    });
</script>

<div bind:this={container} class="w-full h-full"></div>
