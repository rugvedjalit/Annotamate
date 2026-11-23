import fs from 'node:fs'
import path from 'node:path'
import { datasetDir, makePng } from './fixtures'
import { ADMIN, expect, openAnnotator, signInApi, suffix, test, type Account } from './support'

// Project management through the UI with a member watching live: upload from the browser (multipart),
// class rename pushed to an open annotator, archive / restore (`GET /projects?archived=`), and project cards
// that render member avatars without one /members request per card.

test('upload, live class rename, archive and restore', async ({ page, adminApi, actors }, testInfo) => {
  test.setTimeout(120_000)
  const sfx = suffix(testInfo.retry)
  const lena: Account = { name: 'Lena Live', username: `lena${sfx}`, password: 'watching-closely-1' }
  const lenaUser = await adminApi.ensureUser(lena)
  const name = `Dock uploads${sfx}`
  const project = await adminApi.createProject(name, 'manage', {
    classes: ['car', 'person'],
    members: [{ user_id: lenaUser.id, role: 'annotator' }],
  })
  const first = (await adminApi.images(project.id))[0]!

  // ------------------------------------------------------------------ project cards: no request per card
  await signInApi(page, ADMIN)
  const memberRequests: string[] = []
  page.on('request', (r) => {
    if (/\/api\/projects\/\d+\/members$/.test(new URL(r.url()).pathname)) memberRequests.push(r.url())
  })
  await page.goto('/')
  const card = page.getByRole('article').filter({ hasText: name })
  await expect(card.getByRole('img', { name: ADMIN.name })).toBeVisible() // avatars from members_preview
  await expect(card.getByRole('img', { name: lena.name })).toBeVisible()
  expect(memberRequests).toEqual([])

  // ------------------------------------------------------------------ the member watches the annotator
  const l = await actors.signIn(lena)
  await openAnnotator(l.page, project.id, first.id)
  const classList = l.page.getByRole('complementary', { name: 'Inspector' }).getByRole('region', { name: 'Classes' })
  await expect(classList).toContainText('car')
  await expect(l.page.getByRole('complementary', { name: 'Files' }).getByRole('option')).toHaveCount(2)

  // ------------------------------------------------------------------ upload from the browser
  await page.goto(`/p/${project.id}/images`)
  const grid = page.getByRole('grid', { name: 'Images' })
  await expect(grid.getByRole('row', { name: /\.png,/ })).toHaveCount(2)
  await page.locator('input[type="file"]').setInputFiles({ name: 'dock_new.png', mimeType: 'image/png', buffer: makePng(320, 240, 2) })
  await expect(page.getByText('Added 1 image')).toBeVisible()
  await expect(grid.getByRole('row', { name: /dock_new\.png, To do, 0 boxes/ })).toBeVisible()
  expect(fs.existsSync(path.join(datasetDir('manage'), 'dock_new.png'))).toBe(true)
  // Live for the member: the files panel lists the new image without a reload.
  await expect(l.page.getByRole('complementary', { name: 'Files' }).getByRole('option')).toHaveCount(3)

  // ------------------------------------------------------------------ rename a class: pushed live
  await page.goto(`/p/${project.id}/settings/classes`)
  await page.getByRole('button', { name: 'Rename car' }).first().click()
  const rename = page.getByRole('textbox', { name: 'Rename car' })
  await rename.fill('vehicle')
  await rename.press('Enter')
  await expect(page.getByRole('button', { name: 'Rename vehicle' }).first()).toBeVisible()
  await expect(classList).toContainText('vehicle')
  await expect(classList).not.toContainText('car')
  const activity = (await adminApi.get<{ items: { type: string; data: Record<string, unknown> }[] }>(`projects/${project.id}/activity`)).items
  expect(activity[0]).toMatchObject({ type: 'class_updated', data: { name: 'vehicle', old_name: 'car' } })

  // ------------------------------------------------------------------ archive, find it under "Show archived", restore
  await page.goto(`/p/${project.id}/settings/danger`)
  await page.getByRole('button', { name: 'Archive project' }).click()
  await page.getByRole('alertdialog', { name: 'Archive this project?' }).getByRole('button', { name: 'Archive' }).click()
  await expect(page.getByRole('button', { name: 'Restore project' })).toBeVisible()
  await page.goto('/')
  await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0)
  await page.getByRole('switch', { name: 'Show archived' }).click()
  const archived = page.getByRole('region', { name: /Archived/ }).or(page.locator('section[aria-labelledby="archived-heading"]'))
  await expect(archived.getByRole('link', { name, exact: true })).toBeVisible()
  await expect(archived.getByRole('article').filter({ hasText: name })).toContainText('Archived')
  await archived.getByRole('link', { name, exact: true }).click()
  await page.goto(`/p/${project.id}/settings/danger`)
  await page.getByRole('button', { name: 'Restore project' }).click()
  await expect(page.getByRole('button', { name: 'Archive project' })).toBeVisible()
  await page.goto('/')
  await expect(page.getByRole('link', { name, exact: true }).first()).toBeVisible()
  const feed = (await adminApi.get<{ items: { type: string; data: Record<string, unknown> }[] }>(`projects/${project.id}/activity`)).items
  expect(feed.slice(0, 2).map((a) => a.data)).toEqual([
    { changes: ['archived'], values: { archived: false } },
    { changes: ['archived'], values: { archived: true } },
  ])
  expect(memberRequests).toEqual([])
})
