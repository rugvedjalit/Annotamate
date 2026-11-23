import type { Page } from '@playwright/test'
import { datasetImages, expect, openAnnotator, suffix, test, type Account } from './support'

// Assignments: a project manager distributes the to-do images between two annotators from the Images page;
// each annotator is notified and sees exactly their images under "Mine".

async function mineFilenames(page: Page): Promise<string[]> {
  const files = page.getByRole('complementary', { name: 'Files' })
  await files.getByRole('button', { name: 'Mine', exact: true }).click()
  await expect(files.getByRole('button', { name: 'Mine', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const rows = files.getByRole('listbox', { name: 'Images' }).getByRole('option')
  await expect(rows.first()).toBeVisible()
  const texts = await rows.allTextContents()
  return texts.map((t) => /frame_\d+\.png/.exec(t)?.[0] ?? t).sort()
}

test('a manager distributes to-do images; annotators are notified and see them under "Mine"', async ({
  adminApi,
  actors,
}, testInfo) => {
  test.setTimeout(120_000)
  const sfx = suffix(testInfo.retry)
  const mia: Account = { name: 'Mia Manager', username: `mia${sfx}`, password: 'assign-manager-1' }
  const amy: Account = { name: 'Amy Annotator', username: `amy${sfx}`, password: 'assign-annotator-1' }
  const ben: Account = { name: 'Ben Annotator', username: `ben${sfx}`, password: 'assign-annotator-2' }
  const [miaUser, amyUser, benUser] = [await adminApi.ensureUser(mia), await adminApi.ensureUser(amy), await adminApi.ensureUser(ben)]
  const project = await adminApi.createProject(`Assign${sfx}`, 'assign', {
    members: [
      { user_id: miaUser.id, role: 'manager' },
      { user_id: amyUser.id, role: 'annotator' },
      { user_id: benUser.id, role: 'annotator' },
    ],
  })
  const names = datasetImages('assign') // 6 images
  // The last image is already done: only the 5 to-do images get distributed.
  const last = await adminApi.image(project.id, names[5]!)
  await adminApi.post(`projects/${project.id}/images/bulk`, { image_ids: [last.id], action: 'set_status', status: 'done' })

  const a = await actors.signIn(amy)
  const b = await actors.signIn(ben)
  await a.page.goto('/')
  await b.page.goto(`/p/${project.id}`)
  const amyBell = a.page.getByRole('button', { name: /^Notifications/ })
  const benBell = b.page.getByRole('button', { name: /^Notifications/ })
  await expect(amyBell).toHaveAccessibleName('Notifications, 1 unread') // added to the project
  await expect(benBell).toHaveAccessibleName('Notifications, 1 unread')

  // ------------------------------------------------------------------ the manager distributes from the Images page
  const m = await actors.signIn(mia)
  await m.page.goto(`/p/${project.id}`)
  await m.page.getByRole('navigation', { name: 'Project sections' }).getByRole('link', { name: 'Images' }).click()
  await expect(m.page).toHaveURL(new RegExp(`/p/${project.id}/images`))
  await m.page.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'To do' }).click()
  const grid = m.page.getByRole('grid', { name: 'Images' })
  await expect(grid.getByRole('row', { name: /frame_\d+\.png/ })).toHaveCount(5)
  await m.page.getByRole('checkbox', { name: 'Select all loaded rows' }).click()
  const selectionBar = m.page.getByRole('region', { name: 'Selected images' }).or(m.page.getByLabel('Selected images'))
  await expect(selectionBar).toContainText('5')
  await selectionBar.getByRole('button', { name: /Distribute/ }).click()
  const dialog = m.page.getByRole('dialog', { name: 'Distribute images evenly' })
  await dialog.getByRole('checkbox', { name: new RegExp(amy.name) }).check()
  await dialog.getByRole('checkbox', { name: new RegExp(ben.name) }).check()
  await expect(dialog.getByText('About 3 images each for 2 people.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Distribute 5' }).click()
  await expect(dialog).toBeHidden()
  // The table reflects the assignees.
  await expect(grid.getByRole('row', { name: /frame_0001\.png/ })).toContainText(amy.name)
  await expect(grid.getByRole('row', { name: /frame_0005\.png/ })).toContainText(ben.name)

  const assigned = Object.fromEntries((await adminApi.images(project.id)).map((i) => [i.filename, i.assignee?.username ?? null]))
  expect(assigned).toEqual({
    [names[0]!]: amy.username,
    [names[1]!]: amy.username,
    [names[2]!]: amy.username,
    [names[3]!]: ben.username,
    [names[4]!]: ben.username,
    [names[5]!]: null,
  })

  // ------------------------------------------------------------------ notifications arrive live
  await expect(amyBell).toHaveAccessibleName('Notifications, 2 unread')
  await expect(benBell).toHaveAccessibleName('Notifications, 2 unread')
  await expect(a.page.getByText(`${mia.name} assigned you 3 images in ${project.name}`).first()).toBeVisible()
  await expect(b.page.getByText(`${mia.name} assigned you 2 images in ${project.name}`).first()).toBeVisible()
  // Amy's project card shows her queue without a reload.
  await expect(a.page.getByRole('article').filter({ hasText: project.name })).toContainText('3 assigned to you')

  // ------------------------------------------------------------------ "Mine" in the annotator
  await benBell.click()
  await b.page.getByRole('button', { name: new RegExp(`assigned you 2 images`) }).click()
  await expect(b.page).toHaveURL(new RegExp(`/p/${project.id}$`))
  await b.page.getByRole('link', { name: 'Continue annotating' }).click()
  // "Continue annotating" opens the first image assigned to Ben.
  const benFirst = await adminApi.image(project.id, names[3]!)
  await expect(b.page).toHaveURL(new RegExp(`/annotate/${benFirst.id}$`))
  expect(await mineFilenames(b.page)).toEqual([names[3], names[4]])

  const amyFirst = await adminApi.image(project.id, names[0]!)
  await openAnnotator(a.page, project.id, amyFirst.id)
  expect(await mineFilenames(a.page)).toEqual([names[0], names[1], names[2]])
  // Navigation stays inside the filter: D walks Amy's images only.
  const second = await adminApi.image(project.id, names[1]!)
  await a.page.keyboard.press('d')
  await expect(a.page).toHaveURL(new RegExp(`/annotate/${second.id}\\?assignee=me$`))
  await expect(a.page.getByText('2 / 3')).toBeVisible()
  await a.page.keyboard.press('d')
  const third = await adminApi.image(project.id, names[2]!)
  await expect(a.page).toHaveURL(new RegExp(`/annotate/${third.id}\\?assignee=me$`))
  await expect(a.page.getByText('3 / 3')).toBeVisible()
})
