import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const componentPath = resolve(process.cwd(), 'src/lib/Setting/Pages/DeveloperSettings.svelte')

describe('developer settings page', () => {
    it('only offers the asset storage transition', () => {
        expect(existsSync(componentPath)).toBe(true)
        const source = readFileSync(componentPath, 'utf8')
        expect(source).toContain('<SettingPage')
        expect(source).toContain('<AssetStoreTransition />')
        expect(source).not.toContain('CharacterAssetTransition')
        expect(source).not.toContain('ModuleAssetTransition')
        expect(source).not.toContain('/api/storage-diagnostics/report')
    })
})
