import { describe, expect, it } from 'vitest'
import type { Activity, ActivityType } from '@/lib/types'
import { ACTIVITY_ICONS, describeActivity } from './describeActivity'

const ACTIVITY_TYPES_FOR_TEST = Object.keys(ACTIVITY_ICONS) as ActivityType[]

const alice = { id: 1, username: 'alice', display_name: 'Alice', avatar_color: '#3b82f6' }
const bob = { id: 2, username: 'bob', display_name: 'Bob', avatar_color: '#f97316' }
const image = { id: 9, filename: 'frame_01.jpg' }

function act(type: ActivityType, data: Record<string, unknown>, withImage = true): Activity {
  return { id: 1, type, user: alice, image: withImage ? image : null, data, created_at: '2026-11-23T10:00:00Z' }
}

/** Sentence as rendered by the feed: "<before> <image> <after>". */
function sentence(a: Activity): string {
  const { before, after } = describeActivity(a)
  let s = before
  if (a.image) s += ` ${a.image.filename}`
  if (after) s += /^[,.:;]/.test(after) ? after : ` ${after}`
  return s
}

// Shapes recorded by the server (annotamate/server/services/*: notify.record calls).
describe('describeActivity', () => {
  it.each<[string, Activity, string]>([
    ['save', act('annotation_saved', { box_count: 6, saves: 3 }), 'saved 6 boxes on frame_01.jpg'],
    ['save 1', act('annotation_saved', { box_count: 1, saves: 1 }), 'saved 1 box on frame_01.jpg'],
    ['submit for review', act('status_changed', { from: 'in_progress', to: 'review', action: 'submit' }), 'submitted frame_01.jpg for review'],
    ['submit as done', act('status_changed', { from: 'todo', to: 'done', action: 'submit' }), 'submitted frame_01.jpg as done'],
    ['approve', act('status_changed', { from: 'review', to: 'done', action: 'approve' }), 'approved frame_01.jpg'],
    [
      'reject',
      act('status_changed', { from: 'review', to: 'rejected', action: 'reject', comment: 'Too loose' }),
      'rejected frame_01.jpg: “Too loose”',
    ],
    ['reopen', act('status_changed', { from: 'done', to: 'in_progress', action: 'reopen' }), 'reopened frame_01.jpg'],
    ['bulk status', act('status_changed', { to: 'done', count: 12, action: 'set_status' }, false), 'set 12 images to Done'],
    ['assign one', act('assigned', { assignee: bob }), 'assigned frame_01.jpg to Bob'],
    ['unassign one', act('assigned', { assignee: null }), 'unassigned frame_01.jpg'],
    ['claim', act('assigned', { assignee: alice, claimed: true }), 'claimed frame_01.jpg'],
    ['bulk assign', act('assigned', { count: 40, assignee: bob }, false), 'assigned 40 images to Bob'],
    ['bulk unassign', act('assigned', { count: 3, assignee: null }, false), 'unassigned 3 images'],
    [
      'distribute',
      act('assigned', { count: 5, distribution: [{ user: alice, count: 3 }, { user: bob, count: 2 }] }, false),
      'distributed 5 images between Alice (3) and Bob (2)',
    ],
    ['flag', act('flagged', { flagged: true }), 'flagged frame_01.jpg'],
    ['unflag', act('flagged', { flagged: false }), 'removed the flag from frame_01.jpg'],
    ['bulk flag', act('flagged', { count: 4, flagged: true }, false), 'flagged 4 images'],
    ['comment', act('comment_added', { comment_id: 3, preview: 'Is this a car?' }), 'commented on frame_01.jpg: “Is this a car?”'],
    ['class added', act('class_added', { class_id: 4, name: 'truck', color: '#ffffff' }, false), 'added the class “truck”'],
    [
      'class renamed',
      act('class_updated', { class_id: 4, name: 'lorry', old_name: 'truck' }, false),
      'renamed the class “truck” to “lorry”',
    ],
    ['class recoloured', act('class_updated', { class_id: 4, name: 'truck', color: '#123456' }, false), 'changed the colour of the class “truck”'],
    [
      'class deleted',
      act('class_deleted', { class_id: 4, name: 'truck', strategy: 'delete_boxes', rewritten_files: 2 }, false),
      'deleted the class “truck” and its boxes (2 label files updated)',
    ],
    [
      'class merged',
      act('class_deleted', { class_id: 4, name: 'truck', strategy: 'merge', merge_into: 1, merge_into_name: 'car', rewritten_files: 1 }, false),
      'merged the class “truck” into “car” (1 label file updated)',
    ],
    [
      'class delete failed',
      act('class_delete_failed', { class_id: 4, name: 'truck', strategy: 'forbid', error: 'The class is still used in 3 images.', code: 'in_use' }, false),
      'could not delete the class “truck”: The class is still used in 3 images.',
    ],
    [
      'class merge failed',
      act(
        'class_delete_failed',
        { class_id: 4, name: 'truck', strategy: 'merge', merge_into: 1, merge_into_name: 'car', error: 'The server restarted.', code: 'interrupted' },
        false,
      ),
      'could not merge the class “truck” into “car”: The server restarted.',
    ],
    ['member added', act('member_added', { member: bob, role: 'reviewer' }, false), 'added Bob as reviewer'],
    [
      'member role',
      act('member_updated', { member: bob, role: 'manager', previous_role: 'annotator' }, false),
      'changed Bob’s role from annotator to manager',
    ],
    ['member removed', act('member_removed', { member: bob, role: 'viewer' }, false), 'removed Bob from the project'],
    ['upload', act('images_uploaded', { count: 7 }, false), 'uploaded 7 images'],
    ['created', act('project_created', { name: 'Street cams' }, false), 'created the project'],
    ['archived', act('project_updated', { changes: ['archived'], values: { archived: true } }, false), 'archived the project'],
    ['restored', act('project_updated', { changes: ['archived'], values: { archived: false } }, false), 'restored the project from the archive'],
    [
      'settings',
      act('project_updated', { changes: ['name', 'description', 'require_review'], values: { name: 'Cams', require_review: true } }, false),
      'renamed the project to “Cams”, turned on required review and changed the project description',
    ],
    ['rescan', act('rescanned', { added: 3, removed: 1, total: 120 }, false), 'rescanned the folder (3 new, 1 removed)'],
    ['rescan nothing', act('rescanned', { added: 0, removed: 0, total: 120 }, false), 'rescanned the folder (no changes)'],
    ['restore', act('revision_restored', { revision_id: 8, box_count: 2 }), 'restored an earlier version of frame_01.jpg (2 boxes)'],
  ])('%s', (_name, a, expected) => {
    expect(sentence(a)).toBe(expected)
  })

  it('never fails on unexpected data (every type has a fallback sentence)', () => {
    for (const type of ACTIVITY_TYPES_FOR_TEST) {
      for (const data of [{}, { count: 'x', member: 5, distribution: 'nope', values: null }]) {
        const d = describeActivity(act(type, data))
        expect(d.before.length).toBeGreaterThan(0)
        expect(d.before).not.toMatch(/undefined|null|NaN|\[object/)
      }
    }
  })
})
