import { describe, expect, it } from 'vitest'
import type { ImageStatus, UserBrief } from '@/lib/types'
import { reviewActions } from './reviewActions'

const me: UserBrief = { id: 1, username: 'me', display_name: 'Me', avatar_color: '#000000' }
const other: UserBrief = { id: 2, username: 'bob', display_name: 'Bob', avatar_color: '#000000' }
const annotator = { can_edit: true, can_review: false }
const reviewer = { can_edit: true, can_review: true }
const viewer = { can_edit: false, can_review: false }

const img = (status: ImageStatus, assignee: UserBrief | null = null) => ({ status, assignee, last_editor: null })

describe('reviewActions', () => {
  it('annotators submit todo / in-progress / rejected images', () => {
    for (const s of ['todo', 'in_progress', 'rejected'] as const) expect(reviewActions(img(s), annotator, false, me.id).submit).toBe(true)
    for (const s of ['review', 'done'] as const) expect(reviewActions(img(s), annotator, false, me.id).submit).toBe(false)
  })

  it('labels the submit button by the review setting', () => {
    expect(reviewActions(img('todo'), annotator, true, me.id).submitLabel).toBe('Submit for review')
    expect(reviewActions(img('todo'), annotator, false, me.id).submitLabel).toBe('Mark done')
  })

  it('only reviewers approve or reject, and only in review', () => {
    expect(reviewActions(img('review'), reviewer, true, me.id)).toMatchObject({ approve: true, reject: true })
    expect(reviewActions(img('review'), annotator, true, me.id)).toMatchObject({ approve: false, reject: false })
    expect(reviewActions(img('done'), reviewer, true, me.id)).toMatchObject({ approve: false, reject: false })
  })

  it('reopen: reviewers always, annotators only for their own images', () => {
    expect(reviewActions(img('done', other), reviewer, false, me.id).reopen).toBe(true)
    expect(reviewActions(img('done', me), annotator, false, me.id).reopen).toBe(true)
    expect(reviewActions(img('done', other), annotator, false, me.id).reopen).toBe(false)
    expect(reviewActions(img('in_progress', me), annotator, false, me.id).reopen).toBe(false)
  })

  it('viewers get nothing', () => {
    expect(reviewActions(img('review', me), viewer, true, me.id)).toMatchObject({
      submit: false,
      approve: false,
      reject: false,
      reopen: false,
    })
  })
})
