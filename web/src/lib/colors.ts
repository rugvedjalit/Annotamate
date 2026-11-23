// Class and avatar palettes.

/** 20 distinct colours for classes created without one (docs/frontend.md §3). */
export const CLASS_PALETTE = [
  '#3b82f6',
  '#f97316',
  '#22c55e',
  '#eab308',
  '#a855f7',
  '#ec4899',
  '#14b8a6',
  '#ef4444',
  '#84cc16',
  '#06b6d4',
  '#f59e0b',
  '#8b5cf6',
  '#10b981',
  '#e11d48',
  '#0ea5e9',
  '#d946ef',
  '#65a30d',
  '#fb7185',
  '#6366f1',
  '#facc15',
] as const

/** First palette colour not used yet (cycles when all are used). */
export function nextClassColor(used: readonly string[]): string {
  const taken = new Set(used.map((c) => c.toLowerCase()))
  return CLASS_PALETTE.find((c) => !taken.has(c)) ?? CLASS_PALETTE[used.length % CLASS_PALETTE.length]!
}

/** Avatar colours offered on the account page. */
export const AVATAR_COLORS = [
  '#2b6ca3',
  '#3d8fd6',
  '#0ea5e9',
  '#14b8a6',
  '#22c55e',
  '#5fb37f',
  '#84cc16',
  '#eab308',
  '#f28a2e',
  '#ef4444',
  '#e11d48',
  '#d9468f',
  '#a855f7',
  '#6366f1',
  '#64748b',
  '#78716c',
] as const

export const UNKNOWN_CLASS_COLOR = '#8a93a3'
