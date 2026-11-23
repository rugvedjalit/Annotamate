import { ADMIN, datasetImages, expect, openAnnotator, suffix, test, type Account } from './support'

// Edit locks and presence: the first person on an image edits it; others see a read-only "is editing" banner
// and presence avatars, get edit rights live when the editor moves on; managers can take over; the same user
// opening the image in a second tab moves the lock there.

test('edit locks, presence, live hand-over and take-over', async ({ adminApi, actors, guard }, testInfo) => {
  test.setTimeout(120_000)
  const sfx = suffix(testInfo.retry)
  const lara: Account = { name: 'Lara Locks', username: `lara${sfx}`, password: 'locks-annotator-1' }
  const ravi: Account = { name: 'Ravi Review', username: `ravi${sfx}`, password: 'locks-reviewer-1' }
  const laraUser = await adminApi.ensureUser(lara)
  const raviUser = await adminApi.ensureUser(ravi)
  const project = await adminApi.createProject(`Locks${sfx}`, 'locks', {
    members: [
      { user_id: laraUser.id, role: 'annotator' },
      { user_id: raviUser.id, role: 'reviewer' },
    ],
  })
  const names = datasetImages('locks')
  const img = await Promise.all(names.map((n) => adminApi.image(project.id, n)))

  // ------------------------------------------------------------------ Lara opens image 1 and edits
  const annotator = await actors.signIn(lara)
  await openAnnotator(annotator.page, project.id, img[0]!.id)

  // ------------------------------------------------------------------ Ravi opens image 1: read-only + presence
  const reviewer = await actors.signIn(ravi)
  await openAnnotator(reviewer.page, project.id, img[0]!.id, { editable: false })
  const banner = reviewer.page.getByRole('status').filter({ hasText: `${lara.name} is editing this image. You can view and comment.` })
  await expect(banner).toBeVisible()
  await expect(banner.getByRole('button', { name: 'Take over' })).toHaveCount(0) // reviewers cannot take over
  await expect(reviewer.page.getByRole('button', { name: 'Draw box' })).toBeDisabled()
  await expect(reviewer.page.getByRole('status').filter({ hasText: /^Read-only$/ })).toBeVisible()
  // Who is here: top bar avatars on both sides, and the files panel row of image 1.
  await expect(reviewer.page.getByRole('banner').getByRole('img', { name: lara.name })).toBeVisible()
  await expect(annotator.page.getByRole('banner').getByRole('img', { name: ravi.name })).toBeVisible()
  const files = reviewer.page.getByRole('listbox', { name: 'Images' })
  await expect(files.getByRole('option', { name: new RegExp(names[0]!) }).getByRole('img', { name: lara.name })).toBeVisible()
  // The reviewer can still comment while the image is locked.
  const inspector = reviewer.page.getByRole('complementary', { name: 'Inspector' })
  await inspector.getByRole('tab', { name: /Comments/ }).click()
  await inspector.getByRole('textbox', { name: 'New comment' }).fill('Looking at this one too')
  await inspector.getByRole('button', { name: 'Comment', exact: true }).click()
  await expect(inspector.getByRole('listitem').filter({ hasText: 'Looking at this one too' })).toBeVisible()

  // A save from Ravi's session while Lara holds the lock is refused with 423 + holder.
  const refused = await reviewer.page.request.put(`/api/projects/${project.id}/images/${img[0]!.id}/annotation`, {
    data: { base_version: null, boxes: [] },
    headers: { 'X-Annotamate-Client': 'web' },
  })
  expect(refused.status()).toBe(423)
  expect(((await refused.json()) as { code: string; holder: { username: string } }).holder.username).toBe(lara.username)

  // ------------------------------------------------------------------ Lara moves on: Ravi gets the lock live
  await annotator.page.keyboard.press('d')
  await expect(annotator.page).toHaveURL(new RegExp(`/annotate/${img[1]!.id}$`))
  await expect(annotator.page.getByRole('button', { name: 'Draw box' })).toBeEnabled()
  await expect(banner).toBeHidden()
  await expect(reviewer.page.getByRole('button', { name: 'Draw box' })).toBeEnabled()
  await expect(reviewer.page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
  // Presence follows: Lara's avatar moved to the image 2 row.
  await expect(files.getByRole('option', { name: new RegExp(names[1]!) }).getByRole('img', { name: lara.name })).toBeVisible()
  await expect(files.getByRole('option', { name: new RegExp(names[0]!) }).getByRole('img', { name: lara.name })).toHaveCount(0)

  // ------------------------------------------------------------------ the administrator takes over image 2
  const admin = await actors.signIn(ADMIN, { name: 'admin' })
  await openAnnotator(admin.page, project.id, img[1]!.id, { editable: false })
  const adminBanner = admin.page.getByRole('status').filter({ hasText: `${lara.name} is editing this image.` })
  await expect(adminBanner).toBeVisible()
  await adminBanner.getByRole('button', { name: 'Take over' }).click()
  await expect(adminBanner).toBeHidden()
  await expect(admin.page.getByRole('button', { name: 'Draw box' })).toBeEnabled()
  await expect(annotator.page.getByText(`${ADMIN.name} took over editing this image`)).toBeVisible() // toast
  await expect(annotator.page.getByRole('status').filter({ hasText: `${ADMIN.name} took over editing.` })).toBeVisible()
  await expect(annotator.page.getByRole('button', { name: 'Draw box' })).toBeDisabled()

  // ------------------------------------------------------------------ same user, second tab: the lock moves
  await annotator.page.keyboard.press('d')
  await expect(annotator.page).toHaveURL(new RegExp(`/annotate/${img[2]!.id}$`))
  await expect(annotator.page.getByRole('button', { name: 'Draw box' })).toBeEnabled()
  const secondTab = await annotator.context.newPage()
  guard.watch(secondTab, 'lara-tab-2')
  await openAnnotator(secondTab, project.id, img[2]!.id)
  const ownBanner = annotator.page.getByRole('status').filter({ hasText: 'You are editing this image in another tab.' })
  await expect(ownBanner).toBeVisible()
  await expect(annotator.page.getByRole('button', { name: 'Draw box' })).toBeDisabled()
  // Take it back in the first tab.
  await ownBanner.getByRole('button', { name: 'Edit here' }).click()
  await expect(annotator.page.getByRole('button', { name: 'Draw box' })).toBeEnabled()
  await expect(secondTab.getByRole('status').filter({ hasText: 'You are editing this image in another tab.' })).toBeVisible()
  await secondTab.close()
})
