export type AssetPath = {
    srcPaths: string[]
    ext?: string
}
export type AssetPaths = {[key: string]: AssetPath}

//Levenshtein distance, new with 1d array
export function getDistance(a:string, b:string) {
    const h = a.length + 1
    const w = b.length + 1
    let d = new Int16Array(h * w)
    for(let i=0;i<h;i++){
        d[i * w] = i
    }
    for(let i=0;i<w;i++){
        d[i] = i
    }
    for(let i=1; i<h; i++){
        for(let j=1;j<w;j++){
            d[i * w + j] = Math.min(
                d[(i-1) * w + j-1] + (a.charAt(i-1)===b.charAt(j-1) ? 0 : 1),
                d[(i-1) * w + j]+1, d[i * w + j-1]+1
            )
        }
    }
    return d[h * w - 1]
}

function trimmer(str:string){
    const ext = ['webp', 'png', 'jpg', 'jpeg', 'gif', 'mp4', 'webm', 'avi', 'm4p', 'm4v', 'mp3', 'wav', 'ogg']
    for(const e of ext){
        if(str.endsWith('.' + e)){
            str = str.substring(0, str.length - e.length - 1)
        }
    }

    return str.trim().replace(/[_ -.]/g, '')
}

/**
 * Nearest asset name for a missing one, searched over every loaded asset (character and module).
 * Names tied at the nearest distance (variants such as neutral_1 and neutral_2) are merged,
 * so the caller's per-message pick chooses among them. Returns null past maxDifference.
 */
export function findClosestAsset(name:string, assetPaths:AssetPaths, maxDifference:number): AssetPath | null {
    const trimmedName = trimmer(name)
    let closestDist = Infinity
    let ties: AssetPath[] = []
    for(const [key, asset] of Object.entries(assetPaths)){
        const dist = getDistance(trimmedName, trimmer(key))
        if(dist < closestDist){
            closestDist = dist
            ties = [asset]
        }
        else if(dist === closestDist){
            ties.push(asset)
        }
    }
    if(ties.length === 0 || closestDist > maxDifference){
        return null
    }
    // Same rule as exact-name groups: only files of the first match's extension share one entry.
    const ext = ties[0].ext
    const srcPaths = [...new Set(ties.filter((asset) => asset.ext === ext).flatMap((asset) => asset.srcPaths))]
    return { srcPaths, ext }
}
