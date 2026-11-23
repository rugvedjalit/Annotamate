import { ADMIN, expect, signInApi, signInUi, signOutUi, suffix, test, type Account } from './support'

// Accounts: the administrator creates an annotator and a reviewer on the Users page; both sign in through
// the login form; a wrong password shows an error; signing out returns to the login screen.

test('admin creates accounts in the Users page; people sign in and out', async ({ page, actors, guard }, testInfo) => {
  const sfx = suffix(testInfo.retry)
  const annotator: Account = { name: 'Ann Annotator', username: `ann${sfx}`, password: 'annotate-all-day' }
  const reviewer: Account = { name: 'Rey Reviewer', username: `rey${sfx}`, password: 'review-all-night' }

  // ------------------------------------------------------------------ admin: Users page via the account menu
  await signInUi(page, ADMIN)
  await page.getByRole('button', { name: `Account menu for ${ADMIN.name}` }).click()
  await page.getByRole('menuitem', { name: 'Users' }).click()
  await expect(page).toHaveURL(/\/admin\/users$/)
  await expect(page.getByRole('heading', { name: 'Users', exact: true })).toBeVisible()

  for (const person of [annotator, reviewer]) {
    await page.getByRole('button', { name: 'Create user' }).click()
    const dialog = page.getByRole('dialog', { name: 'Create user' })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel('Name', { exact: true }).fill(person.name)
    const username = dialog.getByLabel('Username', { exact: true })
    await expect(username).toHaveValue(/.+/) // suggested from the name
    await username.fill(person.username)
    await dialog.getByLabel('Password', { exact: true }).fill(person.password)
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveAttribute('aria-required', 'true')
    await dialog.getByRole('button', { name: 'Create user' }).click()
    await expect(dialog).toBeHidden()
    const row = page.getByRole('row').filter({ hasText: `@${person.username}` })
    await expect(row).toBeVisible()
    await expect(row).toContainText(person.name)
  }

  // A duplicate username is reported on the field, not as a crash.
  await page.getByRole('button', { name: 'Create user' }).click()
  const dup = page.getByRole('dialog', { name: 'Create user' })
  await dup.getByLabel('Name', { exact: true }).fill('Someone Else')
  await dup.getByLabel('Username', { exact: true }).fill(annotator.username)
  await dup.getByLabel('Password', { exact: true }).fill('another-password')
  guard.allow(/status of 409/)
  await dup.getByRole('button', { name: 'Create user' }).click()
  await expect(dup.getByText('This username is already taken.')).toBeVisible()
  await dup.getByRole('button', { name: 'Cancel' }).click()
  await expect(dup).toBeHidden()

  // ------------------------------------------------------------------ annotator: wrong password, then sign in
  const ann = await actors.signIn(ADMIN, { name: 'annotator-tab' }) // a context; signed out again below
  await ann.context.clearCookies()
  await ann.page.goto('/')
  await expect(ann.page).toHaveURL(/\/login$/)
  await expect(ann.page.getByAltText('Annotamate').first()).toBeVisible() // brand on the login page
  guard.allow(/status of 401/)
  await ann.page.getByLabel('Username', { exact: true }).fill(annotator.username)
  await ann.page.getByLabel('Password', { exact: true }).fill('not-the-password')
  await ann.page.getByRole('button', { name: 'Sign in' }).click()
  await expect(ann.page.getByRole('alert')).toHaveText('Incorrect username or password.')
  await expect(ann.page.getByLabel('Password', { exact: true })).toHaveValue('')
  await expect(ann.page).toHaveURL(/\/login$/)

  await ann.page.getByLabel('Password', { exact: true }).fill(annotator.password)
  await ann.page.getByRole('button', { name: 'Sign in' }).click()
  await expect(ann.page).toHaveURL(/\/$/)
  await expect(ann.page.getByRole('button', { name: `Account menu for ${annotator.name}` })).toBeVisible()
  // Not a member of anything yet; no admin entry in the menu.
  await expect(ann.page.getByText('No projects yet')).toBeVisible()
  await ann.page.getByRole('button', { name: `Account menu for ${annotator.name}` }).click()
  await expect(ann.page.getByRole('menuitem', { name: 'Sign out' })).toBeVisible()
  await expect(ann.page.getByRole('menuitem', { name: 'Users' })).toHaveCount(0)
  await ann.page.keyboard.press('Escape')
  await signOutUi(ann.page, annotator)
  // Signed out for real: protected routes bounce to the login page with a return path.
  await ann.page.goto('/admin/users')
  await expect(ann.page).toHaveURL(/\/login\?next=%2Fadmin%2Fusers$/)

  // ------------------------------------------------------------------ reviewer: signs in, lands on the next page
  await signInApi(ann.page, reviewer)
  await ann.page.goto('/account/profile')
  await expect(ann.page.getByRole('button', { name: `Account menu for ${reviewer.name}` })).toBeVisible()
  await ann.context.clearCookies()
  await ann.page.goto('/login?next=%2Fmessages')
  await ann.page.getByLabel('Username', { exact: true }).fill(reviewer.username)
  await ann.page.getByLabel('Password', { exact: true }).fill(reviewer.password)
  await ann.page.getByRole('button', { name: 'Sign in' }).click()
  await expect(ann.page).toHaveURL(/\/messages$/)
  await signOutUi(ann.page, reviewer)

  // The admin's session is unaffected.
  await page.reload()
  await expect(page.getByRole('row').filter({ hasText: `@${reviewer.username}` })).toBeVisible()
})

test('deactivating an account signs its open tabs out live; reactivating lets them back in', async ({ page, actors, adminApi, guard }, testInfo) => {
  const sfx = suffix(testInfo.retry)
  const temp: Account = { name: 'Tess Temporary', username: `tess${sfx}`, password: 'short-lived-access' }
  await adminApi.ensureUser(temp)
  const tess = await actors.signIn(temp)
  await tess.page.goto('/messages')
  await expect(tess.page.getByRole('button', { name: `Account menu for ${temp.name}` })).toBeVisible()

  await signInApi(page, ADMIN)
  await page.goto('/admin/users')
  const row = page.getByRole('row').filter({ hasText: `@${temp.username}` })
  await row.getByRole('button', { name: `Actions for ${temp.name}` }).click()
  await page.getByRole('menuitem', { name: 'Deactivate' }).click()
  const confirm = page.getByRole('alertdialog', { name: `Deactivate ${temp.name}?` })
  await confirm.getByRole('button', { name: 'Deactivate' }).click()
  await expect(confirm).toBeHidden()
  await expect(row).toBeHidden() // deactivated accounts are hidden unless "Show deactivated" is on

  // The open tab is closed by the server (4401) and falls back to the sign-in page without a reload.
  guard.allow(/status of 401/)
  await expect(tess.page).toHaveURL(/\/login(\?next=.*)?$/)
  await tess.page.getByLabel('Username', { exact: true }).fill(temp.username)
  await tess.page.getByLabel('Password', { exact: true }).fill(temp.password)
  guard.allow(/status of 403/) // signing in to a deactivated account is refused
  await tess.page.getByRole('button', { name: 'Sign in' }).click()
  await expect(tess.page.getByRole('alert')).toHaveText('This account has been deactivated.')

  await page.getByRole('switch', { name: 'Show deactivated' }).click()
  await row.getByRole('button', { name: `Actions for ${temp.name}` }).click()
  await page.getByRole('menuitem', { name: 'Reactivate' }).click()
  await page.getByRole('alertdialog', { name: `Reactivate ${temp.name}?` }).getByRole('button', { name: 'Reactivate' }).click()
  await tess.page.getByLabel('Password', { exact: true }).fill(temp.password)
  await tess.page.getByRole('button', { name: 'Sign in' }).click()
  await expect(tess.page.getByRole('button', { name: `Account menu for ${temp.name}` })).toBeVisible()
})
