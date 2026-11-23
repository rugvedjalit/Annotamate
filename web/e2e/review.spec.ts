import type { Page } from '@playwright/test'
import {
  canvasPoint,
  datasetImages,
  drag,
  expect,
  expectSaved,
  objectsCount,
  openAnnotator,
  suffix,
  test,
  type Account,
} from './support'

// Review workflow (require_review): submit → the reviewer finds it in the review queue → reject with a reason →
// the annotator is notified and sees the reason as a comment → fixes and resubmits → approve → status counts
// on the project page update live.

function progress(page: Page) {
  return page.getByRole('region', { name: 'Progress' }).getByRole('img', { name: /^Status breakdown/ })
}

test('submit, reject with a reason, fix, resubmit, approve', async ({ adminApi, actors }, testInfo) => {
  test.setTimeout(120_000)
  const sfx = suffix(testInfo.retry)
  const nia: Account = { name: 'Nia Annotator', username: `nia${sfx}`, password: 'review-annotator-1' }
  const theo: Account = { name: 'Theo Reviewer', username: `theo${sfx}`, password: 'review-reviewer-1' }
  const niaUser = await adminApi.ensureUser(nia)
  const theoUser = await adminApi.ensureUser(theo)
  const project = await adminApi.createProject(`Review${sfx}`, 'review', {
    classes: ['car', 'person'],
    settings: { require_review: true },
    members: [
      { user_id: niaUser.id, role: 'annotator' },
      { user_id: theoUser.id, role: 'reviewer' },
    ],
  })
  const names = datasetImages('review')
  const first = await adminApi.image(project.id, names[0]!)

  // ------------------------------------------------------------------ the reviewer watches the overview
  const reviewer = await actors.signIn(theo)
  await reviewer.page.goto(`/p/${project.id}`)
  await expect(progress(reviewer.page)).toHaveAttribute('aria-label', /To do: 3 \(100%\)/)
  const queue = reviewer.page.getByRole('link', { name: /Review queue/ })
  await expect(queue).toBeVisible()

  // ------------------------------------------------------------------ the annotator boxes image 1 and submits
  const annotator = await actors.signIn(nia)
  const bell = annotator.page.getByRole('button', { name: /^Notifications/ })
  await openAnnotator(annotator.page, project.id, first.id)
  await expect(bell).toHaveAccessibleName('Notifications, 1 unread') // "added you to Review"
  await drag(annotator.page, await canvasPoint(annotator.page, 0.3, 0.55), await canvasPoint(annotator.page, 0.5, 0.75))
  await annotator.page.keyboard.press('1')
  await expect(objectsCount(annotator.page, 1)).toBeVisible()
  await expectSaved(annotator.page)
  await annotator.page.getByRole('button', { name: /^Submit for review/ }).click()
  await expect(annotator.page.getByText('Submitted for review')).toBeVisible()
  await expect(annotator.page).toHaveURL(/\/annotate\/\d+$/)
  expect(annotator.page.url()).not.toContain(`/annotate/${first.id}`) // moved on to the next image

  // The overview updates live for the reviewer.
  await expect(progress(reviewer.page)).toHaveAttribute('aria-label', /In review: 1/)
  await expect(queue).toContainText('1')

  // ------------------------------------------------------------------ the reviewer rejects with a reason
  await queue.click()
  await expect(reviewer.page).toHaveURL(new RegExp(`/p/${project.id}/annotate/${first.id}\\?status=review$`))
  await expect(reviewer.page.getByRole('navigation', { name: /image/i }).or(reviewer.page.getByText('1 / 1'))).toBeVisible()
  await reviewer.page.getByRole('button', { name: 'Reject…' }).click()
  const rejectDialog = reviewer.page.getByRole('dialog', { name: /Reject/ })
  await expect(rejectDialog).toBeVisible()
  const reason = 'The car box is too loose, tighten it please'
  await rejectDialog.getByLabel('Reason', { exact: true }).fill(reason)
  await rejectDialog.getByRole('button', { name: 'Reject', exact: true }).click()
  await expect(reviewer.page.getByText('Rejected. The annotator was notified.')).toBeVisible()
  // Back to the overview (leaving the image releases its edit lock for the annotator).
  await reviewer.page.getByRole('link', { name: 'Overview' }).or(reviewer.page.getByRole('link', { name: 'Annotamate home' })).first().click()
  await reviewer.page.goto(`/p/${project.id}`)
  await expect(progress(reviewer.page)).toHaveAttribute('aria-label', /Rejected: 1/)

  // ------------------------------------------------------------------ the annotator is notified
  await expect(bell).toHaveAccessibleName('Notifications, 2 unread')
  await expect(annotator.page.getByText(`${theo.name} rejected ${names[0]}: ${reason}`).first()).toBeVisible() // toast
  await bell.click()
  const item = annotator.page.getByRole('button', { name: new RegExp(`rejected ${names[0]}`) })
  await expect(item).toBeVisible()
  await item.click()
  await expect(annotator.page).toHaveURL(new RegExp(`/annotate/${first.id}$`))
  await expect(bell).toHaveAccessibleName('Notifications, 1 unread')
  // The reason is a comment on the image (the Comments tab opens from the notification).
  const inspector = annotator.page.getByRole('complementary', { name: 'Inspector' })
  await expect(inspector.getByRole('tab', { name: /Comments/ })).toHaveAttribute('aria-selected', 'true')
  await expect(inspector.getByRole('listitem').filter({ hasText: reason })).toBeVisible()
  expect((await adminApi.image(project.id, names[0]!)).status).toBe('rejected')

  // ------------------------------------------------------------------ fix (resize the box with Properties) and resubmit
  await inspector.getByRole('tab', { name: 'Labels' }).click()
  await annotator.page.getByRole('listbox', { name: 'Objects on this image' }).getByRole('option').first().click()
  const width = annotator.page.getByRole('textbox', { name: 'W', exact: true })
  const before = Number(await width.inputValue())
  await width.fill(String(Math.round(before - 20)))
  await width.press('Enter')
  await expectSaved(annotator.page)
  await expect.poll(async () => (await adminApi.image(project.id, names[0]!)).status).toBe('in_progress')
  await annotator.page.getByRole('button', { name: /^Submit for review/ }).click()
  await expect(annotator.page.getByText('Submitted for review')).toBeVisible()

  // ------------------------------------------------------------------ the reviewer approves
  await expect.poll(async () => (await adminApi.image(project.id, names[0]!)).status).toBe('review')
  await expect(progress(reviewer.page)).toHaveAttribute('aria-label', /In review: 1/) // live on the overview
  await reviewer.page.goto(`/p/${project.id}/annotate/${first.id}?status=review`)
  await expect(reviewer.page.getByRole('button', { name: 'Approve' })).toBeVisible()
  await reviewer.page.getByRole('button', { name: 'Approve' }).click()
  await expect(reviewer.page.getByText('Approved', { exact: true }).first()).toBeVisible()
  await expect(bell).toHaveAccessibleName(/Notifications, \d+ unread/)
  await expect(annotator.page.getByText(`${theo.name} approved ${names[0]}`).first()).toBeVisible()

  // ------------------------------------------------------------------ counts on the project page
  await reviewer.page.goto(`/p/${project.id}`)
  await expect(progress(reviewer.page)).toHaveAttribute('aria-label', /Done: 1 \(33%\)/)
  await expect(progress(reviewer.page)).not.toHaveAttribute('aria-label', /In review/)
  await expect(reviewer.page.getByRole('link', { name: /Review queue/ })).toHaveText('Review queue')
  const activity = reviewer.page.getByRole('region', { name: 'Activity' })
  await expect(activity.getByText(/approved/).first()).toBeVisible()
  await expect(activity.getByText(/rejected/).first()).toBeVisible()
  expect((await adminApi.image(project.id, names[0]!)).status).toBe('done')
})
