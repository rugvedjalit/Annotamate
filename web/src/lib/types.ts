// API types, mirroring docs/api.md exactly (snake_case on the wire).

export type Role = 'viewer' | 'annotator' | 'reviewer' | 'manager'
export type ImageStatus = 'todo' | 'in_progress' | 'review' | 'done' | 'rejected'
export type LabelFormat = 'yolo' | 'voc' | 'coco'

export const IMAGE_STATUSES: readonly ImageStatus[] = ['todo', 'in_progress', 'review', 'done', 'rejected']
export const ROLES: readonly Role[] = ['viewer', 'annotator', 'reviewer', 'manager']
export const LABEL_FORMATS: readonly LabelFormat[] = ['yolo', 'voc', 'coco']

export interface ApiErrorBody {
  detail: string
  code: string
  [extra: string]: unknown
}

export interface UserBrief {
  id: number
  username: string
  display_name: string
  avatar_color: string
}

export interface User extends UserBrief {
  email: string | null
  is_admin: boolean
  is_active: boolean
  created_at: string
  last_seen_at: string | null
}

/** Admin view of an account (what `GET /users` returns to administrators). */
export type UserWithPresence = User & { online: boolean }

/** What every signed-in user sees in the people lists (pickers, DMs): no email, no admin flag. */
export type UserListItem = UserBrief & { online: boolean }

export interface ProjectSettings {
  require_review: boolean
  restrict_to_assigned: boolean
  annotators_can_add_classes: boolean
  exif_mode: 'apply' | 'ignore'
  recursive: boolean
}

export interface ProjectClass {
  id: number
  index: number
  name: string
  color: string
}

export type StatusCounts = Record<ImageStatus, number>

export interface Permissions {
  can_edit: boolean
  can_review: boolean
  can_manage: boolean
  can_add_classes: boolean
  can_delete: boolean
}

export interface ProjectSummary {
  id: number
  name: string
  description: string
  label_format: LabelFormat
  image_count: number
  status_counts: StatusCounts
  member_count: number
  my_role: Role | null
  my_assigned_todo: number
  unread_chat: number
  archived: boolean
  indexing: boolean
  /** Images whose file disappeared from disk (hidden everywhere until the file returns or they are removed). */
  missing_count: number
  created_at: string
  updated_at: string
  /** Up to 5 members for the project card (managers first, then by name). */
  members_preview: UserBrief[]
}

export interface Member {
  user: UserBrief
  role: Role
  joined_at: string
  assigned_count: number
  done_count: number
  last_seen_at: string | null
}

export interface Project extends ProjectSummary {
  image_dir: string
  label_dir: string | null
  settings: ProjectSettings
  classes: ProjectClass[]
  members: Member[]
  permissions: Permissions
}

export interface ImageRef {
  id: number
  filename: string
}

export interface ImageItem {
  id: number
  filename: string
  rel_path: string
  position: number
  status: ImageStatus
  box_count: number
  class_ids: number[]
  assignee: UserBrief | null
  flagged: boolean
  comment_count: number
  open_comment_count: number
  last_editor: UserBrief | null
  updated_at: string | null
}

export interface ImageDetail extends ImageItem {
  width: number | null
  height: number | null
  error: string | null
  label_path: string
  file_url: string
}

export interface Box {
  id: string
  class_id: number | null
  raw_label: string | null
  x1: number
  y1: number
  x2: number
  y2: number
  difficult?: boolean
  truncated?: boolean
}

export interface AnnotationDoc {
  version: string | null
  boxes: Box[]
  readonly_reason: string | null
  updated_at: string | null
  updated_by: UserBrief | null
}

export interface ChatMessage {
  id: number
  project_id: number
  user: UserBrief
  body: string
  image: ImageRef | null
  mentions: number[]
  created_at: string
  edited_at: string | null
  deleted: boolean
}

export interface CommentPin {
  x: number
  y: number
}

export interface Comment {
  id: number
  project_id: number
  image_id: number
  user: UserBrief
  body: string
  pin: CommentPin | null
  resolved: boolean
  mentions: number[]
  created_at: string
  edited_at: string | null
  deleted: boolean
}

export type ThreadComment = Comment & { image: ImageRef }

export interface DirectMessage {
  id: number
  sender_id: number
  recipient_id: number
  body: string
  created_at: string
  read_at: string | null
}

export interface Conversation {
  user: UserBrief
  last_message: DirectMessage
  unread_count: number
}

export type NotificationType =
  | 'mention'
  | 'assignment'
  | 'review_approved'
  | 'review_rejected'
  | 'review_requested'
  | 'comment'
  | 'dm'
  | 'project_added'

export interface Notification {
  id: number
  type: NotificationType
  actor: UserBrief | null
  project: { id: number; name: string } | null
  image: ImageRef | null
  text: string
  created_at: string
  read_at: string | null
}

export type ActivityType =
  | 'annotation_saved'
  | 'status_changed'
  | 'assigned'
  | 'flagged'
  | 'comment_added'
  | 'class_added'
  | 'class_updated'
  | 'class_deleted'
  | 'member_added'
  | 'member_updated'
  | 'member_removed'
  | 'images_uploaded'
  | 'project_created'
  | 'project_updated'
  | 'rescanned'
  | 'revision_restored'

export interface Activity {
  id: number
  type: ActivityType
  user: UserBrief | null
  image: ImageRef | null
  data: Record<string, unknown>
  created_at: string
}

// ------------------------------------------------------------------------------------------------
// Endpoint request / response shapes
// ------------------------------------------------------------------------------------------------

export interface Health {
  status: 'ok'
  version: string
}

export interface Meta {
  version: string
  app_name: 'Annotamate'
  max_upload_mb: number
}

export interface AuthState {
  setup_required: boolean
  /** First-run setup needs the token printed in the server log (the client is not on the server itself). */
  setup_token_required?: boolean
  user: User | null
}

export interface SetupBody {
  username: string
  display_name: string
  password: string
  setup_token?: string
}

export interface LoginBody {
  username: string
  password: string
}

export interface UpdateMeBody {
  display_name?: string
  email?: string | null
  avatar_color?: string
}

export interface ChangePasswordBody {
  current_password: string
  new_password: string
}

export interface CreateUserBody {
  username: string
  display_name: string
  password: string
  email?: string | null
  is_admin?: boolean
}

export interface UpdateUserBody {
  display_name?: string
  email?: string | null
  is_admin?: boolean
  is_active?: boolean
}

export interface FsRoot {
  path: string
  name: string
}

export interface FsEntry {
  name: string
  path: string
  image_count: number | null
}

export interface FsBrowse {
  path: string
  parent: string | null
  image_count: number
  entries: FsEntry[]
}

export interface CreateProjectBody {
  name: string
  description?: string
  image_dir: string
  label_dir?: string | null
  label_format: LabelFormat
  classes?: string[]
  settings?: Partial<ProjectSettings>
  members?: { user_id: number; role: Role }[]
}

export interface UpdateProjectBody {
  name?: string
  description?: string
  label_dir?: string | null
  settings?: Partial<ProjectSettings>
  archived?: boolean
}

export interface ClassCount {
  class_id: number
  boxes: number
  images: number
}

export interface UserStats {
  user: UserBrief
  saves: number
  boxes: number
  submitted: number
  approved: number
  rejected: number
  reviewed: number
}

export interface DailyStats {
  date: string
  saves: number
  done: number
}

export interface ProjectStats {
  status_counts: StatusCounts
  images_total: number
  boxes_total: number
  class_counts: ClassCount[]
  per_user: UserStats[]
  daily: DailyStats[]
}

export interface UploadResult {
  added: ImageItem[]
  skipped: { filename: string; reason: string }[]
}

export type ClassDeleteStrategy = 'forbid' | 'delete_boxes' | 'merge'

export interface ImagePage {
  total: number
  offset: number
  items: ImageItem[]
}

export interface Neighbors {
  prev_id: number | null
  next_id: number | null
  index: number
  total: number
}

export interface UpdateImageBody {
  flagged?: boolean
  assignee_id?: number | null
}

export type StatusAction = 'submit' | 'approve' | 'reject' | 'reopen'

export type BulkActionType = 'assign' | 'unassign' | 'flag' | 'unflag' | 'set_status' | 'distribute'

export interface ImageFilterQuery {
  q?: string
  status?: string
  assignee?: string
  flagged?: 'true' | 'false'
  class_id?: number
  has_comments?: 'open' | 'any'
  sort?: 'name' | 'updated'
}

export interface BulkBody {
  image_ids?: number[]
  filter?: ImageFilterQuery
  action: BulkActionType
  assignee_id?: number
  status?: ImageStatus
  user_ids?: number[]
  limit?: number
}

export interface SaveAnnotationBody {
  base_version: string | null
  boxes: Box[]
  force?: boolean
}

export interface SaveAnnotationResult {
  version: string
  updated_at: string
  box_count: number
  image: ImageItem
  /** The boxes as stored (clamped, rounded to the file format, tiny ones dropped): what a GET returns now. */
  boxes: Box[]
}

export interface RevisionSummary {
  id: number
  user: UserBrief | null
  created_at: string
  box_count: number
  version: string
}

export interface RevisionDetail {
  id: number
  user: UserBrief | null
  created_at: string
  boxes: Box[]
}

export interface CursorPage<T> {
  items: T[]
  has_more: boolean
}

export interface NotificationsPage extends CursorPage<Notification> {
  unread_count: number
}

// ------------------------------------------------------------------------------------------------
// WebSocket messages
// ------------------------------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'subscribe'; project_id: number }
  | { type: 'unsubscribe' }
  | { type: 'presence'; image_id: number | null }
  | { type: 'lock.acquire'; image_id: number; force?: boolean }
  | { type: 'lock.release'; image_id: number }
  | { type: 'typing'; scope: 'chat' }
  | { type: 'typing'; scope: 'dm'; user_id: number }
  | { type: 'ping' }

export interface PresenceEntry {
  user: UserBrief
  image_id: number | null
  image_filename: string | null
}

export interface ServerMessageMap {
  hello: { type: 'hello'; user_id: number; online_user_ids: number[] }
  pong: { type: 'pong' }
  'user.online': { type: 'user.online'; user_id: number }
  'user.offline': { type: 'user.offline'; user_id: number }
  'presence.snapshot': { type: 'presence.snapshot'; project_id: number; users: PresenceEntry[] }
  'presence.update': {
    type: 'presence.update'
    project_id: number
    user: UserBrief
    image_id: number | null
    image_filename: string | null
    left?: boolean
  }
  'lock.granted': { type: 'lock.granted'; image_id: number }
  'lock.denied': { type: 'lock.denied'; image_id: number; holder: UserBrief }
  /** `by` is null when the server took the lock back because the holder lost the right to edit (`reason`). */
  'lock.revoked': { type: 'lock.revoked'; image_id: number; by: UserBrief | null; reason?: string }
  'lock.expired': { type: 'lock.expired'; image_id: number }
  'lock.state': { type: 'lock.state'; project_id: number; image_id: number; holder: UserBrief | null }
  'image.updated': {
    type: 'image.updated'
    project_id: number
    image: ImageItem
    version?: string
    by?: UserBrief
  }
  'images.bulk_updated': { type: 'images.bulk_updated'; project_id: number; count: number }
  'classes.updated': { type: 'classes.updated'; project_id: number; classes: ProjectClass[] }
  'project.updated': { type: 'project.updated'; project_id: number }
  'project.indexing': {
    type: 'project.indexing'
    project_id: number
    done: number
    total: number
    finished: boolean
  }
  'members.updated': { type: 'members.updated'; project_id: number }
  'chat.message': { type: 'chat.message'; message: ChatMessage }
  'chat.updated': { type: 'chat.updated'; message: ChatMessage }
  'comment.created': { type: 'comment.created'; comment: Comment }
  'comment.updated': { type: 'comment.updated'; comment: Comment }
  'dm.message': { type: 'dm.message'; message: DirectMessage }
  /**
   * `reader_id` read the messages `sender_id` sent them. Sent to the sender (read receipt) and to the reader's
   * tabs, which also get the reader's new notification `unread_count` (DM notifications are cleared with it).
   */
  'dm.read': { type: 'dm.read'; reader_id: number; sender_id: number; read_at: string; unread_count?: number }
  notification: { type: 'notification'; notification: Notification; unread_count: number }
  typing:
    | { type: 'typing'; scope: 'chat'; project_id: number; user: UserBrief }
    | { type: 'typing'; scope: 'dm'; user: UserBrief }
  error: { type: 'error'; code: string; detail: string }
}

export type ServerMessageType = keyof ServerMessageMap
export type ServerMessage = ServerMessageMap[ServerMessageType]
