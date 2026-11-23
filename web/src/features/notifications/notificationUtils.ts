import type { Notification } from '@/lib/types'

/** Deep link for a notification (image → annotator, DM → conversation, project → overview). */
export function notificationHref(n: Notification): string | null {
  if (n.type === 'dm' && n.actor) return `/messages/${n.actor.id}`
  if (n.project && n.image) return `/p/${n.project.id}/annotate/${n.image.id}`
  if (n.project) return `/p/${n.project.id}`
  if (n.actor) return `/messages/${n.actor.id}`
  return null
}

/** Router state for `navigate(href, { state })`: image notifications about a thread open the Comments tab. */
export interface AnnotatorLinkState {
  inspectorTab?: 'comments'
}

const THREAD_TYPES = new Set<Notification['type']>(['comment', 'review_rejected', 'mention'])

export function notificationState(n: Notification): AnnotatorLinkState | undefined {
  return n.image && THREAD_TYPES.has(n.type) ? { inspectorTab: 'comments' } : undefined
}
