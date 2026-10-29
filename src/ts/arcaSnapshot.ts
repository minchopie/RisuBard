import { planArcaComplexSnapshots, shouldIncludeArcaRasterNode } from './arcaExport';

function normalizeFontFamily(family: string): string {
    return family.trim().replace(/["']/g, '');
}

function collectUsedFontFamilies(element: HTMLElement): Set<string> {
    const families = new Set<string>();
    for (const node of [element, ...Array.from(element.querySelectorAll<HTMLElement>('*'))]) {
        for (const family of getComputedStyle(node).fontFamily.split(',')) {
            families.add(normalizeFontFamily(family));
        }
    }
    return families;
}

// html-to-image only embeds @font-face rules that load a url(). Bot fonts such as
// `src: local("Impact")` are dropped, so they are copied here as-is; local() still
// resolves inside the rendered SVG image.
export function collectLocalFontFaceCSS(
    element: HTMLElement,
    styleSheets: Iterable<CSSStyleSheet> = Array.from(element.ownerDocument.styleSheets),
): string {
    const usedFamilies = collectUsedFontFamilies(element);
    const rules: string[] = [];
    for (const sheet of styleSheets) {
        let sheetRules: CSSRuleList;
        try {
            sheetRules = sheet.cssRules;
        }
        catch {
            continue;
        }
        for (const rule of Array.from(sheetRules)) {
            if (!(rule instanceof CSSFontFaceRule)) continue;
            const source = rule.style.getPropertyValue('src');
            if (!source || /url\s*\(/i.test(source)) continue;
            if (usedFamilies.has(normalizeFontFamily(rule.style.getPropertyValue('font-family')))) {
                rules.push(rule.cssText);
            }
        }
    }
    return rules.join('\n');
}

// Off-screen `loading="lazy"` images (bot sprites, every message staged by the chat log)
// have not loaded yet, so their computed size is 0 and html-to-image copies that size
// into the snapshot. Load them first so the sprite keeps its real size.
export async function loadLazyImages(element: HTMLElement): Promise<void> {
    const images = element instanceof HTMLImageElement
        ? [element]
        : Array.from(element.querySelectorAll('img'));
    await Promise.all(images.map(async (image) => {
        if (image.loading === 'lazy') image.loading = 'eager';
        if (!image.complete) {
            await new Promise<void>((resolve) => {
                image.addEventListener('load', () => resolve(), { once: true });
                image.addEventListener('error', () => resolve(), { once: true });
            });
        }
        await image.decode?.().catch(() => undefined);
    }));
}

export const ARCA_SNAPSHOT_PIXEL_RATIO = 2;
export const ARCA_SNAPSHOT_WEBP_QUALITY = 0.85;

// WebP keeps the alpha channel a sprite needs where it sticks out of its background.
// Browsers without a WebP encoder return PNG from toDataURL, which is used as is.
export function encodeArcaSnapshot(canvas: HTMLCanvasElement): string {
    return canvas.toDataURL('image/webp', ARCA_SNAPSHOT_WEBP_QUALITY);
}

// Arca's sanitizer strips flex, grid and position, so layout-dependent blocks
// are rasterized from the rendered DOM instead of being rebuilt as HTML.
export async function renderArcaComplexBlock(element: HTMLElement): Promise<readonly string[]> {
    const { getFontEmbedCSS, toCanvas } = await import('html-to-image');
    await loadLazyImages(element);
    const snapshotPlan = planArcaComplexSnapshots(element);
    // Without the block's own @font-face rules the snapshot falls back to wider fonts,
    // so fixed-width labels clip or wrap. Only families the block uses are embedded.
    let fontEmbedCSS: string | undefined;
    try {
        const embedded = await getFontEmbedCSS(element, { cacheBust: false });
        fontEmbedCSS = [embedded, collectLocalFontFaceCSS(element)].filter(Boolean).join('\n');
    }
    catch (cause) {
        console.warn('Arca snapshot fonts skipped:', cause);
    }
    // Arca shows pasted images at the column width, so a 1x snapshot from a 100% scale
    // monitor looks blurry. A fixed 2x WebP keeps detail and transparency at a modest size.
    const pixelRatio = ARCA_SNAPSHOT_PIXEL_RATIO;
    const images: string[] = [];
    const failures: unknown[] = [];

    for (const target of snapshotPlan) {
        const rect = target.element.getBoundingClientRect();
        try {
            const canvas = await toCanvas(target.element, {
                cacheBust: false,
                pixelRatio,
                ...(fontEmbedCSS === undefined ? { skipFonts: true } : { fontEmbedCSS }),
                width: target.kind === 'panel' ? Math.min(760, Math.max(220, rect.width)) : undefined,
                filter: node => shouldIncludeArcaRasterNode(node, target.excludeElements),
                // The clone keeps computed margins such as `margin: 0 auto` resolved to
                // pixels, which would shift the content inside a canvas sized to the border box.
                style: target.kind === 'panel' ? {
                    margin: '0',
                    position: 'relative',
                    inset: 'auto',
                    top: 'auto',
                    right: 'auto',
                    bottom: 'auto',
                    left: 'auto',
                    transform: 'none',
                    opacity: '1',
                    visibility: 'visible',
                    pointerEvents: 'auto',
                } : { margin: '0' },
            });
            images.push(encodeArcaSnapshot(canvas));
        }
        catch (cause) {
            failures.push(cause);
        }
    }
    if (images.length === 0 && failures.length > 0) throw failures[0];
    return images;
}
