import { datasetImages, expect, signInUi, suffix, test, type Account } from './support'
import { ADMIN } from './support'

// Project and roles: the administrator creates a project on a fixture folder with "Require review" through the
// wizard, adds members with roles (in the wizard and later in Settings → Members); a viewer gets a read-only
// annotator but can still chat and comment.

test('admin creates a project with members and roles; a viewer is read-only but can chat and comment', async ({
  page,
  adminApi,
  actors,
}, testInfo) => {
  const sfx = suffix(testInfo.retry)
  const anna: Account = { name: 'Anna Roles', username: `anna.roles${sfx}`, password: 'roles-annotator-1' }
  const rob: Account = { name: 'Rob Roles', username: `rob.roles${sfx}`, password: 'roles-reviewer-1' }
  const vic: Account = { name: 'Vic Viewer', username: `vic.viewer${sfx}`, password: 'roles-viewer-1' }
  for (const a of [anna, rob, vic]) await adminApi.ensureUser(a)
  const projectName = `Roles project${sfx}`

  // ------------------------------------------------------------------ the wizard
  await signInUi(page, ADMIN)
  await page.getByRole('button', { name: 'New project' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await dialog.locator('[data-folder-row]').first().click()
  await dialog.locator('[data-folder-row]', { hasText: /^roles/ }).click()
  await expect(dialog.getByText('3 images in this folder')).toBeVisible()
  await dialog.getByRole('button', { name: 'Use this folder' }).click()
  await dialog.getByRole('button', { name: 'Next' }).click()
  await dialog.getByRole('button', { name: 'Next' }).click() // YOLO next to the images
  await dialog.getByLabel('Name', { exact: true }).fill(projectName)
  const classes = dialog.getByLabel('Classes', { exact: true })
  for (const c of ['car', 'person']) {
    await classes.fill(c)
    await classes.press('Enter')
  }
  const requireReview = dialog.getByRole('switch', { name: 'Require review' })
  await expect(requireReview).toHaveAttribute('aria-checked', 'false')
  await requireReview.click()
  await expect(requireReview).toHaveAttribute('aria-checked', 'true')
  await dialog.getByRole('button', { name: 'Next' }).click()

  // Members: Anna as annotator (default role), Rob as reviewer, Vic added as annotator and demoted later.
  await dialog.getByRole('checkbox', { name: new RegExp(anna.name) }).check()
  await dialog.getByRole('checkbox', { name: new RegExp(rob.name) }).check()
  await dialog.getByRole('combobox', { name: `Role for ${rob.name}` }).click()
  await page.getByRole('option', { name: 'Reviewer', exact: true }).click()
  await expect(dialog.getByRole('combobox', { name: `Role for ${rob.name}` })).toHaveText('Reviewer')
  await dialog.getByRole('checkbox', { name: new RegExp(vic.name) }).check()
  await expect(dialog.getByText('You and 3 more')).toBeVisible()
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page).toHaveURL(/\/p\/\d+$/)
  const projectId = Number(/\/p\/(\d+)/.exec(page.url())![1])
  await adminApi.waitIndexed(projectId, 3)

  const project = await adminApi.get<{ settings: { require_review: boolean }; members: { user: { username: string }; role: string }[] }>(
    `projects/${projectId}`,
  )
  expect(project.settings.require_review).toBe(true)
  const roles = Object.fromEntries(project.members.map((m) => [m.user.username, m.role]))
  expect(roles).toEqual({ [ADMIN.username]: 'manager', [anna.username]: 'annotator', [rob.username]: 'reviewer', [vic.username]: 'annotator' })

  // ------------------------------------------------------------------ Settings → Members: change a role
  await page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Members' }).click()
  await expect(page).toHaveURL(new RegExp(`/p/${projectId}/settings/members$`))
  const vicRole = page.getByRole('combobox', { name: `Role of ${vic.name}` })
  await expect(vicRole).toHaveText('Annotator')
  await vicRole.click()
  await page.getByRole('option', { name: 'Viewer', exact: true }).click()
  await expect(vicRole).toHaveText('Viewer')
  await expect
    .poll(async () => (await adminApi.get<{ user: { username: string }; role: string }[]>(`projects/${projectId}/members`)).find((m) => m.user.username === vic.username)?.role)
    .toBe('viewer')

  // ------------------------------------------------------------------ the viewer
  const viewer = await actors.signIn(vic)
  await viewer.page.goto('/')
  const card = viewer.page.getByRole('link', { name: projectName, exact: true })
  await expect(card).toBeVisible()
  await card.click()
  await expect(viewer.page).toHaveURL(new RegExp(`/p/${projectId}$`))
  // No settings for viewers.
  await expect(viewer.page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Settings' })).toHaveCount(0)

  const first = await adminApi.image(projectId, datasetImages('roles')[0]!)
  await viewer.page.goto(`/p/${projectId}/annotate/${first.id}`)
  await expect(viewer.page.getByText('You have view-only access to this project. You can comment and chat.')).toBeVisible()
  await expect(viewer.page.getByRole('button', { name: 'Draw box' })).toBeDisabled()
  await expect(viewer.page.getByRole('button', { name: /^Submit for review/ })).toHaveCount(0)
  // Keyboard shortcuts cannot edit either: W (box tool) does nothing, drawing does nothing.
  await viewer.page.keyboard.press('w')
  await expect(viewer.page.getByRole('button', { name: 'Draw box' })).toBeDisabled()

  // Chat works for viewers.
  await viewer.page.getByRole('button', { name: 'Project chat' }).click()
  const composer = viewer.page.getByRole('textbox', { name: 'Chat message' })
  await composer.fill('Viewer here, the second frame looks blurry')
  await composer.press('Enter')
  const log = viewer.page.getByRole('log', { name: 'Chat messages' })
  await expect(log.getByText('Viewer here, the second frame looks blurry')).toBeVisible()
  await viewer.page.getByRole('button', { name: 'Close project chat' }).click()

  // Comments work for viewers (but they cannot resolve).
  const inspector = viewer.page.getByRole('complementary', { name: 'Inspector' })
  await inspector.getByRole('tab', { name: /Comments/ }).click()
  await inspector.getByRole('textbox', { name: 'New comment' }).fill('Is the red block a car?')
  await inspector.getByRole('button', { name: 'Comment', exact: true }).click()
  const comment = inspector.getByRole('listitem').filter({ hasText: 'Is the red block a car?' })
  await expect(comment).toBeVisible()
  await expect(comment.getByRole('button', { name: 'Resolve' })).toHaveCount(0)

  // The server agrees: the viewer cannot save annotations.
  const res = await viewer.page.request.put(`/api/projects/${projectId}/images/${first.id}/annotation`, {
    data: { base_version: null, boxes: [] },
    headers: { 'X-Annotamate-Client': 'web' },
  })
  expect(res.status()).toBe(403)
  const comments = await adminApi.get<{ body: string; user: { username: string } }[]>(`projects/${projectId}/images/${first.id}/comments`)
  expect(comments.map((c) => [c.user.username, c.body])).toEqual([[vic.username, 'Is the red block a car?']])
})
