/** The app's existing in-place ordering rule, shared with sync completion verification. */
export function checkCharacterOrder(db: {
    characterOrder?: (string | { data: string[] })[]
    characters: { chaId: string; trashTime?: number }[]
}) {
    db.characterOrder = db.characterOrder ?? []
    let ordered = []
    for (let i = 0; i < db.characterOrder.length; i++) {
        const folder = db.characterOrder[i]
        if (typeof (folder) !== 'string' && folder) {
            for (const f of folder.data) {
                ordered.push(f)
            }
        }
        if (typeof (folder) === 'string') {
            ordered.push(folder)
        }
    }

    let charIdList: string[] = []

    for (let i = 0; i < db.characters.length; i++) {
        const char = db.characters[i]
        const charId = char.chaId
        if (!char.trashTime) {
            charIdList.push(charId)
        }
        if (!ordered.includes(charId)) {
            if (charId !== '§temp' && charId !== '§playground' && !char.trashTime) {
                db.characterOrder.push(charId)
            }
        }
    }


    for (let i = 0; i < db.characterOrder.length; i++) {
        const data = db.characterOrder[i]
        if (typeof (data) !== 'string') {
            if (!data) {
                db.characterOrder.splice(i, 1)
                i--;
                continue
            }
            for (let i2 = 0; i2 < data.data.length; i2++) {
                const data2 = data.data[i2]
                if (!charIdList.includes(data2)) {
                    data.data.splice(i2, 1)
                    i2--;
                }
            }
            db.characterOrder[i] = data
        }
        else {
            if (!charIdList.includes(data)) {
                db.characterOrder.splice(i, 1)
                i--;
            }
        }
    }


}
