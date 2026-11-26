import { createServer, type Server } from 'http'
import { spawn, spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcResult } from '../src/shared/models'

/**
 * End-to-end coverage of the IPC verb layer (src/main/ipc.ts): the REAL
 * handlers registered through ipcMain.handle, the REAL git binary pushing
 * over the REAL git smart-HTTP protocol into bare repositories on disk,
 * and a scripted GitHub REST double standing in for api.github.com on
 * 127.0.0.1. This is the seam the unit suites leave dark — the wiring
 * between the account store, the provider client, and git sync — which is
 * exactly where "publish a local repo" lives.
 *
 * Electron is mocked to a userData sandbox (no keychain: secrets land as
 * verbatim sidecars, which settings.ts supports by design). No test here
 * ever touches the real network.
 */

const userData = mkdtempSync(join(tmpdir(), 'aspen-e2e-userdata-'))
const openedUrls: string[] = []

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) =>
      name === 'userData' ? userData : join(userData, name.replace(/[^a-z]/gi, '')),
    getName: () => 'Aspen',
    getVersion: () => '0.0.0-e2e',
    quit: () => undefined,
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  },
  ipcMain: { handle: vi.fn() },
  shell: {
    openExternal: vi.fn(async (url: string) => {
      openedUrls.push(url)
    })
  },
  clipboard: { writeText: vi.fn() },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] }))
  }
}))

vi.mock('../src/main/windows', () => ({
  applyTheme: vi.fn(),
  getMainWindow: () => null,
  isTrustedSender: () => true
}))

// Registered real handlers, captured through the mocked ipcMain.handle.
import { registerIpc } from '../src/main/ipc'
import { execGit } from '../src/main/git/exec'

type Handler = (event: { sender: { id: number } }, ...args: unknown[]) => Promise<IpcResult<unknown>>
const registered = new Map<string, Handler>()

/** Invoke a verb exactly as the preload bridge does, envelope included. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  const handler = registered.get(channel)
  if (handler === undefined) throw new Error(`verb '${channel}' never registered`)
  return (await handler({ sender: { id: 1 } }, ...args)) as IpcResult<T>
}

/** Assert success with the failure's own message in the diff, not a bare false. */
function okCall(r: IpcResult<unknown>): void {
  expect(r, `IPC verb failed: ${JSON.stringify(r)}`).toMatchObject({ ok: true })
}

function dataOf<T>(r: IpcResult<T>): T {
  okCall(r)
  return (r as { data: T }).data
}

function errorOf(r: IpcResult<unknown>): string {
  expect(r, `IPC verb unexpectedly succeeded: ${JSON.stringify(r)}`).toMatchObject({ ok: false })
  return (r as { error: string }).error
}

// -------------------------------------------------- scripted GitHub double

interface GithubState {
  /** Non-200 makes the /user validation answer that (sign-in failure). */
  userStatus: number
  /** When set, POST /user/repos answers this instead of creating. */
  createRepoResponse: { status: number; body: unknown } | null
  /** Repo names whose git-HTTP conversations answer 401 (revoked-token sim). */
  blockedRepos: Set<string>
  calls: { method: string; path: string; body: unknown; authorization: string | null }[]
  baseUrl: string
}

let server: Server | null = null
const gh: GithubState = {
  userStatus: 200,
  createRepoResponse: null,
  blockedRepos: new Set<string>(),
  calls: [],
  baseUrl: ''
}

/** Async `git` (spawnSync would park the fake server the child queries). */
function gitText(args: string[]): Promise<{ stdout: string; code: number | null }> {
  return new Promise(resolve => {
    const child = spawn('git', args)
    const chunks: Buffer[] = []
    child.stdout.on('data', c => chunks.push(c as Buffer))
    child.on('close', code => resolve({ stdout: Buffer.concat(chunks).toString('utf8'), code }))
  })
}

/** Create the bare repo GitHub would have made, ready to receive pushes. */
let servicesDir = ''
function makeBare(name: string): string {
  const dir = join(servicesDir, `${name}.git`)
  const r = spawnSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', dir])
  if (r.status !== 0) throw new Error(`bare init failed: ${r.stderr}`)
  spawnSync('git', ['-C', dir, 'config', 'http.receivepack', 'true'])
  writeFileSync(join(dir, 'git-daemon-export-ok'), '')
  return dir
}

function readBody(req: import('http').IncomingMessage): Promise<Buffer> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

/** Proxy one request to git-http-backend (CGI) and replay its response. */
async function serveGit(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
  body: Buffer
): Promise<void> {
  const url = req.url ?? '/'
  const [pathOnly, query = ''] = url.split('?')
  // Async spawn, not spawnSync: this runs INSIDE the request handler of a
  // server the pushing git child is talking to, and a synchronous spawn
  // would park the only event loop that can answer the next request.
  const { out, err } = await new Promise<{ out: Buffer; err: Buffer }>(resolve => {
    const child = spawn('/usr/lib/git-core/git-http-backend', {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: servicesDir,
        GIT_HTTP_EXPORT_ALL: '1',
        // The backend resolves PATH_INFO against GIT_PROJECT_ROOT, so drop
        // the /services URL prefix our clone URLs carry.
        PATH_INFO: pathOnly.replace(/^\/services/, ''),
        QUERY_STRING: query,
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        CONTENT_LENGTH: String(body.length),
        HTTP_AUTHORIZATION: (req.headers.authorization as string) ?? '',
        GATEWAY_INTERFACE: 'CGI/1.1',
        SERVER_PROTOCOL: 'HTTP/1.1'
      }
    })
    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []
    child.stdout.on('data', c => chunks.push(c as Buffer))
    child.stderr.on('data', c => errChunks.push(c as Buffer))
    child.on('close', () => resolve({ out: Buffer.concat(chunks), err: Buffer.concat(errChunks) }))
    child.stdin.end(body)
  })
  const sepCrlf = out.indexOf('\r\n\r\n')
  const sepLf = out.indexOf('\n\n')
  const sep = sepCrlf >= 0 ? sepCrlf : sepLf
  if (sep < 0) {
    res.writeHead(502).end(`git-http-backend said nothing: ${err}`)
    return
  }
  let status = 200
  const headers: Record<string, string> = {}
  for (const line of out.subarray(0, sep).toString('latin1').split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const k = line.slice(0, idx).trim().toLowerCase()
    const v = line.slice(idx + 1).trim()
    if (k === 'status') status = parseInt(v.split(' ')[0], 10) || status
    else if (k !== 'transfer-encoding' && k !== 'content-length') headers[k] = v
  }
  res.writeHead(status, headers).end(out.subarray(sep + (sepCrlf === sep ? 4 : 2)))
}

beforeAll(async () => {
  process.env['GIT_CONFIG_GLOBAL'] = join(tmpdir(), 'aspen-e2e-no-global-config')
  process.env['GIT_CONFIG_SYSTEM'] = join(tmpdir(), 'aspen-e2e-no-system-config')
  servicesDir = mkdtempSync(join(tmpdir(), 'aspen-e2e-services-'))
  server = createServer(async (req, res) => {
    const url = req.url ?? '/'
    const path = url.split('?')[0]
    const body = await readBody(req)
    const authorization = (req.headers.authorization as string) ?? null

    // git smart HTTP: /services/<name>.git/*
    if (path.startsWith('/services/')) {
      gh.calls.push({ method: req.method ?? '', path, body: null, authorization })
      const repoName = (path.split('/')[2] ?? '').replace(/\.git$/, '')
      if (gh.blockedRepos.has(repoName)) {
        // Reject the whole smart-HTTP conversation: git reads a 401 on the
        // service advertisement as an auth failure, which is the only
        // failure family the token retry answers.
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"', 'Content-Type': 'text/plain' }).end('auth required')
        return
      }
      await serveGit(req, res, body)
      return
    }

    if (!path.startsWith('/api/v3')) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"message":"Not Found"}')
      return
    }
    let parsed: unknown = null
    if (body.length > 0) {
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        parsed = body.toString('utf8')
      }
    }
    gh.calls.push({ method: req.method ?? '', path, body: parsed, authorization })

    const json = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(payload))
    }

    if (path === '/api/v3/user' && req.method === 'GET') {
      if (gh.userStatus !== 200) return json(gh.userStatus, { message: 'Bad credentials' })
      return json(200, {
        login: 'octo',
        name: 'Octo Cat',
        avatar_url: `${gh.baseUrl}/avatar.png`,
        email: 'octo@example.com'
      })
    }
    if (path === '/api/v3/user/emails' && req.method === 'GET') {
      return json(200, [{ email: 'octo@example.com', primary: true, verified: true }])
    }
    if (path === '/api/v3/user/orgs' && req.method === 'GET') {
      return json(200, [{ login: 'acme' }, { login: 'octo' }])
    }
    if (path === '/api/v3/user/repos' && req.method === 'POST') {
      if (gh.createRepoResponse !== null) {
        return json(gh.createRepoResponse.status, gh.createRepoResponse.body)
      }
      const reqBody = (parsed ?? {}) as Record<string, unknown>
      const name = String(reqBody.name ?? 'anon')
      makeBare(name)
      return json(201, {
        full_name: `octo/${name}`,
        name,
        private: reqBody.private === true,
        clone_url: `${gh.baseUrl}/services/${name}.git`,
        ssh_url: null,
        html_url: `${gh.baseUrl}/octo/${name}`,
        default_branch: 'main',
        pushed_at: new Date().toISOString(),
        description: reqBody.description ?? null
      })
    }
    return json(404, { message: `unhandled ${req.method} ${path}` })
  })
  await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
  // Short keep-alive idle window: a lingering idle socket would make the
  // afterAll close wait out Node's default (5s+) before the worker exits.
  server.keepAliveTimeout = 150
  server.requestTimeout = 30_000
  server.headersTimeout = 31_000
  gh.baseUrl = `http://127.0.0.1:${(server!.address() as { port: number }).port}`

  // A pre-seeded repository so the clone verb has something to fetch.
  const seed = makeBare('seed')
  const work = mkdtempSync(join(tmpdir(), 'aspen-e2e-seedwork-'))
  spawnSync('git', ['init', '--quiet', '-b', 'main', work])
  writeFileSync(join(work, 'README.md'), '# seed\n')
  spawnSync('git', ['-C', work, 'add', '.'])
  spawnSync('git', ['-C', work, '-c', 'user.name=s', '-c', 'user.email=s@e', 'commit', '-q', '-m', 'seed'])
  const seedPush = spawnSync('git', ['-C', work, 'push', '-q', `file://${seed}`, 'main:refs/heads/main'], { encoding: 'utf8' })
  if (seedPush.status !== 0) throw new Error(`seed push failed: ${seedPush.stderr}`)
  const seedRefs = spawnSync('git', ['ls-remote', seed], { encoding: 'utf8' })
  if (!seedRefs.stdout.includes('refs/heads/main')) throw new Error('seed repo has no main')
  rmSync(work, { recursive: true, force: true })

  const handleMock = vi.mocked(
    (await import('electron')).ipcMain.handle as unknown as ReturnType<typeof vi.fn>
  )
  registerIpc()
  for (const call of handleMock.mock.calls) {
    registered.set(String(call[0]), call[1] as Handler)
  }
  expect(registered.size).toBeGreaterThan(50)

  reposParent = mkdtempSync(join(tmpdir(), 'aspen-e2e-repos-'))
  const signed = await invoke<{ id: string; login: string }>(
    'signInWithToken',
    'github',
    TOKEN,
    gh.baseUrl
  )
  if (!signed.ok) throw new Error(`sign-in failed: ${signed.error}`)
  accountId = signed.data.id
  expect(signed.data.login).toBe('octo')
})

afterAll(async () => {
  if (server !== null) {
    server.closeAllConnections()
    await new Promise<void>(r => server!.close(() => r()))
  }
  rmSync(userData, { recursive: true, force: true })
  rmSync(servicesDir, { recursive: true, force: true })
  rmSync(reposParent, { recursive: true, force: true })
})

beforeEach(() => {
  gh.userStatus = 200
  gh.createRepoResponse = null
  gh.blockedRepos = new Set()
  gh.calls = []
  openedUrls.length = 0
})

// ------------------------------------------------------------------ verbs

const TOKEN = '***'
let accountId = ''
let reposParent = ''

/** A fresh local repo with one commit on main, no remotes. */
async function newLocalRepo(name: string, withOrigin?: string): Promise<string> {
  const dir = join(reposParent, name)
  await execGit(['init', '--quiet', '-b', 'main', dir], { cwd: reposParent, timeoutMs: 30_000 })
  await execGit(['config', 'user.name', 'Octo'], { cwd: dir, timeoutMs: 10_000 })
  await execGit(['config', 'user.email', 'octo@example.com'], { cwd: dir, timeoutMs: 10_000 })
  writeFileSync(join(dir, 'app.ts'), 'export const x = 1\n')
  await execGit(['add', '.'], { cwd: dir, timeoutMs: 10_000 })
  await execGit(['commit', '-q', '-m', 'first'], { cwd: dir, timeoutMs: 10_000 })
  if (withOrigin !== undefined) {
    await execGit(['remote', 'add', 'origin', withOrigin], { cwd: dir, timeoutMs: 10_000 })
  }
  return dir
}

describe('sign-in via token', () => {
  it('refuses an empty token before any request', async () => {
    const r = await invoke('signInWithToken', 'github', '   ')
    expect(errorOf(r)).toMatch(/Paste a token/)
    expect(gh.calls.length).toBe(0)
  })

  it('refuses a token GitHub rejects', async () => {
    gh.userStatus = 401
    const r = await invoke('signInWithToken', 'github', '***')
    expect(errorOf(r)).toMatch(/rejected the token \(401\)/)
  })

  it('lists the signed-in account', async () => {
    const accounts = dataOf<Array<{ login: string }>>(await invoke('listAccounts'))
    expect(accounts.some(a => a.login === 'octo')).toBe(true)
  })
})

describe('listAccountOwners', () => {
  it('puts the account first and dedupes orgs named like it', async () => {
    const owners = dataOf<Array<{ name: string }>>(await invoke('listAccountOwners', accountId))
    expect(owners.map(o => o.name)).toEqual(['octo', 'acme'])
  })
})

describe('createLocalRepository', () => {
  it('inits, seeds a staged README, and shows up in the list', async () => {
    const created = dataOf<{ path: string }>(
      await invoke('createLocalRepository', reposParent, 'sketch', true)
    )
    expect(created.path).toBe(join(reposParent, 'sketch'))
    const status = dataOf<{ files: Array<{ path: string }> }>(
      await invoke('getStatus', created.path)
    )
    expect(status.files.some(f => f.path === 'README.md')).toBe(true)
    const list = dataOf<Array<{ path: string }>>(await invoke('listRepositories'))
    expect(list.some(e => e.path === created.path)).toBe(true)
  })

  it('refuses to build on a folder that already has content', async () => {
    const r = await invoke('createLocalRepository', reposParent, 'sketch', true)
    expect(errorOf(r)).toMatch(/already exists and is not empty/)
  })
})

describe('publishRepository', () => {
  it('creates the repo, points origin at it, and pushes main with the account token', async () => {
    const repo = await newLocalRepo('site')
    const created = dataOf<{ fullName: string; cloneUrl: string; webUrl: string }>(
      await invoke('publishRepository', repo, accountId, {
        owner: 'octo',
        name: 'site',
        description: '',
        isPrivate: false
      })
    )
    expect(created.fullName).toBe('octo/site')

    // The POST body is what GitHub acts on: no `organization` for self-owner.
    const post = gh.calls.find(c => c.path === '/api/v3/user/repos')
    expect(post?.method).toBe('POST')
    expect(post?.body).toEqual({ name: 'site', description: '', private: false })

    // The push went out pinned to the publishing account's own token.
    const pushCall = gh.calls.find(c => c.path === '/services/site.git/git-receive-pack')
    expect(pushCall?.authorization).toBe(
      `Basic ${Buffer.from(`octo:${TOKEN}`, 'utf8').toString('base64')}`
    )

    // origin + upstream tracking landed on the local repo...
    expect(dataOf<string | null>(await invoke('getRemoteUrl', repo))).toBe(created.cloneUrl)
    const st = dataOf<{ branch: string; upstream?: string; ahead: number; behind: number }>(
      await invoke('getStatus', repo)
    )
    expect(st.branch).toBe('main')
    expect(st.upstream).toBe('origin/main')
    expect(st.ahead).toBe(0)
    expect(st.behind).toBe(0)

    // ...and the tip is really in the bare repository on the other side.
    const head = (
      await execGit(['rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 10_000 })
    ).stdout.trim()
    const ls = await gitText(['ls-remote', created.cloneUrl, 'refs/heads/main'])
    expect(ls.stdout).toContain(head)
  })

  it('passes the organization when publishing under an org owner', async () => {
    const repo = await newLocalRepo('shared')
    okCall(
      await invoke('publishRepository', repo, accountId, {
        owner: 'acme',
        name: 'shared',
        description: 'lib',
        isPrivate: true
      })
    )
    const post = gh.calls.find(c => c.path === '/api/v3/user/repos')
    expect(post?.body).toEqual({
      name: 'shared',
      description: 'lib',
      private: true,
      organization: 'acme'
    })
  })

  it('refuses a repo that already has an origin WITHOUT creating an orphan on GitHub', async () => {
    const repo = await newLocalRepo('duporigin', 'https://github.com/someone/else.git')
    const r = await invoke('publishRepository', repo, accountId, {
      owner: 'octo',
      name: 'duporigin',
      description: '',
      isPrivate: false
    })
    expect(errorOf(r)).toMatch(/already has an origin/)
    expect(gh.calls.some(c => c.path === '/api/v3/user/repos')).toBe(false)
  })

  it('refuses an unborn repo before touching the network', async () => {
    const dir = join(reposParent, 'unborn')
    await execGit(['init', '--quiet', '-b', 'main', dir], { cwd: reposParent, timeoutMs: 10_000 })
    const r = await invoke('publishRepository', dir, accountId, {
      owner: 'octo',
      name: 'unborn',
      description: '',
      isPrivate: false
    })
    expect(errorOf(r)).toMatch(/Make your first commit/)
    expect(gh.calls.length).toBe(0)
  })

  it('surfaces a provider 422 verbatim and adds no origin', async () => {
    const repo = await newLocalRepo('taken')
    gh.createRepoResponse = {
      status: 422,
      body: { message: 'name already exists on this account' }
    }
    const r = await invoke('publishRepository', repo, accountId, {
      owner: 'octo',
      name: 'taken',
      description: '',
      isPrivate: false
    })
    expect(errorOf(r)).toMatch(/rejected the query \(422\).*name already exists/s)
    expect(dataOf<string | null>(await invoke('getRemoteUrl', repo))).toBe(null)
  })

  it('keeps origin and points at Push when the token push is refused', async () => {
    const repo = await newLocalRepo('flaky')
    // The publish push and its helper retry both hit the blocked repo; the
    // only account for 127.0.0.1 is this one, so the retry can't fix it.
    gh.blockedRepos.add('flaky')
    const r = await invoke('publishRepository', repo, accountId, {
      owner: 'octo',
      name: 'flaky',
      description: '',
      isPrivate: false
    })
    expect(errorOf(r)).toMatch(/origin was kept/)
    expect(dataOf<string | null>(await invoke('getRemoteUrl', repo))).toBe(
      `${gh.baseUrl}/services/flaky.git`
    )
  })

  it('validates name and owner before any network call', async () => {
    const repo = await newLocalRepo('empty-name')
    const r = await invoke('publishRepository', repo, accountId, {
      owner: 'octo',
      name: '  ',
      description: '',
      isPrivate: false
    })
    expect(errorOf(r)).toMatch(/Enter a repository name/)
    expect(gh.calls.length).toBe(0)
  })

  it('names an unknown account instead of crashing', async () => {
    const repo = await newLocalRepo('ghostacct')
    const r = await invoke('publishRepository', repo, 'no-such-account', {
      owner: 'octo',
      name: 'ghostacct',
      description: '',
      isPrivate: false
    })
    expect(errorOf(r)).toMatch(/no longer signed in/)
  })
})

describe('push after publish', () => {
  it('sends new commits to the same origin', async () => {
    const repo = await newLocalRepo('followup')
    okCall(
      await invoke('publishRepository', repo, accountId, {
        owner: 'octo',
        name: 'followup',
        description: '',
        isPrivate: false
      })
    )
    writeFileSync(join(repo, 'more.ts'), 'export const y = 2\n')
    await execGit(['add', '.'], { cwd: repo, timeoutMs: 10_000 })
    await execGit(['commit', '-q', '-m', 'second'], { cwd: repo, timeoutMs: 10_000 })
    okCall(await invoke('push', repo))
    const head = (
      await execGit(['rev-parse', 'HEAD'], { cwd: repo, timeoutMs: 10_000 })
    ).stdout.trim()
    const ls = await gitText([
      'ls-remote',
      `${gh.baseUrl}/services/followup.git`,
      'refs/heads/main'
    ])
    expect(ls.stdout).toContain(head)
    const status = dataOf<{ ahead: number }>(await invoke('getStatus', repo))
    expect(status.ahead).toBe(0)
  })
})

describe('cloneRepository', () => {
  it('clones over smart HTTP and registers the result', async () => {
    const cloned = dataOf<{ path: string }>(
      await invoke('cloneRepository', `${gh.baseUrl}/services/seed.git`, reposParent, 'seed')
    )
    expect(cloned.path).toBe(join(reposParent, 'seed'))
    expect(readFileSync(join(cloned.path, 'README.md'), 'utf8')).toContain('# seed')
    expect(dataOf<string | null>(await invoke('getRemoteUrl', cloned.path))).toBe(
      `${gh.baseUrl}/services/seed.git`
    )
  })

  it('refuses a name that cannot be a folder', async () => {
    const r = await invoke('cloneRepository', `${gh.baseUrl}/services/seed.git`, reposParent, 'bad/name')
    expect(errorOf(r)).toMatch(/cannot be a folder/)
  })
})

describe('viewOnGitHub', () => {
  it('routes the repo target through openExternal', async () => {
    const repo = await newLocalRepo('webview')
    await execGit(['remote', 'add', 'origin', 'https://github.com/octo/webview.git'], {
      cwd: repo,
      timeoutMs: 10_000
    })
    okCall(await invoke('viewOnGitHub', repo, { kind: 'repo' }))
    expect(openedUrls).toContain('https://github.com/octo/webview')
  })

  it('refuses a non-http(s) URL at the bridge', async () => {
    const r = await invoke('openExternal', 'file:///etc/passwd')
    expect(errorOf(r)).toMatch(/non-http/)
  })
})

describe('the envelope itself', () => {
  it('wraps handler throws as {ok:false} with a friendly message', async () => {
    const r = await invoke('getStatus', join(reposParent, 'not-a-repo-at-all'))
    expect(errorOf(r).length).toBeGreaterThan(0)
  })

  it('registers every verb the preload bridge leans on', () => {
    // A channel missing from the handler map would fail at click time in
    // the shipped app; this is the tripwire.
    expect([...registered.keys()]).toEqual(
      expect.arrayContaining([
        'publishRepository',
        'createLocalRepository',
        'cloneRepository',
        'signInWithToken',
        'push',
        'pull',
        'forkRepository'
      ])
    )
  })
})