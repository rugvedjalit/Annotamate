import type { Page } from '@playwright/test'
import {
  canvasPoint,
  canvasSurface,
  datasetImages,
  drag,
  expect,
  expectSaved,
  objectsCount,
  openAnnotator,
  readDatasetFile,
  readLabel,
  suffix,
  test,
  type Account,
  type BoxOut,
} from './support'

// Annotating with mouse and keyboard: draw, class picker (filter text and number key), move and resize with
// handles, undo/redo, nudge with arrows, delete, Esc discards a new box, D/A navigation, autosave across
// reload, and the YOLO label file on disk.

const field = (page: Page, name: 'X' | 'Y' | 'W' | 'H') => page.getByRole('textbox', { name, exact: true })

async function fieldValue(page: Page, name: 'X' | 'Y' | 'W' | 'H'): Promise<number> {
  return Number(await field(page, name).inputValue())
}

test('draw, classify, edit and save boxes; the YOLO file matches', async ({ adminApi, actors }, testInfo) => {
  const sfx = suffix(testInfo.retry)
  const annotator: Account = { name: 'Abe Annotator', username: `abe${sfx}`, password: 'boxes-all-the-way' }
  const user = await adminApi.ensureUser(annotator)
  const project = await adminApi.createProject(`Annotate${sfx}`, 'annotate', {
    classes: ['car', 'person'],
    members: [{ user_id: user.id, role: 'annotator' }],
  })
  const [car, person] = project.classes
  const names = datasetImages('annotate')
  const first = await adminApi.image(project.id, names[0]!)
  const second = await adminApi.image(project.id, names[1]!)

  const { page } = await actors.signIn(annotator)
  await openAnnotator(page, project.id, first.id)
  await expect(objectsCount(page, 0)).toBeVisible()
  const picker = page.getByRole('listbox', { name: 'Classes' })

  // ------------------------------------------------------------------ draw A, pick "person" by filtering
  const a1 = await canvasPoint(page, 0.3, 0.3)
  const a2 = await canvasPoint(page, 0.45, 0.5)
  await drag(page, a1, a2)
  await expect(picker).toBeVisible()
  const filter = page.getByRole('combobox', { name: 'Filter classes' })
  await expect(filter).toBeFocused()
  await filter.fill('pers')
  // Only "person" matches (plus the "Create class" entry, annotators may add classes); it is highlighted.
  await expect(picker.getByRole('option', { name: /car/ })).toHaveCount(0)
  await expect(picker.getByRole('option', { selected: true })).toContainText('person')
  await expect(picker.getByRole('option', { name: /Create class “pers”/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(picker).toBeHidden()
  await expect(objectsCount(page, 1)).toBeVisible()

  // ------------------------------------------------------------------ draw B, pick "car" with its number key
  const b1 = await canvasPoint(page, 0.6, 0.62)
  const b2 = await canvasPoint(page, 0.72, 0.78)
  await drag(page, b1, b2)
  await expect(picker).toBeVisible()
  await page.keyboard.press('1')
  await expect(picker).toBeHidden()
  await expect(objectsCount(page, 2)).toBeVisible()

  // ------------------------------------------------------------------ draw C and discard it with Esc
  await drag(page, await canvasPoint(page, 0.12, 0.7), await canvasPoint(page, 0.2, 0.82))
  await expect(picker).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(picker).toBeHidden()
  await expect(objectsCount(page, 2)).toBeVisible()

  await expectSaved(page)
  let boxes = await adminApi.boxes(project.id, first.id)
  expect(boxes).toHaveLength(2)
  const boxA = boxes.find((b) => b.class_id === person!.id)!
  const boxB = boxes.find((b) => b.class_id === car!.id)!
  expect(boxA).toBeTruthy()
  expect(boxB).toBeTruthy()
  // Screen px per image px, from the drawn box.
  const scale = (a2.x - a1.x) / (boxA.x2 - boxA.x1)
  expect(scale).toBeGreaterThan(0.3)
  expect((a2.y - a1.y) / (boxA.y2 - boxA.y1)).toBeCloseTo(scale, 1)

  // ------------------------------------------------------------------ select tool: move A by dragging its body
  await page.keyboard.press('v')
  await expect(page.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true')
  const aCenter = { x: (a1.x + a2.x) / 2, y: (a1.y + a2.y) / 2 }
  await page.mouse.click(aCenter.x, aCenter.y)
  await expect(page.getByRole('toolbar', { name: 'Selected box actions' })).toBeVisible()
  await expect(field(page, 'W')).toBeVisible()
  const x0 = await fieldValue(page, 'X')
  const y0 = await fieldValue(page, 'Y')
  const w0 = await fieldValue(page, 'W')
  const h0 = await fieldValue(page, 'H')
  await drag(page, aCenter, { x: aCenter.x + 40, y: aCenter.y + 24 })
  await expect.poll(() => fieldValue(page, 'X')).toBeCloseTo(x0 + 40 / scale, 0)
  await expect.poll(() => fieldValue(page, 'Y')).toBeCloseTo(y0 + 24 / scale, 0)
  expect(await fieldValue(page, 'W')).toBeCloseTo(w0, 1)

  // ------------------------------------------------------------------ resize with the bottom-right handle
  const corner = { x: a2.x + 40, y: a2.y + 24 }
  await drag(page, corner, { x: corner.x + 30, y: corner.y + 36 })
  await expect.poll(() => fieldValue(page, 'W')).toBeCloseTo(w0 + 30 / scale, 0)
  await expect.poll(() => fieldValue(page, 'H')).toBeCloseTo(h0 + 36 / scale, 0)
  const wResized = await fieldValue(page, 'W')
  const xMoved = await fieldValue(page, 'X')

  // ------------------------------------------------------------------ undo / redo
  await page.keyboard.press('Control+z') // undo the resize
  await expect.poll(() => fieldValue(page, 'W')).toBeCloseTo(w0, 1)
  await page.keyboard.press('Control+z') // undo the move
  await expect.poll(() => fieldValue(page, 'X')).toBeCloseTo(x0, 1)
  await page.keyboard.press('Control+y')
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(() => fieldValue(page, 'W')).toBeCloseTo(wResized, 1)
  expect(await fieldValue(page, 'X')).toBeCloseTo(xMoved, 1)

  // ------------------------------------------------------------------ nudge with arrows (1 px, Shift = 10 px)
  await canvasSurface(page).focus().catch(() => undefined)
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Shift+ArrowDown')
  await expect.poll(() => fieldValue(page, 'X')).toBeCloseTo(xMoved + 3, 1)
  const yNudged = await fieldValue(page, 'Y')
  expect(yNudged).toBeGreaterThan(y0 + 24 / scale + 9)
  expect(page.url()).toContain(`/annotate/${first.id}`) // arrows with a selection never navigate

  // ------------------------------------------------------------------ delete B
  await page.mouse.click((b1.x + b2.x) / 2, (b1.y + b2.y) / 2)
  await expect(page.getByRole('listbox', { name: 'Objects on this image' }).getByRole('option', { selected: true })).toContainText('car')
  await page.keyboard.press('Delete')
  await expect(objectsCount(page, 1)).toBeVisible()
  // Undo the delete, then delete again with the toolbar button.
  await page.keyboard.press('Control+z')
  await expect(objectsCount(page, 2)).toBeVisible()
  await page.mouse.click((b1.x + b2.x) / 2, (b1.y + b2.y) / 2)
  await page.getByRole('toolbar', { name: 'Selected box actions' }).getByRole('button', { name: 'Delete' }).click()
  await expect(objectsCount(page, 1)).toBeVisible()

  // ------------------------------------------------------------------ autosave → server and file on disk
  await expectSaved(page)
  await expect.poll(async () => (await adminApi.boxes(project.id, first.id)).length).toBe(1)
  boxes = await adminApi.boxes(project.id, first.id)
  const saved: BoxOut = boxes[0]!
  expect(saved.class_id).toBe(person!.id)
  // The properties panel shows the saved geometry.
  await page.mouse.click(aCenter.x + 43, aCenter.y + 40)
  expect(await fieldValue(page, 'X')).toBeCloseTo(saved.x1, 0)
  expect(await fieldValue(page, 'W')).toBeCloseTo(saved.x2 - saved.x1, 0)

  const label = readLabel('annotate', names[0]!)
  expect(label).not.toBeNull()
  const lines = label!.trim().split(/\r?\n/)
  expect(lines).toHaveLength(1)
  const [cls, cx, cy, w, h] = lines[0]!.split(' ')
  expect(cls).toBe(String(person!.index)) // YOLO id = class index ("person" is 1)
  expect(lines[0]).toMatch(/^1 \d\.\d{6} \d\.\d{6} \d\.\d{6} \d\.\d{6}$/)
  expect(Number(cx)).toBeCloseTo((saved.x1 + saved.x2) / 2 / 640, 5)
  expect(Number(cy)).toBeCloseTo((saved.y1 + saved.y2) / 2 / 480, 5)
  expect(Number(w)).toBeCloseTo((saved.x2 - saved.x1) / 640, 5)
  expect(Number(h)).toBeCloseTo((saved.y2 - saved.y1) / 480, 5)
  expect(readDatasetFile('annotate', 'classes.txt')?.trim().split(/\r?\n/)).toEqual(['car', 'person'])

  // ------------------------------------------------------------------ D / A navigation (nothing selected)
  await page.keyboard.press('Escape') // clear the selection
  await page.keyboard.press('d')
  await expect(page).toHaveURL(new RegExp(`/annotate/${second.id}$`))
  await expect(objectsCount(page, 0)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Draw box' })).toBeEnabled()
  await page.keyboard.press('a')
  await expect(page).toHaveURL(new RegExp(`/annotate/${first.id}$`))
  await expect(objectsCount(page, 1)).toBeVisible()

  // ------------------------------------------------------------------ reload: still there
  await page.reload()
  await expect(objectsCount(page, 1)).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible()
  const objects = page.getByRole('listbox', { name: 'Objects on this image' }).getByRole('option')
  await expect(objects).toHaveCount(1)
  await expect(objects.first()).toContainText('person')
  // The first image is now in progress, the files panel shows the box count.
  expect((await adminApi.image(project.id, names[0]!)).status).toBe('in_progress')
})
