import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const chatSource = readFileSync('src/lib/ChatScreens/Chat.svelte', 'utf8');
const koreanSource = readFileSync('src/lang/ko.ts', 'utf8');

describe('Arca-compatible chat copy connection', () => {
    it('connects a dedicated message action to the rendered-DOM exporter', () => {
        expect(chatSource).toContain("from 'src/ts/arcaExport'");
        expect(chatSource).toContain('button-icon-copy-arca');
        expect(chatSource).toContain('language.copyForArca');
        expect(chatSource).toContain('await exportArcaHtml(exportRoot, {');
        // The clipboard write must start before the slow export, or the click's user activation expires.
        expect(chatSource.indexOf('await window.navigator.clipboard.write([')).toBeLessThan(chatSource.indexOf('await payload'));
        expect(chatSource).toContain("'text/html': payload.then(");
        expect(chatSource).toContain('renderComplexBlock: renderArcaComplexBlock');
        expect(chatSource).toContain("new Blob([html], { type: 'text/html' })");
        expect(chatSource).toContain("new Blob([plainText], { type: 'text/plain' })");
    });

    it('reads the global saver layout settings for every chat action', () => {
        expect(chatSource).toContain('imageWidthPercent: DBState.db.risuBardArcaChatImageWidthPercent')
        expect(chatSource).toContain('paragraphSpacingPercent: DBState.db.risuBardArcaChatParagraphSpacingPercent')
        expect(chatSource).toContain('semanticPalette: $ColorSchemeTypeStore')
        expect(chatSource).toContain('fontSizePx: DBState.db.risuBardArcaChatFontSizePx')
        expect(chatSource).toContain('showTitleImage: DBState.db.risuBardArcaChatShowTitleImage')
        expect(chatSource).toContain('titleImageStyle: DBState.db.risuBardArcaChatTitleImageStyle')
        expect(koreanSource).toContain('copyForArca: "아카라이브 챗 저장기"')
    })
});
