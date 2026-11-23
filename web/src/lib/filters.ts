// Image list filters: shared by the files panel, the images table, neighbours and bulk actions.
import type { ImageFilterQuery, ImageStatus } from './types'
import { IMAGE_STATUSES } from './types'

export interface ImageFilters {
  q?: string
  status?: ImageStatus[]
  /** 'me' | 'none' | user id */
  assignee?: 'me' | 'none' | number
  flagged?: boolean
  class_id?: number
  has_comments?: 'open' | 'any'
  sort?: 'name' | 'updated'
}

/** Canonical API query (stable key order, empty values dropped) for requests and query keys. */
export function toFilterQuery(f: ImageFilters): ImageFilterQuery {
  const out: ImageFilterQuery = {}
  if (f.q?.trim()) out.q = f.q.trim()
  if (f.status?.length) out.status = [...f.status].sort().join(',')
  if (f.assignee !== undefined) out.assignee = String(f.assignee)
  if (f.flagged !== undefined) out.flagged = f.flagged ? 'true' : 'false'
  if (f.class_id !== undefined) out.class_id = f.class_id
  if (f.has_comments) out.has_comments = f.has_comments
  if (f.sort && f.sort !== 'name') out.sort = f.sort
  return out
}

const FILTER_KEYS = ['q', 'status', 'assignee', 'flagged', 'class_id', 'has_comments', 'sort'] as const

/** Parse filters from URL search params (the annotator and images table keep filters in the URL). */
export function filtersFromParams(params: URLSearchParams): ImageFilters {
  const f: ImageFilters = {}
  const q = params.get('q')
  if (q) f.q = q
  const status = params.get('status')
  if (status) {
    const list = status.split(',').filter((s): s is ImageStatus => (IMAGE_STATUSES as readonly string[]).includes(s))
    if (list.length) f.status = list
  }
  const assignee = params.get('assignee')
  if (assignee === 'me' || assignee === 'none') f.assignee = assignee
  else if (assignee && /^\d+$/.test(assignee)) f.assignee = Number(assignee)
  const flagged = params.get('flagged')
  if (flagged === 'true') f.flagged = true
  else if (flagged === 'false') f.flagged = false
  const classId = params.get('class_id')
  if (classId && /^\d+$/.test(classId)) f.class_id = Number(classId)
  const comments = params.get('has_comments')
  if (comments === 'open' || comments === 'any') f.has_comments = comments
  if (params.get('sort') === 'updated') f.sort = 'updated'
  return f
}

/** Write filters into search params, keeping unrelated params. */
export function filtersToParams(f: ImageFilters, base?: URLSearchParams): URLSearchParams {
  const params = new URLSearchParams(base)
  for (const k of FILTER_KEYS) params.delete(k)
  for (const [k, v] of Object.entries(toFilterQuery(f))) params.set(k, String(v))
  return params
}

export function hasActiveFilters(f: ImageFilters): boolean {
  const q = toFilterQuery(f)
  delete q.sort
  return Object.keys(q).length > 0
}
