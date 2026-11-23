import type { ProjectClass } from '@/lib/types'

export interface ClassOption {
  cls: ProjectClass
  /** 1–9 hotkey (position in the full class list), or null beyond 9. */
  hotkey: number | null
  /** Highlighted match range within the name. */
  match: [number, number] | null
}

/**
 * Classes matching a filter: case-insensitive; names starting with the query first, then other substring
 * matches, each group in class order. Empty query = all classes.
 */
export function filterClasses(classes: readonly ProjectClass[], query: string): ClassOption[] {
  const q = query.trim().toLowerCase()
  const all = classes.map((cls, i) => ({ cls, hotkey: i < 9 ? i + 1 : null }))
  if (!q) return all.map((o) => ({ ...o, match: null }))
  const prefix: ClassOption[] = []
  const contains: ClassOption[] = []
  for (const o of all) {
    const at = o.cls.name.toLowerCase().indexOf(q)
    if (at < 0) continue
    const opt = { ...o, match: [at, at + q.length] as [number, number] }
    if (at === 0) prefix.push(opt)
    else contains.push(opt)
  }
  return [...prefix, ...contains]
}

/** Offer "Create class" when allowed, the query is non-empty and no class has exactly this name. */
export function canCreateClass(classes: readonly ProjectClass[], query: string, allowed: boolean): boolean {
  const q = query.trim()
  if (!allowed || !q || q.length > 100) return false
  return !classes.some((c) => c.name.toLowerCase() === q.toLowerCase())
}
