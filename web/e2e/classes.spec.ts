import fs from 'node:fs'
import { ADMIN, datasetImages, expect, labelFile, readDatasetFile, readLabel, signInApi, suffix, test } from './support'

// Deleting a class is a background job on the server: the request returns at once, the dialog shows the
// progress, the result arrives over the WebSocket and the label files are renumbered on disk.

test('delete a class: refused while in use, then removed with its boxes in the background', async ({ page, adminApi, guard }, testInfo) => {
  test.setTimeout(90_000)
  guard.allow(/status of 409/) // the deliberate refusal below
  const sfx = suffix(testInfo.retry)
  const names = datasetImages('classes')
  // Every image has one "car" (index 0) and one "tree" (index 2); written fresh so a retry starts the same.
  for (const name of names) fs.writeFileSync(labelFile('classes', name), '0 0.5 0.5 0.2 0.2\n2 0.3 0.3 0.1 0.1\n')
  const project = await adminApi.createProject(`Classes${sfx}`, 'classes', { classes: ['car', 'person', 'tree'] })

  await signInApi(page, ADMIN)
  await page.goto(`/p/${project.id}/settings/classes`)
  const list = page.getByRole('region', { name: 'Class list' })
  await expect(list).toContainText('tree')

  // "Only if unused" on a class that is used: the server answers at once and nothing is started.
  await page.getByRole('button', { name: 'Delete car' }).click()
  const dialog = page.getByRole('dialog', { name: /Delete class/ })
  await dialog.getByRole('radio', { name: /Only if unused/ }).click()
  await dialog.getByRole('button', { name: 'Delete class' }).click()
  await expect(dialog.getByRole('alert')).toContainText(`still used in ${names.length} images`)
  expect((await adminApi.get<{ class_migration: unknown }>(`projects/${project.id}`)).class_migration).toBeNull()

  // "Delete its boxes": accepted, runs as a job, and the result is announced when it has finished.
  await dialog.getByRole('radio', { name: /Delete its boxes/ }).click()
  await dialog.getByRole('button', { name: 'Delete class' }).click()
  await expect(page.getByText('Deleted class “car”')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(`${names.length} label files rewritten.`)).toBeVisible()
  await expect(dialog).toBeHidden()
  await expect(list).not.toContainText('car')
  await expect(page.getByRole('button', { name: 'Delete person' })).toBeVisible()

  // On disk: the boxes of "car" are gone and "tree" moved from index 2 to 1.
  for (const name of names) expect(readLabel('classes', name)).toBe('1 0.3 0.3 0.1 0.1\n')
  expect(readDatasetFile('classes', 'classes.txt')?.trim().split(/\r?\n/)).toEqual(['person', 'tree'])
  const after = await adminApi.get<{ class_migration: unknown; classes: { name: string }[] }>(`projects/${project.id}`)
  expect(after.class_migration).toBeNull()
  expect(after.classes.map((c) => c.name)).toEqual(['person', 'tree'])
  const activity = (await adminApi.get<{ items: { type: string; data: Record<string, unknown> }[] }>(`projects/${project.id}/activity`)).items
  expect(activity[0]).toMatchObject({ type: 'class_deleted', data: { name: 'car', strategy: 'delete_boxes', rewritten_files: names.length } })
})
