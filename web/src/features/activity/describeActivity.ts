// Human-readable descriptions for project activity entries (data shapes: docs/api.md, "Activity data").
import {
  CircleCheck,
  Flag,
  FolderPlus,
  History,
  MessageSquare,
  Pencil,
  RefreshCw,
  Save,
  Settings2,
  Tag,
  Trash2,
  Upload,
  UserMinus,
  UserPlus,
  UserRoundCog,
  ClipboardList,
  type LucideIcon,
} from 'lucide-react'
import type { Activity, ActivityType, ImageStatus, Role, UserBrief } from '@/lib/types'
import { IMAGE_STATUSES, ROLES } from '@/lib/types'
import { ROLE_LABELS, STATUS_META } from '@/lib/status'
import { formatNumber } from '@/lib/format'

/**
 * Sentence parts around the (optional) image link:
 * "<actor> {before} <image> {after}", e.g. "Alice | saved 6 boxes on | frame_01.jpg".
 * `after` may start with punctuation (": “reason”"), which is rendered without a leading space.
 */
export interface ActivityDescription {
  before: string
  after?: string
}

function num(data: Record<string, unknown>, key: string): number | null {
  const v = data[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function str(data: Record<string, unknown>, key: string): string | null {
  const v = data[key]
  return typeof v === 'string' && v ? v : null
}

function bool(data: Record<string, unknown>, key: string): boolean | null {
  const v = data[key]
  return typeof v === 'boolean' ? v : null
}

function user(data: Record<string, unknown>, key: string): UserBrief | null {
  const v = data[key]
  if (!v || typeof v !== 'object') return null
  const u = v as Partial<UserBrief>
  return typeof u.id === 'number' && typeof u.display_name === 'string' ? (u as UserBrief) : null
}

function status(data: Record<string, unknown>, key: string): string | null {
  const v = str(data, key)
  if (!v) return null
  return (IMAGE_STATUSES as readonly string[]).includes(v) ? STATUS_META[v as ImageStatus].label : v
}

function role(data: Record<string, unknown>, key: string): string | null {
  const v = str(data, key)
  if (!v) return null
  return ((ROLES as readonly string[]).includes(v) ? ROLE_LABELS[v as Role] : v).toLowerCase()
}

function images(n: number): string {
  return `${formatNumber(n)} ${n === 1 ? 'image' : 'images'}`
}

function quote(text: string, max = 80): string {
  const t = text.trim()
  return `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`
}

/** "Alice", "Alice and Bob", "Alice, Bob and Carol", "Alice, Bob and 3 others". */
function list(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`
}

function distribution(data: Record<string, unknown>): { user: UserBrief; count: number }[] {
  const v = data.distribution
  if (!Array.isArray(v)) return []
  const out: { user: UserBrief; count: number }[] = []
  for (const entry of v) {
    if (!entry || typeof entry !== 'object') continue
    const u = user(entry as Record<string, unknown>, 'user')
    const count = num(entry as Record<string, unknown>, 'count')
    if (u && count !== null && count > 0) out.push({ user: u, count })
  }
  return out
}

/** Labels for changed project fields that have no value to show. */
const PROJECT_FIELDS: Record<string, string> = {
  name: 'name',
  description: 'description',
  label_dir: 'label folder',
}

function projectUpdate(d: Record<string, unknown>): string {
  const changes = Array.isArray(d.changes) ? d.changes.filter((c): c is string => typeof c === 'string') : []
  const values = d.values && typeof d.values === 'object' ? (d.values as Record<string, unknown>) : {}
  const parts: string[] = []
  const name = str(values, 'name')
  if (name) parts.push(`renamed the project to ${quote(name)}`)
  const review = bool(values, 'require_review')
  if (review !== null) parts.push(review ? 'turned on required review' : 'turned off required review')
  const restrict = bool(values, 'restrict_to_assigned')
  if (restrict !== null) parts.push(restrict ? 'limited editing to assigned images' : 'let annotators edit any image')
  const addClasses = bool(values, 'annotators_can_add_classes')
  if (addClasses !== null) parts.push(addClasses ? 'let annotators add classes' : 'stopped annotators from adding classes')
  const exif = str(values, 'exif_mode')
  if (exif) parts.push(`set EXIF orientation to “${exif}”`)
  const recursive = bool(values, 'recursive')
  if (recursive !== null) parts.push(recursive ? 'turned on sub-folder scanning' : 'turned off sub-folder scanning')
  const archived = bool(values, 'archived')
  if (archived !== null) parts.push(archived ? 'archived the project' : 'restored the project from the archive')
  const other = changes.filter((c) => !(c in values)).map((c) => PROJECT_FIELDS[c] ?? c.replace(/_/g, ' '))
  if (other.length) parts.push(`changed the project ${list(other)}`)
  if (parts.length === 0) return 'updated the project settings'
  return list(parts)
}

/** One sentence per activity type, from the data the server records. */
export function describeActivity(a: Activity): ActivityDescription {
  const d = a.data ?? {}
  const hasImage = !!a.image
  switch (a.type) {
    case 'annotation_saved': {
      const boxes = num(d, 'box_count')
      const what = boxes === null ? 'saved annotations on' : `saved ${formatNumber(boxes)} ${boxes === 1 ? 'box' : 'boxes'} on`
      return hasImage ? { before: what } : { before: what.replace(/ on$/, '') }
    }
    case 'status_changed': {
      const to = status(d, 'to')
      const action = str(d, 'action')
      if (!hasImage || action === 'set_status') {
        // Bulk status change from the images table: {to, count, action: 'set_status'}.
        const n = num(d, 'count') ?? 1
        return { before: to ? `set ${images(n)} to ${to}` : `changed the status of ${images(n)}` }
      }
      const comment = str(d, 'comment')
      if (action === 'submit') return { before: 'submitted', after: str(d, 'to') === 'review' ? 'for review' : 'as done' }
      if (action === 'approve') return { before: 'approved' }
      if (action === 'reject') return comment ? { before: 'rejected', after: `: ${quote(comment)}` } : { before: 'rejected' }
      if (action === 'reopen') return { before: 'reopened' }
      const from = status(d, 'from')
      return { before: 'moved', after: to ? (from ? `from ${from} to ${to}` : `to ${to}`) : undefined }
    }
    case 'assigned': {
      const count = num(d, 'count')
      const split = distribution(d)
      if (split.length > 0) {
        // Distribute: {count, distribution: [{user, count}]}.
        const total = count ?? split.reduce((sum, s) => sum + s.count, 0)
        const names = list(split.map((s) => `${s.user.display_name} (${formatNumber(s.count)})`))
        return { before: `distributed ${images(total)} ${split.length === 1 ? 'to' : 'between'} ${names}` }
      }
      const assignee = user(d, 'assignee')
      if (hasImage && count === null) {
        if (bool(d, 'claimed') && assignee) return { before: 'claimed' }
        return assignee ? { before: 'assigned', after: `to ${assignee.display_name}` } : { before: 'unassigned' }
      }
      const n = count ?? 0
      return assignee ? { before: `assigned ${images(n)} to ${assignee.display_name}` } : { before: `unassigned ${images(n)}` }
    }
    case 'flagged': {
      const flagged = bool(d, 'flagged') ?? true
      const count = num(d, 'count')
      if (hasImage && count === null) return { before: flagged ? 'flagged' : 'removed the flag from' }
      const n = count ?? 1
      return { before: flagged ? `flagged ${images(n)}` : `removed the flag from ${images(n)}` }
    }
    case 'comment_added': {
      const preview = str(d, 'preview')
      if (!hasImage) return { before: preview ? `commented ${quote(preview)}` : 'added a comment' }
      return preview ? { before: 'commented on', after: `: ${quote(preview)}` } : { before: 'commented on' }
    }
    case 'class_added': {
      const name = str(d, 'name')
      return { before: name ? `added the class ${quote(name)}` : 'added a class' }
    }
    case 'class_updated': {
      const name = str(d, 'name')
      const old = str(d, 'old_name')
      const recolored = str(d, 'color') !== null
      if (old && name && old !== name) {
        return { before: `renamed the class ${quote(old)} to ${quote(name)}${recolored ? ' and changed its colour' : ''}` }
      }
      if (recolored) return { before: name ? `changed the colour of the class ${quote(name)}` : 'changed a class colour' }
      return { before: name ? `updated the class ${quote(name)}` : 'updated a class' }
    }
    case 'class_deleted': {
      const name = str(d, 'name')
      const into = str(d, 'merge_into_name')
      const rewritten = num(d, 'rewritten_files')
      const files = rewritten ? ` (${formatNumber(rewritten)} label ${rewritten === 1 ? 'file' : 'files'} updated)` : ''
      if (name && into) return { before: `merged the class ${quote(name)} into ${quote(into)}${files}` }
      if (!name) return { before: 'deleted a class' }
      const boxes = str(d, 'strategy') === 'delete_boxes' ? ' and its boxes' : ''
      return { before: `deleted the class ${quote(name)}${boxes}${files}` }
    }
    case 'member_added': {
      const u = user(d, 'member')
      const r = role(d, 'role')
      return { before: `added ${u?.display_name ?? 'a member'}${r ? ` as ${r}` : ''}` }
    }
    case 'member_updated': {
      const u = user(d, 'member')
      const r = role(d, 'role')
      const prev = role(d, 'previous_role')
      const whose = u ? `${u.display_name}’s` : 'a member’s'
      if (r && prev) return { before: `changed ${whose} role from ${prev} to ${r}` }
      return { before: r ? `changed ${whose} role to ${r}` : `updated ${u?.display_name ?? 'a member'}` }
    }
    case 'member_removed': {
      const u = user(d, 'member')
      return { before: `removed ${u?.display_name ?? 'a member'} from the project` }
    }
    case 'images_uploaded': {
      const count = num(d, 'count')
      return { before: count === null ? 'uploaded images' : `uploaded ${images(count)}` }
    }
    case 'project_created':
      return { before: 'created the project' }
    case 'project_updated':
      return { before: projectUpdate(d) }
    case 'rescanned': {
      const added = num(d, 'added')
      const removed = num(d, 'removed')
      const parts: string[] = []
      if (added) parts.push(`${formatNumber(added)} new`)
      if (removed) parts.push(`${formatNumber(removed)} removed`)
      return { before: parts.length ? `rescanned the folder (${parts.join(', ')})` : 'rescanned the folder (no changes)' }
    }
    case 'revision_restored': {
      const boxes = num(d, 'box_count')
      const what = boxes === null ? undefined : `(${formatNumber(boxes)} ${boxes === 1 ? 'box' : 'boxes'})`
      return hasImage
        ? { before: 'restored an earlier version of', after: what }
        : { before: what ? `restored an earlier version ${what}` : 'restored an earlier version' }
    }
    default:
      return { before: 'made a change' }
  }
}

export const ACTIVITY_ICONS: Record<ActivityType, LucideIcon> = {
  annotation_saved: Save,
  status_changed: CircleCheck,
  assigned: ClipboardList,
  flagged: Flag,
  comment_added: MessageSquare,
  class_added: Tag,
  class_updated: Pencil,
  class_deleted: Trash2,
  member_added: UserPlus,
  member_updated: UserRoundCog,
  member_removed: UserMinus,
  images_uploaded: Upload,
  project_created: FolderPlus,
  project_updated: Settings2,
  rescanned: RefreshCw,
  revision_restored: History,
}
