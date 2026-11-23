import type { ImageItem, Permissions } from '@/lib/types'

export interface AvailableReviewActions {
  submit: boolean
  approve: boolean
  reject: boolean
  reopen: boolean
  submitLabel: string
  submitHint: string
}

/** Which workflow buttons to show (docs/architecture.md §6; the server enforces the same rules). */
export function reviewActions(
  image: Pick<ImageItem, 'status' | 'assignee' | 'last_editor'>,
  perms: Pick<Permissions, 'can_edit' | 'can_review'>,
  requireReview: boolean,
  meId: number,
): AvailableReviewActions {
  const s = image.status
  const owns = image.assignee?.id === meId || image.last_editor?.id === meId
  return {
    submit: perms.can_edit && (s === 'todo' || s === 'in_progress' || s === 'rejected'),
    approve: perms.can_review && s === 'review',
    reject: perms.can_review && s === 'review',
    reopen: (s === 'done' || s === 'review') && (perms.can_review || (perms.can_edit && owns)),
    submitLabel: requireReview ? 'Submit for review' : 'Mark done',
    submitHint: requireReview ? 'Send this image to a reviewer' : 'Mark this image as done',
  }
}
