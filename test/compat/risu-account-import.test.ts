/**
 * RisuAI account import against a fake risuai.xyz account server: the
 * download runs in the real server process, the apply goes through the
 * regular backup import, and the result is read back through the API.
 * While the import is started every data write is refused.
 */
import { afterAll, describe, expect, test } from 'vitest'
import { access, cp } from 'node:fs/promises'
import path from 'node:path'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { decodeBackup } from './helpers/decode.js'
import { decodeRisuDat } from './helpers/normalize.js'
import { assetFor, createFakeAccount, startFakeAccountServer, type FakeAccount, type FakeAccountServer } from './helpers/fakeRisuAccount.js'

const cleanups: Array<() => Promise<void>> = []
afterAll(async () => {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()))
})

async function setup(account: FakeAccount) {
  const fake: FakeAccountServer = await startFakeAccountServer(account)
  cleanups.push(fake.close)
  const srv: ServerHandle = await spawnServer({
    env: { RISUBARD_RISU_ACCOUNT_URL: fake.url, RISUBARD_RISU_ACCOUNT_GAP_MS: '0' },
  })
  cleanups.push(srv.cleanup)
  const client = await createClient(srv.port, srv.password)
  return { fake, srv, client }
}

async function post(client: RisuClient, urlPath: string, body?: unknown) {
  const res = await client.fetch(urlPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, body: await res.json() as any }
}

async function waitWhile(client: RisuClient, ...states: string[]) {
  // Generous: the compat suite runs many server processes side by side.
  for (let i = 0; i < 2400; i++) {
    const status = await (await client.fetch('/api/risu-account/status')).json() as any
    if (!states.includes(status.state)) return status
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`still ${states.join(' or ')}`)
}

const waitForDownload = (client: RisuClient) => waitWhile(client, 'downloading')

async function prepare(client: RisuClient, token: string, id: string) {
  const res = await post(client, '/api/risu-account/prepare', { token, id })
  expect(res.status).toBe(200)
  return waitWhile(client, 'preparing')
}

async function apply(client: RisuClient) {
  expect((await post(client, '/api/risu-account/apply')).status).toBe(200)
  return waitWhile(client, 'applying')
}

// A data write from a page of this session.
function writeSetting(client: RisuClient, sessionId: string) {
  return client.fetch('/api/write', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'file-path': Buffer.from('test/account-import.txt').toString('hex'), 'x-session-id': sessionId },
    body: new Uint8Array(Buffer.from('x')),
  })
}

describe('RisuAI account import', { timeout: 180_000 }, () => {
  test('imports characters, cold storage, plugin storage and images from the account', async () => {
    const account = createFakeAccount()
    const { fake, srv, client } = await setup(account)

    const config = await (await client.fetch('/api/risu-account/config')).json() as any
    expect(config).toEqual({ loginUrl: `${fake.url}/hub/login`, loginOrigin: fake.url })

    const prepared = await prepare(client, account.token, account.id)
    expect(prepared).toMatchObject({ state: 'ready', summary: { accountId: 'fake-user', characters: 3, assets: 5, cold: 3 } })

    expect((await writeSetting(client, 'page-before')).status).toBe(200)
    expect((await post(client, '/api/risu-account/download')).status).toBe(200)
    const downloaded = await waitForDownload(client)
    expect(downloaded).toMatchObject({ state: 'downloaded', blocking: true, missingCount: 1 })

    // Started: nothing writes until the import ends, and open pages reload.
    const refused = await writeSetting(client, 'page-before')
    expect(refused.status).toBe(423)
    expect(await refused.json()).toMatchObject({ code: 'ACCOUNT_IMPORT_ACTIVE' })
    const removal = await client.fetch('/api/remove', { headers: { 'file-path': Buffer.from('test/account-import.txt').toString('hex'), 'x-session-id': 'page-before' } })
    expect(removal.status).toBe(423)
    const lock = await (await client.fetch('/api/session/lock-status', { headers: { 'x-session-id': 'page-before' } })).json() as any
    expect(lock).toEqual({ state: 'stale', code: 'ACCOUNT_IMPORT_ACTIVE' })

    const done = await apply(client)
    expect(done).toMatchObject({ state: 'idle', blocking: false, result: { missing: 1, coldStorageFailed: 0, pluginStorageColdFailed: 0 }, staged: null })
    await expect(access(path.join(srv.cwd, 'save', 'account_import_staging'))).rejects.toThrow()
    // A page loaded before the swap holds the old data.
    expect((await writeSetting(client, 'page-before')).status).toBe(423)

    const entries = decodeBackup(await client.exportBackup())
    const db = decodeRisuDat(entries.find((entry) => entry.name === 'database.risudat')!.data) as any
    expect(db.account).toBeUndefined()
    expect(db.characters.map((c: any) => c.name).sort()).toEqual(account.expected.characterNames)
    expect(db.characters.find((c: any) => c.chaId === 'acc-char-c')).toMatchObject({ desc: 'kept in cold storage' })
    for (const asset of account.expected.assets) {
      const entry = entries.find((e) => e.name === asset.key.slice('assets/'.length) || e.name === asset.key)
      expect(entry?.data.equals(asset.data), asset.key).toBe(true)
    }

    const chat = await client.fetch('/api/chat-content/acc-char-a/1', { headers: { 'x-chat-id': 'chat-a2' } })
    expect(chat.status).toBe(200)
    const restored = decodeRisuDat(Buffer.from(await chat.arrayBuffer())) as any
    expect(restored.message.map((m: any) => m.data)).toEqual(account.expected.coldChatMessages)

    // RisuBard restores the upstream plugin storage index into plain keys of
    // the database (upstream-plugin-storage.cjs).
    expect(db.pluginCustomStorage).toEqual(account.expected.pluginStorage)
  })

  test('rejects a wrong login and resumes after the token expires', async () => {
    const account = createFakeAccount()
    const { client } = await setup(account)

    expect(await prepare(client, 'not-the-account-token', account.id)).toMatchObject({ state: 'idle', error: { code: 'ACCOUNT_LOGIN_FAILED' } })
    expect(await post(client, '/api/risu-account/prepare', { token: 'short', id: account.id })).toMatchObject({ status: 400, body: { code: 'ACCOUNT_TOKEN_INVALID' } })

    account.expireAfter = 8
    await prepare(client, account.token, account.id)
    await post(client, '/api/risu-account/download')
    expect(await waitForDownload(client)).toMatchObject({ state: 'needs-login', error: { code: 'ACCOUNT_LOGIN_EXPIRED' } })
    expect((await post(client, '/api/risu-account/download')).status).toBe(409)

    // A new login continues the started import by itself.
    expect(await prepare(client, account.token, account.id)).toMatchObject({ summary: { assetsStaged: 2, coldStaged: 3 } })
    expect(await waitForDownload(client)).toMatchObject({ state: 'downloaded' })
    expect(await apply(client)).toMatchObject({ state: 'idle', blocking: false, result: { missing: 1 } })
  })

  test('applies by itself when nothing is missing', async () => {
    const account = createFakeAccount()
    const missing = assetFor(99)
    account.items.set(missing.key, missing.data)
    const { client } = await setup(account)

    await prepare(client, account.token, account.id)
    await post(client, '/api/risu-account/download')
    expect(await waitWhile(client, 'downloading', 'downloaded', 'applying')).toMatchObject({ state: 'idle', blocking: false, result: { missing: 0 } })
    const entries = decodeBackup(await client.exportBackup())
    const db = decodeRisuDat(entries.find((entry) => entry.name === 'database.risudat')!.data) as any
    expect(db.characters.map((c: any) => c.name).sort()).toEqual(account.expected.characterNames)
  })

  test('cancel forgets the staged download', async () => {
    const account = createFakeAccount()
    const { srv, client } = await setup(account)

    await prepare(client, account.token, account.id)
    await post(client, '/api/risu-account/download')
    await waitForDownload(client)
    expect((await post(client, '/api/risu-account/cancel')).status).toBe(200)

    expect(await (await client.fetch('/api/risu-account/status')).json()).toMatchObject({ state: 'idle', blocking: false, staged: null })
    await expect(access(path.join(srv.cwd, 'save', 'account_import_staging'))).rejects.toThrow()
    expect((await post(client, '/api/risu-account/apply')).status).toBe(409)
    expect((await writeSetting(client, 'page-after')).status).toBe(200)
  })

  // RisuBard: nothing changes while the feature is unused, and a restart
  // during a started import keeps it blocked with the current data intact
  // until the user continues or cancels.
  test('is inert while unused and survives a restart without touching the data', async () => {
    const account = createFakeAccount()
    const { fake, srv, client } = await setup(account)

    expect(await (await client.fetch('/api/risu-account/status')).json()).toMatchObject({ state: 'idle', blocking: false })
    expect((await writeSetting(client, 'page-before')).status).toBe(200)
    const lockBefore = await (await client.fetch('/api/session/lock-status', { headers: { 'x-session-id': 'page-before' } })).json() as any
    expect(lockBefore.state).toBe('active')
    // A check that was never confirmed blocks nothing.
    await prepare(client, account.token, account.id)
    expect((await writeSetting(client, 'page-before')).status).toBe(200)

    account.expireAfter = 8
    await post(client, '/api/risu-account/cancel')
    await prepare(client, account.token, account.id)
    await post(client, '/api/risu-account/download')
    expect(await waitForDownload(client)).toMatchObject({ state: 'needs-login', blocking: true })

    await srv.stop('SIGKILL')
    const reopened = await spawnServer({
      env: { RISUBARD_RISU_ACCOUNT_URL: fake.url, RISUBARD_RISU_ACCOUNT_GAP_MS: '0' },
      seedSave: (save) => cp(path.join(srv.cwd, 'save'), save, { recursive: true, filter: (source) => path.basename(source) !== '.risubard-server.lock' }),
    })
    cleanups.push(reopened.cleanup)
    const again = await createClient(reopened.port, reopened.password)
    expect(await (await again.fetch('/api/risu-account/status')).json()).toMatchObject({
      state: 'needs-login', blocking: true, error: { code: 'ACCOUNT_IMPORT_INTERRUPTED' }, staged: { files: expect.any(Number), total: 10 },
    })
    const refused = await writeSetting(again, 'page-after-restart')
    expect(refused.status).toBe(423)

    expect((await post(again, '/api/risu-account/cancel')).status).toBe(200)
    await expect(access(path.join(reopened.cwd, 'save', 'account_import_staging'))).rejects.toThrow()
    const kept = await again.fetch('/api/read', { headers: { 'file-path': Buffer.from('test/account-import.txt').toString('hex') } })
    expect(kept.status).toBe(200)
    expect(Buffer.from(await kept.arrayBuffer()).toString()).toBe('x')
    expect((await writeSetting(again, 'page-after-restart')).status).toBe(200)
  })
})
