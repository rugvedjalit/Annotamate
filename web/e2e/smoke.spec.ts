import type { Page } from '@playwright/test'
import { DATASET_DIR, IMAGE_NAMES } from './fixtures'
import { ADMIN, expect, test } from './support'

// Smoke: first-run setup → create a project → annotate (draw a box with the mouse) → reload → the box
// persisted → project chat message. Runs serially against one fresh server.
test.describe.configure({ mode: 'serial' })

const PROJECT = 'Street cams'
const CLASS_NAME = 'car'

async function waitForIndexed(page: Page, projectId: string) {
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/projects/${projectId}/images?limit=1`)
        return res.ok() ? ((await res.json()) as { total: number }).total : -1
      },
      { timeout: 30_000, message: 'images should be indexed' },
    )
    .toBe(IMAGE_NAMES.length)
}

test('setup, create a project, draw a box that persists, chat', async ({ page }) => {
  // ------------------------------------------------------------------ first-run setup
  await page.goto('/')
  await expect(page).toHaveURL(/\/setup$/)
  await expect(page.getByRole('heading', { name: 'Create the administrator account' })).toBeVisible()
  await page.getByLabel('Your name', { exact: true }).fill(ADMIN.name)
  await page.getByLabel('Username', { exact: true }).fill(ADMIN.username)
  await page.getByLabel('Password', { exact: true }).fill(ADMIN.password)
  await page.getByLabel('Confirm password', { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: 'Create administrator' }).click()
  await expect(page).toHaveURL(/\/$/)

  // ------------------------------------------------------------------ create a project
  await page.getByRole('button', { name: 'New project' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'New project' })
  await expect(dialog).toBeVisible()
  // Step 1: image folder (open the shared root, then the dataset folder).
  await dialog.locator('[data-folder-row]').first().click()
  await dialog.locator('[data-folder-row]', { hasText: DATASET_DIR }).click()
  await expect(dialog.getByText(`${IMAGE_NAMES.length} images in this folder`)).toBeVisible()
  await dialog.getByRole('button', { name: 'Use this folder' }).click()
  await dialog.getByRole('button', { name: 'Next' }).click()
  // Step 2: labels next to the images, YOLO (defaults).
  await dialog.getByRole('button', { name: 'Next' }).click()
  // Step 3: details.
  await dialog.getByLabel('Name', { exact: true }).fill(PROJECT)
  const classes = dialog.getByLabel('Classes', { exact: true })
  await classes.fill(CLASS_NAME)
  await classes.press('Enter')
  await dialog.getByRole('button', { name: 'Next' }).click()
  // Step 4: members (none) → create.
  await dialog.getByRole('button', { name: 'Create project' }).click()
  await expect(page).toHaveURL(/\/p\/\d+$/)
  const projectId = /\/p\/(\d+)/.exec(page.url())![1]!
  await waitForIndexed(page, projectId)

  // ------------------------------------------------------------------ annotate
  await page.getByRole('link', { name: 'Continue annotating' }).click()
  await expect(page).toHaveURL(new RegExp(`/p/${projectId}/annotate/\\d+`))
  const annotatorUrl = page.url()
  // Editable once the image, the document and the edit lock are ready.
  await expect(page.getByRole('button', { name: 'Draw box' })).toBeEnabled()
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
  await expect(page.getByText('0 objects', { exact: true })).toBeVisible()

  const surface = page.locator('[data-annotator-canvas] canvas').last()
  const box = (await surface.boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx - 90, cy - 60)
  await page.mouse.down()
  await page.mouse.move(cx - 20, cy - 10, { steps: 6 })
  await page.mouse.move(cx + 70, cy + 50, { steps: 6 })
  await page.mouse.up()

  // The class picker opens next to the new box; Enter assigns the highlighted (active) class.
  const picker = page.getByRole('listbox', { name: 'Classes' })
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('option', { name: new RegExp(CLASS_NAME) })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(picker).toBeHidden()
  await expect(page.getByText('1 object', { exact: true })).toBeVisible()
  // Autosave (800 ms) → "Saved".
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible({ timeout: 15_000 })

  // ------------------------------------------------------------------ reload: the box persisted
  await page.reload()
  await expect(page).toHaveURL(annotatorUrl)
  await expect(page.getByText('1 object', { exact: true })).toBeVisible()
  const saved = await page.request.get(`/api/projects/${projectId}/images/${/annotate\/(\d+)/.exec(annotatorUrl)![1]}/annotation`)
  expect(saved.ok()).toBe(true)
  const docJson = (await saved.json()) as { boxes: { class_id: number | null; x2: number; x1: number }[] }
  expect(docJson.boxes).toHaveLength(1)
  expect(docJson.boxes[0]!.class_id).not.toBeNull()
  expect(docJson.boxes[0]!.x2 - docJson.boxes[0]!.x1).toBeGreaterThan(1)

  // ------------------------------------------------------------------ project chat
  await page.getByRole('button', { name: 'Project chat' }).click()
  const message = `Boxes look good on ${IMAGE_NAMES[0]}`
  const composer = page.getByRole('textbox', { name: 'Chat message' })
  await composer.fill(message)
  await composer.press('Enter')
  await expect(page.getByRole('log', { name: 'Chat messages' }).getByText(message)).toBeVisible()
  await expect(composer).toHaveValue('')
})
