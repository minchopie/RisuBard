import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const helperPath = fileURLToPath(
    new URL('./release-update.cjs', import.meta.url)
)

describe('GitHub release update information', () => {
    test('reports a newer tagged release as an optional update', () => {
        expect(existsSync(helperPath)).toBe(true)
        if (!existsSync(helperPath)) return

        const { releaseToUpdateInfo } = require(helperPath)
        const info = releaseToUpdateInfo(
            {
                tag_name: 'v0.1.1',
                name: 'RisuBard 0.1.1',
                html_url: 'https://github.com/minchopie/RisuBard/releases/tag/v0.1.1',
                published_at: '2026-08-19T00:00:00Z',
            },
            '0.1.0'
        )

        expect(info).toEqual({
            currentVersion: '0.1.0',
            latestVersion: '0.1.1',
            hasUpdate: true,
            severity: 'optional',
            releaseUrl: 'https://github.com/minchopie/RisuBard/releases/tag/v0.1.1',
            releaseName: 'RisuBard 0.1.1',
            publishedAt: '2026-08-19T00:00:00Z',
            manualOnly: false,
        })
    })

    test('does not report the same or an older release as an update', () => {
        expect(existsSync(helperPath)).toBe(true)
        if (!existsSync(helperPath)) return

        const { releaseToUpdateInfo } = require(helperPath)

        expect(
            releaseToUpdateInfo({ tag_name: 'v0.1.0' }, '0.1.0').hasUpdate
        ).toBe(false)
        expect(
            releaseToUpdateInfo({ tag_name: 'v0.0.9' }, '0.1.0').hasUpdate
        ).toBe(false)
    })
})
