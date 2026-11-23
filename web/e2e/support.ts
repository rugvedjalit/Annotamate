// Shared helpers for the end-to-end specs: a console/page-error guard on every page, an API client (with
// the CSRF header) for fast arrangement, and signed-in browser contexts for multi-user scenarios.
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  expect,
  request as playwrightRequest,
  test as base,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test'
import { datasetDir, imageNames, DATASETS, type DatasetName } from './fixtures'

export { expect }

export interface Account {
  name: string
  username: string
  password: string
}

/** Created by the smoke spec through the first-run setup screen (every other spec depends on it). */
export const ADMIN: Account = { name: 'Erin Admin', username: 'erin', password: 'correct-horse-42' }

export const CSRF = { 'X-Annotamate-Client': 'web' }

// ------------------------------------------------------------------------------------------ console guard

/**
 * Collects console errors/warnings and uncaught page errors (including unhandled promise rejections) from
 * every watched page; the test fails at teardown when something unexpected was logged.
 */
export class ConsoleGuard {
  private readonly problems: string[] = []
  private readonly allowed: RegExp[] = []

  /** Tolerate messages matching `pattern` for the rest of this test (e.g. a deliberate 401). */
  allow(pattern: RegExp): void {
    this.allowed.push(pattern)
  }

  watch(page: Page, who: string): void {
    page.on('console', (msg) => {
      const type = msg.type()
      if (type !== 'error' && type !== 'warning') return
      const text = msg.text()
      if (this.allowed.some((re) => re.test(text))) return
      const where = msg.location()?.url ? ` (${msg.location().url.replace(/^.*\/assets\//, 'assets/')})` : ''
      this.problems.push(`[${who}] console.${type}: ${text}${where}`)
    })
    page.on('pageerror', (err) => {
      const text = `${err.name}: ${err.message}`
      if (this.allowed.some((re) => re.test(text))) return
      this.problems.push(`[${who}] uncaught ${text}`)
    })
  }

  verify(): void {
    expect(this.problems, 'no unexpected console errors, warnings or uncaught exceptions').toEqual([])
  }
}

// ------------------------------------------------------------------------------------------ API client

export interface UserOut {
  id: number
  username: string
  display_name: string
}

export interface ProjectOut {
  id: number
  name: string
  classes: { id: number; index: number; name: string; color: string }[]
}

export interface ImageOut {
  id: number
  filename: string
  status: string
  box_count: number
  assignee: UserOut | null
}

export interface BoxOut {
  id: string
  class_id: number | null
  x1: number
  y1: number
  x2: number
  y2: number
}

export class Api {
  constructor(readonly request: APIRequestContext) {}

  async call<T = unknown>(method: string, url: string, data?: unknown): Promise<T> {
    const res = await this.request.fetch(`/api/${url.replace(/^\/+/, '')}`, {
      method,
      data: data === undefined ? undefined : data,
      headers: method === 'GET' ? {} : CSRF,
    })
    if (!res.ok()) throw new Error(`${method} /api/${url} → ${res.status()} ${await res.text()}`)
    return (res.status() === 204 ? undefined : await res.json()) as T
  }

  get<T = unknown>(url: string) {
    return this.call<T>('GET', url)
  }
  post<T = unknown>(url: string, data?: unknown) {
    return this.call<T>('POST', url, data ?? {})
  }
  patch<T = unknown>(url: string, data: unknown) {
    return this.call<T>('PATCH', url, data)
  }
  put<T = unknown>(url: string, data: unknown) {
    return this.call<T>('PUT', url, data)
  }

  async login(account: Account): Promise<UserOut> {
    return this.post<UserOut>('auth/login', { username: account.username, password: account.password })
  }

  /** Create the account (or reset its password if it exists already, e.g. on a retry). */
  async ensureUser(account: Account, opts: { is_admin?: boolean } = {}): Promise<UserOut> {
    const users = await this.get<(UserOut & { username: string })[]>('users?include_inactive=true')
    const existing = users.find((u) => u.username === account.username)
    if (existing) {
      await this.post(`users/${existing.id}/password`, { new_password: account.password })
      return existing
    }
    return this.post<UserOut>('users', {
      username: account.username,
      display_name: account.name,
      password: account.password,
      ...opts,
    })
  }

  async createProject(
    name: string,
    dataset: DatasetName,
    opts: {
      classes?: string[]
      settings?: Record<string, unknown>
      members?: { user_id: number; role: string }[]
    } = {},
  ): Promise<ProjectOut> {
    const project = await this.post<ProjectOut>('projects', {
      name,
      image_dir: datasetDir(dataset),
      label_format: 'yolo',
      classes: opts.classes ?? ['car', 'person'],
      settings: opts.settings ?? {},
      members: opts.members ?? [],
    })
    await this.waitIndexed(project.id, DATASETS[dataset])
    return project
  }

  async waitIndexed(projectId: number, count: number): Promise<void> {
    await expect
      .poll(async () => (await this.get<{ total: number }>(`projects/${projectId}/images?limit=1`)).total, {
        timeout: 30_000,
        message: 'images should be indexed',
      })
      .toBe(count)
  }

  async images(projectId: number): Promise<ImageOut[]> {
    return (await this.get<{ items: ImageOut[] }>(`projects/${projectId}/images?limit=500`)).items
  }

  async image(projectId: number, filename: string): Promise<ImageOut> {
    const hit = (await this.images(projectId)).find((i) => i.filename === filename)
    if (!hit) throw new Error(`image ${filename} not found in project ${projectId}`)
    return hit
  }

  async boxes(projectId: number, imageId: number): Promise<BoxOut[]> {
    return (await this.get<{ boxes: BoxOut[] }>(`projects/${projectId}/images/${imageId}/annotation`)).boxes
  }
}

/** A standalone API session (own cookie jar) signed in as `account`. */
export async function apiSession(baseURL: string, account: Account): Promise<Api> {
  const request = await playwrightRequest.newContext({ baseURL })
  const api = new Api(request)
  await api.login(account)
  return api
}

// ------------------------------------------------------------------------------------------ fixtures

export interface Actor {
  page: Page
  context: BrowserContext
  api: Api
  account: Account
}

interface Fixtures {
  guard: ConsoleGuard
  /** API session of the administrator. */
  adminApi: Api
  /** Signed-in browser contexts for more users (one context per user, closed after the test). */
  actors: { signIn: (account: Account, opts?: { name?: string }) => Promise<Actor> }
}

export const test = base.extend<Fixtures>({
  guard: [
    async ({}, use) => {
      const guard = new ConsoleGuard()
      await use(guard)
      guard.verify()
    },
    { auto: true },
  ],
  page: async ({ page, guard }, use) => {
    guard.watch(page, 'page')
    await use(page)
  },
  adminApi: async ({ baseURL }, use) => {
    const api = await apiSession(baseURL!, ADMIN)
    await use(api)
    await api.request.dispose()
  },
  actors: async ({ browser, guard, baseURL }, use) => {
    const opened: BrowserContext[] = []
    await use({
      async signIn(account, opts) {
        const { context, page } = await newGuardedPage(browser, guard, baseURL!, opts?.name ?? account.username)
        opened.push(context)
        const api = new Api(context.request)
        await api.login(account)
        return { page, context, api, account }
      },
    })
    for (const context of opened) await context.close()
  },
})

export async function newGuardedPage(browser: Browser, guard: ConsoleGuard, baseURL: string, who: string) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  guard.watch(page, who)
  return { context, page }
}

/** Sign the page's context in through the API (fast) — the cookie is shared with the page. */
export async function signInApi(page: Page, account: Account): Promise<void> {
  const res = await page.request.post('/api/auth/login', {
    data: { username: account.username, password: account.password },
    headers: CSRF,
  })
  expect(res.ok(), `login ${account.username}`).toBe(true)
}

/** Sign in through the login form. */
export async function signInUi(page: Page, account: Account): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Username', { exact: true }).fill(account.username)
  await page.getByLabel('Password', { exact: true }).fill(account.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: `Account menu for ${account.name}` })).toBeVisible()
}

export async function signOutUi(page: Page, account: Account): Promise<void> {
  await page.getByRole('button', { name: `Account menu for ${account.name}` }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login$/)
}

// ------------------------------------------------------------------------------------------ annotator helpers

/** Open the annotator on an image and wait until it is editable (image, document and edit lock ready). */
export async function openAnnotator(page: Page, projectId: number, imageId: number, opts: { editable?: boolean } = {}) {
  await page.goto(`/p/${projectId}/annotate/${imageId}`)
  await expect(page.locator('[data-annotator-canvas] canvas').last()).toBeVisible()
  if (opts.editable ?? true) {
    await expect(page.getByRole('button', { name: 'Draw box' })).toBeEnabled()
    await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
  }
}

/** The overlay canvas (receives pointer events). */
export function canvasSurface(page: Page): Locator {
  return page.locator('[data-annotator-canvas] canvas').last()
}

/** Screen point at a fraction of the canvas box. */
export async function canvasPoint(page: Page, fx: number, fy: number): Promise<{ x: number; y: number }> {
  const box = (await canvasSurface(page).boundingBox())!
  return { x: box.x + box.width * fx, y: box.y + box.height * fy }
}

/** Mouse drag in small steps (crosses the 3 px gesture threshold like a real pointer). */
export async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + (to.x - from.x) / 3, from.y + (to.y - from.y) / 3, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
}

export function objectsCount(page: Page, n: number): Locator {
  return page.getByText(n === 1 ? '1 object' : `${n} objects`, { exact: true })
}

/** Wait for the autosave to land ("Saved" pill). */
export async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 15_000 })
}

// ------------------------------------------------------------------------------------------ files

export function labelFile(dataset: DatasetName, imageFilename: string): string {
  return path.join(datasetDir(dataset), imageFilename.replace(/\.[^.]+$/, '.txt'))
}

export function readLabel(dataset: DatasetName, imageFilename: string): string | null {
  const file = labelFile(dataset, imageFilename)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

/** A file in a dataset folder (null when missing). */
export function readDatasetFile(dataset: DatasetName, name: string): string | null {
  const file = path.join(datasetDir(dataset), name)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

export function datasetImages(dataset: DatasetName): string[] {
  return imageNames(DATASETS[dataset])
}

/** A unique-enough suffix so retries on the same server never collide on usernames/project names. */
export function suffix(retry: number): string {
  return retry ? `-r${retry}` : ''
}

// ------------------------------------------------------------------------------------------ zip

/** Minimal zip reader (central directory; stored and deflated entries) → name → bytes. */
export function readZip(zip: Buffer): Map<string, Buffer> {
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file')
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  const out = new Map<string, Buffer>()
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory')
    const method = zip.readUInt16LE(p + 10)
    const size = zip.readUInt32LE(p + 20)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const local = zip.readUInt32LE(p + 42)
    const name = zip.toString('utf8', p + 46, p + 46 + nameLen)
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(start, start + size)
    out.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw))
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}
