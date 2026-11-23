import fs from 'node:fs'
import type { Page } from '@playwright/test'
import { ADMIN, datasetImages, expect, readLabel, readZip, signInApi, suffix, test } from './support'

// Export: the YOLO zip download from the Images page contains data.yaml, classes.txt and one label file per
// annotated image (identical to the files on disk); "Done only" narrows it to finished images.

async function downloadZip(page: Page, scope: 'All images' | 'Done only'): Promise<{ name: string; entries: Map<string, Buffer> }> {
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const popover = page.getByRole('dialog').filter({ hasText: 'Export labels' })
  await expect(popover).toBeVisible()
  await expect(popover.getByRole('combobox', { name: 'Export format' })).toHaveText(/YOLO/)
  await popover.getByRole('radio', { name: scope }).click()
  const [download] = await Promise.all([page.waitForEvent('download'), popover.getByRole('link', { name: 'Download zip' }).click()])
  const file = await download.path()
  return { name: download.suggestedFilename(), entries: readZip(fs.readFileSync(file)) }
}

test('YOLO export zip contains data.yaml, classes.txt and the labels', async ({ page, adminApi }, testInfo) => {
  const sfx = suffix(testInfo.retry)
  const project = await adminApi.createProject(`Export${sfx}`, 'export', { classes: ['car', 'person'] })
  const [car, person] = project.classes
  const names = datasetImages('export')
  const images = await Promise.all(names.map((n) => adminApi.image(project.id, n)))
  // Two annotated images (one of them finished), one untouched.
  await adminApi.put(`projects/${project.id}/images/${images[0]!.id}/annotation`, {
    base_version: null,
    boxes: [
      { id: crypto.randomUUID(), class_id: car!.id, raw_label: null, x1: 80, y1: 260, x2: 260, y2: 370 },
      { id: crypto.randomUUID(), class_id: person!.id, raw_label: null, x1: 380, y1: 200, x2: 450, y2: 360 },
    ],
  })
  await adminApi.put(`projects/${project.id}/images/${images[1]!.id}/annotation`, {
    base_version: null,
    boxes: [{ id: crypto.randomUUID(), class_id: person!.id, raw_label: null, x1: 10, y1: 10, x2: 74, y2: 58 }],
  })
  await adminApi.post(`projects/${project.id}/images/${images[1]!.id}/status`, { action: 'submit' })

  await signInApi(page, ADMIN)
  await page.goto(`/p/${project.id}/images`)

  // ------------------------------------------------------------------ all annotated images
  const all = await downloadZip(page, 'All images')
  expect(all.name).toMatch(/\.zip$/)
  expect([...all.entries.keys()].sort()).toEqual(['classes.txt', 'data.yaml', 'labels/frame_0001.txt', 'labels/frame_0002.txt'])
  expect(all.entries.get('classes.txt')!.toString('utf8').trim().split(/\r?\n/)).toEqual(['car', 'person'])
  const yaml = all.entries.get('data.yaml')!.toString('utf8')
  expect(yaml).toContain('nc: 2')
  expect(yaml).toMatch(/names:\s*\n\s+0: "car"\s*\n\s+1: "person"/)
  for (const n of names.slice(0, 2)) {
    expect(all.entries.get(`labels/${n.replace('.png', '.txt')}`)!.toString('utf8')).toBe(readLabel('export', n))
  }
  const first = all.entries.get('labels/frame_0001.txt')!.toString('utf8').trim().split(/\r?\n/)
  expect(first).toEqual(['0 0.265625 0.656250 0.281250 0.229167', '1 0.648438 0.583333 0.109375 0.333333'])

  // ------------------------------------------------------------------ done only
  const done = await downloadZip(page, 'Done only')
  expect([...done.entries.keys()].sort()).toEqual(['classes.txt', 'data.yaml', 'labels/frame_0002.txt'])
})
