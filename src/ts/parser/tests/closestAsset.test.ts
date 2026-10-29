import { expect, test } from 'vitest'
import { findClosestAsset, type AssetPaths } from '../closestAsset'

const paths = (): AssetPaths => ({
    'bg_room': { srcPaths: ['char/bg_room.png'], ext: 'png' },
    'yaoyorozu_momo.uniform.neutral_1': { srcPaths: ['module/momo_n1.webp'], ext: 'webp' },
    'yaoyorozu_momo.uniform.neutral_2': { srcPaths: ['module/momo_n2.webp'], ext: 'webp' },
    'yaoyorozu_momo.uniform.smile_1': { srcPaths: ['module/momo_s1.webp'], ext: 'webp' },
})

test('module assets are searched and tied variants are merged', () => {
    expect(findClosestAsset('yaoyorozu_momo.uniform.neutral', paths(), 4)).toEqual({
        srcPaths: ['module/momo_n1.webp', 'module/momo_n2.webp'],
        ext: 'webp',
    })
})

test('a single nearest asset is returned alone', () => {
    expect(findClosestAsset('yaoyorozu_momo.uniform.smile', paths(), 4)).toEqual({
        srcPaths: ['module/momo_s1.webp'],
        ext: 'webp',
    })
})

test('nothing within the allowed difference returns null', () => {
    expect(findClosestAsset('uraraka_ochako.uniform.neutral', paths(), 4)).toBeNull()
    expect(findClosestAsset('anything', {}, 4)).toBeNull()
})

test('tied names with another extension are left out', () => {
    const p = paths()
    p['yaoyorozu_momo.uniform.neutral_3'] = { srcPaths: ['module/momo_n3.png'], ext: 'png' }
    expect(findClosestAsset('yaoyorozu_momo.uniform.neutral', p, 4)?.srcPaths).toEqual(['module/momo_n1.webp', 'module/momo_n2.webp'])
})
