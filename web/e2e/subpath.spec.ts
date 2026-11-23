import { datasetDir, SUBPATH } from './fixtures'
import { canvasPoint, CSRF, drag, expect, expectSaved, objectsCount, test } from './support'

// Reverse-proxy deployment under a URL prefix (`annotamate serve --base-url /annotamate/`) on a second, fresh
// server: redirects into the prefix, the injected <base href> + config script, a CSP whose script hashes match
// (any violation would fail the console guard), first-run setup, deep links and hard reloads, realtime (edit
// lock over the prefixed WebSocket) and the brand assets.

const ORIGIN = `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 8765) + 1}`
const BASE = `${ORIGIN}${SUBPATH}`
const OWNER = { name: 'Sam Subpath', username: 'sam', password: 'prefix-all-the-things' }

test('sub-path deployment: setup, deep links, reloads, realtime and CSP', async ({ page }) => {
  // ------------------------------------------------------------------ HTTP: redirects, HTML, headers
  const outside = await page.request.get(`${ORIGIN}/`, { maxRedirects: 0 })
  expect(outside.status()).toBe(307)
  expect(outside.headers().location).toBe(SUBPATH)
  const bare = await page.request.get(`${ORIGIN}${SUBPATH.slice(0, -1)}`, { maxRedirects: 0 })
  expect(bare.status()).toBe(308)

  const deep = await page.request.get(`${BASE}p/1/annotate/5`)
  expect(deep.status()).toBe(200)
  const html = await deep.text()
  expect(html).toContain(`<base href="${SUBPATH}">`)
  expect(html).toContain(`window.__ANNOTAMATE__={"baseUrl":"${SUBPATH}"}`)
  const csp = deep.headers()['content-security-policy']!
  const scriptSrc = /script-src ([^;]+)/.exec(csp)![1]!
  expect(scriptSrc).toMatch(/^'self'( 'sha256-[A-Za-z0-9+/]+=*')+$/)
  expect(deep.headers()['x-frame-options']).toBe('DENY')
  // Unknown assets are 404s (never the SPA shell), unknown API paths are JSON 404s.
  expect((await page.request.get(`${BASE}assets/nope.js`)).status()).toBe(404)
  const api404 = await page.request.get(`${BASE}api/nope`)
  expect(api404.status()).toBe(404)
  expect(((await api404.json()) as { code: string }).code).toBe('not_found')

  // ------------------------------------------------------------------ first-run setup inside the prefix
  await page.goto(BASE)
  await expect(page).toHaveURL(`${BASE}setup`)
  await page.getByLabel('Your name', { exact: true }).fill(OWNER.name)
  await page.getByLabel('Username', { exact: true }).fill(OWNER.username)
  await page.getByLabel('Password', { exact: true }).fill(OWNER.password)
  await page.getByLabel('Confirm password', { exact: true }).fill(OWNER.password)
  await page.getByRole('button', { name: 'Create administrator' }).click()
  // The app's root inside the prefix (React Router drops the trailing slash; the server redirects it back).
  await expect(page).toHaveURL(new RegExp(`^${BASE.slice(0, -1)}/?$`))
  // The wordmark loads from the prefixed brand folder.
  const logo = page.getByRole('link', { name: 'Annotamate home' }).locator('img:visible')
  await expect.poll(() => logo.evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(0)

  // ------------------------------------------------------------------ a project (API under the prefix)
  const created = await page.request.post(`${BASE}api/projects`, {
    headers: CSRF,
    data: { name: 'Behind a proxy', image_dir: datasetDir('subpath'), label_format: 'yolo', classes: ['car'] },
  })
  expect(created.ok()).toBe(true)
  const projectId = ((await created.json()) as { id: number }).id
  await expect
    .poll(async () => ((await (await page.request.get(`${BASE}api/projects/${projectId}/images?limit=1`)).json()) as { total: number }).total)
    .toBe(3)
  const images = ((await (await page.request.get(`${BASE}api/projects/${projectId}/images`)).json()) as { items: { id: number }[] }).items

  // ------------------------------------------------------------------ deep link + hard reload into the annotator
  await page.goto(`${BASE}p/${projectId}/annotate/${images[1]!.id}`)
  await expect(page.getByRole('button', { name: 'Draw box' })).toBeEnabled() // edit lock over the prefixed socket
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
  await drag(page, await canvasPoint(page, 0.35, 0.4), await canvasPoint(page, 0.55, 0.6))
  await page.keyboard.press('Enter') // the only class
  await expect(objectsCount(page, 1)).toBeVisible()
  await expectSaved(page)
  await page.reload()
  await expect(page).toHaveURL(`${BASE}p/${projectId}/annotate/${images[1]!.id}`)
  await expect(objectsCount(page, 1)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Draw box' })).toBeEnabled()

  // ------------------------------------------------------------------ in-app navigation, history, reload elsewhere
  await page.keyboard.press('a')
  await expect(page).toHaveURL(`${BASE}p/${projectId}/annotate/${images[0]!.id}`)
  await page.goBack()
  await expect(page).toHaveURL(`${BASE}p/${projectId}/annotate/${images[1]!.id}`)
  await page.goto(`${BASE}p/${projectId}/images`)
  await expect(page.getByRole('grid', { name: 'Images' }).getByRole('row', { name: /frame_0002\.png, In progress, 1 boxes/ })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: /Images/ })).toBeVisible()

  // ------------------------------------------------------------------ sign out stays inside the prefix
  await page.getByRole('button', { name: `Account menu for ${OWNER.name}` }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(`${BASE}login`)
  await page.goto(`${BASE}p/${projectId}`)
  await expect(page).toHaveURL(`${BASE}login?next=${encodeURIComponent(`/p/${projectId}`)}`)
})
