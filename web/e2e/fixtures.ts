// Test fixtures for the end-to-end run: a dataset folder with a few generated PNGs and an empty data dir.
// Generated without dependencies (zlib + a tiny PNG encoder) so the run is hermetic.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

export interface E2EDirs {
  /** Passed to the server as --root (contains `dataset/`). */
  root: string
  /** Fresh --data-dir (empty database → the setup screen is shown). */
  data: string
  /** Fresh --data-dir of the second server, served under {@link SUBPATH}. */
  dataSubpath: string
}

/** URL prefix of the second e2e server (reverse-proxy deployment). */
export const SUBPATH = '/annotamate/'

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(typeAndData) >>> 0)
  return Buffer.concat([len, typeAndData, crc])
}

/** A simple RGB PNG: a gradient "sky" with two coloured rectangles (something to box). */
export function makePng(width: number, height: number, seed: number): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  const rects = [
    { x: 80 + seed * 20, y: 260, w: 180, h: 110, c: [178, 53, 53] },
    { x: 380, y: 200 - seed * 10, w: 70, h: 160, c: [47, 93, 138] },
  ]
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      let r = 110 + Math.round((y / height) * 110)
      let g = 140 + Math.round((y / height) * 90)
      let b = 190 + Math.round((y / height) * 40)
      if (y > height * 0.6) [r, g, b] = [74, 79, 87]
      for (const rc of rects) {
        if (x >= rc.x && x < rc.x + rc.w && y >= rc.y && y < rc.y + rc.h) [r, g, b] = rc.c as [number, number, number]
      }
      const i = row + 1 + x * 3
      raw[i] = r
      raw[i + 1] = g
      raw[i + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: RGB
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export const DATASET_DIR = 'dataset'
export const IMAGE_NAMES = ['frame_0001.png', 'frame_0002.png', 'frame_0003.png']

/** `frame_0001.png` … `frame_000N.png` (natural order = creation order). */
export function imageNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `frame_${String(i + 1).padStart(4, '0')}.png`)
}

/**
 * One folder per spec so label files written next to the images never leak between specs
 * (folder name → number of images).
 */
export const DATASETS = {
  [DATASET_DIR]: IMAGE_NAMES.length, // smoke
  roles: 3,
  annotate: 4,
  locks: 3,
  review: 3,
  comms: 3,
  assign: 6,
  export: 3,
  screens: 5,
  subpath: 3,
  manage: 2,
} as const

export type DatasetName = keyof typeof DATASETS

const RUN_PREFIX = 'annotamate-e2e-'
const STALE_AFTER_MS = 60 * 60 * 1000

/**
 * Remove the directories of earlier runs (the servers keep a run's database open until Playwright stops them,
 * so a run cannot delete its own; the next run does). Recent ones are kept in case runs overlap.
 */
function removeStaleRuns(): void {
  const tmp = os.tmpdir()
  for (const name of fs.readdirSync(tmp)) {
    if (!name.startsWith(RUN_PREFIX)) continue
    const dir = path.join(tmp, name)
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > STALE_AFTER_MS) fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // in use or already gone
    }
  }
}

/**
 * One fresh directory per test run. The path travels through ANNOTAMATE_E2E_DIR so the Playwright runner
 * and its workers (which re-evaluate the config) agree on it.
 */
export function prepareE2EDirs(): E2EDirs {
  let base = process.env.ANNOTAMATE_E2E_DIR
  if (!base) {
    removeStaleRuns()
    base = fs.mkdtempSync(path.join(os.tmpdir(), RUN_PREFIX))
    process.env.ANNOTAMATE_E2E_DIR = base
  }
  const root = path.join(base, 'root')
  const data = path.join(base, 'data')
  const dataSubpath = path.join(base, 'data-subpath')
  fs.mkdirSync(data, { recursive: true })
  fs.mkdirSync(dataSubpath, { recursive: true })
  for (const [folder, count] of Object.entries(DATASETS)) {
    const dataset = path.join(root, folder)
    fs.mkdirSync(dataset, { recursive: true })
    imageNames(count).forEach((name, i) => {
      const file = path.join(dataset, name)
      if (!fs.existsSync(file)) fs.writeFileSync(file, makePng(640, 480, i))
    })
  }
  return { root, data, dataSubpath }
}

/** Absolute path of a dataset folder of this run. */
export function datasetDir(name: DatasetName): string {
  return path.join(prepareE2EDirs().root, name)
}
