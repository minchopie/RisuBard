#!/usr/bin/env node
// Local release entry point: run the CI-equivalent checks once, then dispatch
// the GitHub release workflow. A failure here costs minutes locally instead of
// a full CI run, so release.yml normally passes on its first attempt.
//
// Usage: pnpm release            (checks, then dispatch)
//        pnpm release --dry-run  (checks only)
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const RELEASE_ACCOUNT = 'minchopie'
const dryRun = process.argv.includes('--dry-run')

function fail(message) {
    console.error(`\n[release] ${message}`)
    process.exit(1)
}

function git(...args) {
    return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function run(label, command, args, env = process.env) {
    console.log(`\n[release] ${label}: ${command} ${args.join(' ')}`)
    const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', env })
    if (result.status !== 0) fail(`${label} failed. Nothing was dispatched.`)
}

// 1. Release metadata, mirroring release.yml's "Validate release metadata".
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json version must be X.Y.Z, got ${version}`)
const notesPath = `patchnote/${version}.md`
let notes = ''
try { notes = readFileSync(notesPath, 'utf8') } catch { fail(`Missing release notes: ${notesPath}`) }
if (!notes.split(/\r?\n/).includes(`# RisuBard v${version}`)) fail(`${notesPath} must contain "# RisuBard v${version}"`)
if (notes.split(/\r?\n/).filter((line) => line.trim()).length < 2) fail(`${notesPath} has only a heading`)

// 2. The workflow builds origin/main, so local main must be clean and pushed.
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') fail('Release from the main branch.')
if (git('status', '--porcelain', '--untracked-files=no')) fail('Commit or stash tracked changes first.')
git('fetch', '--quiet', '--tags', 'origin')
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('Push main so origin/main matches HEAD.')
if (git('tag', '--list', `v${version}`)) fail(`Tag v${version} already exists. Bump the version first.`)

// 3. The same checks release.yml runs before packaging, minus the slow build.
run('Release inputs', 'node', ['scripts/check-release-inputs.cjs'])
run('Type check', 'pnpm', ['run', 'check'])
run('Tests', 'pnpm', ['test'])

if (dryRun) {
    console.log(`\n[release] v${version} passed all checks (dry run, not dispatched).`)
    process.exit(0)
}

// 4. Dispatch only as the release account (see AGENTS.md account rule).
const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com', '--user', RELEASE_ACCOUNT],
    { encoding: 'utf8' }).trim()
const env = { ...process.env, GH_TOKEN: token }
const login = execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', env }).trim()
if (login !== RELEASE_ACCOUNT) fail(`GitHub account must be ${RELEASE_ACCOUNT}, got ${login}`)
run('Dispatch', 'gh', ['workflow', 'run', 'release.yml', '--ref', 'main', '-f', `version=${version}`], env)
console.log(`\n[release] v${version} dispatched. Follow it with: gh run watch`)
