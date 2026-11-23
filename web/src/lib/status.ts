// Display metadata for image statuses, roles and formats.
import type { ImageStatus, LabelFormat, Role } from './types'

export interface StatusMeta {
  label: string
  /** CSS colour (token) */
  color: string
  /** Tailwind text colour utility */
  text: string
  /** Tailwind background utility */
  bg: string
  description: string
}

export const STATUS_META: Record<ImageStatus, StatusMeta> = {
  todo: {
    label: 'To do',
    color: 'var(--st-todo)',
    text: 'text-st-todo',
    bg: 'bg-st-todo',
    description: 'Not started',
  },
  in_progress: {
    label: 'In progress',
    color: 'var(--st-progress)',
    text: 'text-st-progress',
    bg: 'bg-st-progress',
    description: 'Annotation started',
  },
  review: {
    label: 'In review',
    color: 'var(--st-review)',
    text: 'text-st-review',
    bg: 'bg-st-review',
    description: 'Waiting for a reviewer',
  },
  done: {
    label: 'Done',
    color: 'var(--st-done)',
    text: 'text-st-done',
    bg: 'bg-st-done',
    description: 'Finished',
  },
  rejected: {
    label: 'Rejected',
    color: 'var(--st-rejected)',
    text: 'text-st-rejected',
    bg: 'bg-st-rejected',
    description: 'Sent back to the annotator',
  },
}

/** Order used in progress bars and legends. */
export const STATUS_ORDER: readonly ImageStatus[] = ['done', 'review', 'in_progress', 'rejected', 'todo']

export const ROLE_LABELS: Record<Role, string> = {
  viewer: 'Viewer',
  annotator: 'Annotator',
  reviewer: 'Reviewer',
  manager: 'Manager',
}

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: 'Can view images, labels and stats, chat and comment',
  annotator: 'Can draw boxes, submit images and claim work',
  reviewer: 'Can also approve or reject submitted images',
  manager: 'Can also manage settings, classes, members and assignments',
}

export const FORMAT_LABELS: Record<LabelFormat, string> = {
  yolo: 'YOLO',
  voc: 'VOC',
  coco: 'COCO',
}

export const FORMAT_DESCRIPTIONS: Record<LabelFormat, string> = {
  yolo: 'One .txt per image with normalised boxes, plus classes.txt',
  voc: 'Pascal VOC: one .xml per image with pixel coordinates',
  coco: 'One COCO .json per image (dataset export available)',
}
