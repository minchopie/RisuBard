import { NodeStorage, type PatchItemResult, type ExportBackupOptions, type BackupImportPhase } from "./nodeStorage"

export class AutoStorage{
    get importProgressId() { return this.realStorage?.importProgressId }
    async observeImportProgress(id: string, onEvent: (event: import('../importProgress').ServerImportEvent) => void, onLost: () => void) {
        await this.Init()
        return this.realStorage.observeImportProgress(id, onEvent, onLost)
    }
    isAccount:boolean = false

    realStorage:NodeStorage

    async setItem(key:string, value:Uint8Array, etag?:string):Promise<string|null> {
        await this.realStorage.setItem(key, value, etag)
        return null
    }
    async setItemConditional(key: string, value: Uint8Array, etag: string): Promise<string | null> {
        await this.Init()
        return await this.realStorage.setItemConditional(key, value, etag)
    }
    async getItem(key:string):Promise<Buffer> {
        return await this.realStorage.getItem(key)
    }
    async getCacheItems(keys: readonly string[]): Promise<(Buffer | null)[]> {
        await this.Init()
        return await this.realStorage.getCacheItems(keys)
    }
    async setCacheItems(entries: readonly { key: string; value: Uint8Array }[]): Promise<void> {
        await this.Init()
        return await this.realStorage.setCacheItems(entries)
    }
    async getItemWithEtag(key:string) {
        await this.Init()
        return await this.realStorage.getItemWithEtag(key)
    }
    async keys(prefix: string = ''):Promise<string[]>{
        await this.Init()
        return await this.realStorage.keys(prefix)
    }
    async removeItem(key:string, etag?: string){
        return await this.realStorage.removeItem(key, etag)
    }

    async checkAccountSync(){
        return false
    }

    async Init(){
        if(!this.realStorage){
            console.log("using node storage")
            this.realStorage = new NodeStorage()
        }
    }

    async createAuth(): Promise<string> {
        if (!this.realStorage) {
            this.realStorage = new NodeStorage()
        }
        return this.realStorage.createAuth()
    }

    async flushDatabase(keepalive = false, canonicalOnly = false, signal?: AbortSignal): Promise<void> {
        await this.Init()
        await this.realStorage.flushDatabase(keepalive, canonicalOnly, signal)
    }

    async exportBackup(opts?: ExportBackupOptions) {
        await this.Init()
        return this.realStorage.exportBackup(opts)
    }

    async settingsBackupEstimate() {
        await this.Init()
        return this.realStorage.settingsBackupEstimate()
    }

    async importBackup(file: Blob, onProgress?: (loaded: number, total: number, phase?: BackupImportPhase) => void) {
        await this.Init()
        return this.realStorage.importBackup(file, onProgress)
    }

    async patchItem(key: string, patchData: { patch: any[], expectedHash: string }): Promise<PatchItemResult> {
        return await this.realStorage.patchItem(key, patchData)
    }

    /** Writer-lock state for the reload-on-return check (see NodeStorage). */
    async getWriterLockState() {
        await this.Init()
        return this.realStorage.getWriterLockState()
    }

    async syncLiveFiles(revision?: string) {
        await this.Init()
        return this.realStorage.syncLiveFiles(revision)
    }

    takeLiveFilesRecoveryPath() {
        const recoveryPath = this.realStorage?.liveFilesRecoveryPath ?? null
        if (this.realStorage) this.realStorage.liveFilesRecoveryPath = null
        return recoveryPath
    }

    async getExternalChanges() {
        await this.Init()
        return this.realStorage.getExternalChanges()
    }

    async scanCharacterAssets(characterId: string) {
        await this.Init()
        return this.realStorage.scanCharacterAssets(characterId)
    }

    async resolveExternalChanges(decision: 'accept' | 'keep', revision: string) {
        await this.Init()
        return this.realStorage.resolveExternalChanges(decision, revision)
    }

    async getLiveFileMonitoring(force = false) {
        await this.Init()
        return this.realStorage.getLiveFileMonitoring(force)
    }

    async setLiveFileMonitoring(enabled: boolean) {
        await this.Init()
        return this.realStorage.setLiveFileMonitoring(enabled)
    }

    async subscribeLiveFileChanges(onChange: () => void) {
        await this.Init()
        return this.realStorage.subscribeLiveFileChanges(onChange)
    }

    async getExternalEditModeStatus() {
        await this.Init()
        return this.realStorage.getExternalEditModeStatus()
    }

    async startExternalEditMode() {
        await this.Init()
        return this.realStorage.startExternalEditMode()
    }

    async finishExternalEditMode() {
        await this.Init()
        return this.realStorage.finishExternalEditMode()
    }

    /** Get the last known ETag for database.bin */
    getDbEtag(): string | null {
        return this.realStorage._lastDbEtag
    }

    /** Update cached ETag for database.bin */
    setDbEtag(etag: string | null) {
        this.realStorage.setDbEtag(etag)
    }

    listItem = this.keys

    // ── Bulk asset operations ──────────────────────────────────────────────────
    async getItems(keys: string[]) { return this.realStorage.getItems(keys) }
    async setItems(entries: {key: string, value: Uint8Array}[]) { return this.realStorage.setItems(entries) }
    async cleanupImportAssets(keys: string[], id: string, retainAssets = false) { await this.Init(); return this.realStorage.cleanupImportAssets(keys, id, retainAssets) }
    async prepareImportRollback(id: string) { await this.Init(); return this.realStorage.prepareImportRollback(id) }

    // ── Server-side backup ─────────────────────────────────────────────────────
    async saveServerBackup(onProgress?: (current: number, total: number, bytes: number, totalBytes: number) => void) { await this.Init(); return this.realStorage.saveServerBackup(onProgress) }
    async listServerBackups() { await this.Init(); return this.realStorage.listServerBackups() }
    async restoreServerBackup(filename: string, onProgress?: (bytes: number, totalBytes: number, phase?: BackupImportPhase) => void) { await this.Init(); return this.realStorage.restoreServerBackup(filename, onProgress) }
    async deleteServerBackup(filename: string) { await this.Init(); return this.realStorage.deleteServerBackup(filename) }
    async downloadServerBackup(filename: string) { await this.Init(); return this.realStorage.downloadServerBackup(filename) }

    // ── RisuAI account import ─────────────────────────────────────────────────
    async getRisuAccountImportConfig() { await this.Init(); return this.realStorage.getRisuAccountImportConfig() }
    async getRisuAccountImportStatus() { await this.Init(); return this.realStorage.getRisuAccountImportStatus() }
    async prepareRisuAccountImport(token: string, id: string) { await this.Init(); return this.realStorage.prepareRisuAccountImport(token, id) }
    async startRisuAccountDownload() { await this.Init(); return this.realStorage.startRisuAccountDownload() }
    async cancelRisuAccountImport() { await this.Init(); return this.realStorage.cancelRisuAccountImport() }
    async applyRisuAccountImport() { await this.Init(); return this.realStorage.applyRisuAccountImport() }

    // ── Save-folder migration ─────────────────────────────────────────────────
    async scanSaveFolder(folderPath?: string) { await this.Init(); return this.realStorage.scanSaveFolder(folderPath) }
    async executeSaveFolderImport(folderPath?: string) { await this.Init(); return this.realStorage.executeSaveFolderImport(folderPath) }
    async uploadSaveFolderZip(file: Blob, onProgress?: (loaded: number, total: number) => void) { await this.Init(); return this.realStorage.uploadSaveFolderZip(file, onProgress) }
    async scanCleanup() { await this.Init(); return this.realStorage.scanCleanup() }
    async executeCleanup() { await this.Init(); return this.realStorage.executeCleanup() }
}
