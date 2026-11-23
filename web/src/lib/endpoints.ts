// Typed functions, one per endpoint in docs/api.md.
import { buildQuery, http, type RequestOptions } from './api'
import { toFilterQuery, type ImageFilters } from './filters'
import type {
  Activity,
  AnnotationDoc,
  AuthState,
  BulkBody,
  ChangePasswordBody,
  ChatMessage,
  ClassDeleteStrategy,
  Comment,
  CommentPin,
  Conversation,
  CreateProjectBody,
  CreateUserBody,
  CursorPage,
  DirectMessage,
  FsBrowse,
  FsRoot,
  Health,
  ImageDetail,
  ImageItem,
  ImagePage,
  LabelFormat,
  LoginBody,
  Member,
  Meta,
  Neighbors,
  NotificationsPage,
  Project,
  ProjectClass,
  ProjectStats,
  ProjectSummary,
  RevisionDetail,
  RevisionSummary,
  Role,
  SaveAnnotationBody,
  SaveAnnotationResult,
  SetupBody,
  StatusAction,
  ThreadComment,
  UpdateImageBody,
  UpdateMeBody,
  UpdateProjectBody,
  UpdateUserBody,
  UploadResult,
  User,
  UserListItem,
  UserWithPresence,
} from './types'
import { apiUrl } from './config'

type Opts = Pick<RequestOptions, 'signal'>

export interface CursorQuery {
  before_id?: number
  limit?: number
}

// ---------- Meta ----------
export const getHealth = (o?: Opts) => http.get<Health>('health', o)
export const getMeta = (o?: Opts) => http.get<Meta>('meta', o)

// ---------- Auth and current user ----------
export const getAuthState = (o?: Opts) => http.get<AuthState>('auth/state', { ...o, skipAuthRedirect: true })
export const setupAdmin = (body: SetupBody) => http.post<User>('auth/setup', body, { skipAuthRedirect: true })
export const login = (body: LoginBody) => http.post<User>('auth/login', body, { skipAuthRedirect: true })
export const logout = () => http.post<void>('auth/logout', undefined, { skipAuthRedirect: true })
export const getMe = (o?: Opts) => http.get<User>('me', o)
export const updateMe = (body: UpdateMeBody) => http.patch<User>('me', body)
export const changePassword = (body: ChangePasswordBody) => http.post<void>('me/password', body)
export const getMySettings = (o?: Opts) => http.get<Record<string, unknown>>('me/settings', o)
export const putMySettings = (body: Record<string, unknown>) => http.put<Record<string, unknown>>('me/settings', body)

// ---------- Users ----------
export const getUsers = (includeInactive = false, o?: Opts) =>
  http.get<UserListItem[]>('users', { ...o, query: { include_inactive: includeInactive || undefined } })
/** Administrators only: the server returns the full account shape to them. */
export const getAdminUsers = (includeInactive = false, o?: Opts) =>
  http.get<UserWithPresence[]>('users', { ...o, query: { include_inactive: includeInactive || undefined } })
export const createUser = (body: CreateUserBody) => http.post<User>('users', body)
export const updateUser = (id: number, body: UpdateUserBody) => http.patch<User>(`users/${id}`, body)
export const resetUserPassword = (id: number, newPassword: string) =>
  http.post<void>(`users/${id}/password`, { new_password: newPassword })

// ---------- Folder browser ----------
export const getFsRoots = (o?: Opts) => http.get<FsRoot[]>('fs/roots', o)
export const browseFs = (path: string, o?: Opts) => http.get<FsBrowse>('fs/browse', { ...o, query: { path } })

// ---------- Projects ----------
export const getProjects = (archived = false, o?: Opts) =>
  http.get<ProjectSummary[]>('projects', { ...o, query: { archived } })
export const createProject = (body: CreateProjectBody) => http.post<Project>('projects', body)
export const getProject = (pid: number, o?: Opts) => http.get<Project>(`projects/${pid}`, o)
export const updateProject = (pid: number, body: UpdateProjectBody) => http.patch<Project>(`projects/${pid}`, body)
export const deleteProject = (pid: number) => http.delete(`projects/${pid}`)
export const pruneMissingImages = (pid: number) => http.post<{ removed: number }>(`projects/${pid}/prune-missing`)
export const rescanProject = (pid: number) => http.post<{ started: boolean }>(`projects/${pid}/rescan`)
/** Stats with 'daily' bucketed in the browser's calendar (UTC offset in minutes, east positive). */
export const getProjectStats = (pid: number, o?: Opts) =>
  http.get<ProjectStats>(`projects/${pid}/stats?tz_offset=${-new Date().getTimezoneOffset()}`, o)
export function uploadImages(pid: number, files: File[], subdir?: string) {
  const form = new FormData()
  for (const f of files) form.append('files[]', f, f.name)
  if (subdir) form.append('subdir', subdir)
  return http.post<UploadResult>(`projects/${pid}/upload`, form)
}
/** Export is a plain GET download (cookie auth, no CSRF header needed), so we build a URL for <a download>. */
export function exportUrl(pid: number, format: LabelFormat, scope: 'all' | 'done', includeImages: boolean): string {
  return apiUrl(`projects/${pid}/export`) + buildQuery({ format, scope, include_images: includeImages })
}

// ---------- Members ----------
export const getMembers = (pid: number, o?: Opts) => http.get<Member[]>(`projects/${pid}/members`, o)
export const addMember = (pid: number, userId: number, role: Role) =>
  http.post<Member>(`projects/${pid}/members`, { user_id: userId, role })
export const updateMember = (pid: number, userId: number, role: Role) =>
  http.patch<Member>(`projects/${pid}/members/${userId}`, { role })
export const removeMember = (pid: number, userId: number) => http.delete(`projects/${pid}/members/${userId}`)

// ---------- Classes ----------
export const getClasses = (pid: number, o?: Opts) => http.get<ProjectClass[]>(`projects/${pid}/classes`, o)
export const createClass = (pid: number, body: { name: string; color?: string }) =>
  http.post<ProjectClass>(`projects/${pid}/classes`, body)
export const updateClass = (pid: number, cid: number, body: { name?: string; color?: string }) =>
  http.patch<ProjectClass>(`projects/${pid}/classes/${cid}`, body)
/** Answers `202 {started: true}`: the label files are rewritten in the background (`classes.migration` events). */
export const deleteClass = (pid: number, cid: number, strategy: ClassDeleteStrategy, mergeInto?: number) =>
  http.delete<{ started: boolean }>(`projects/${pid}/classes/${cid}`, {
    query: { strategy, merge_into: strategy === 'merge' ? mergeInto : undefined },
  })

// ---------- Images ----------
export const getImages = (pid: number, filters: ImageFilters, offset = 0, limit = 100, o?: Opts) =>
  http.get<ImagePage>(`projects/${pid}/images`, { ...o, query: { ...toFilterQuery(filters), offset, limit } })
export const getImage = (pid: number, iid: number, o?: Opts) =>
  http.get<ImageDetail>(`projects/${pid}/images/${iid}`, o)
export const getNeighbors = (pid: number, iid: number, filters: ImageFilters, o?: Opts) =>
  http.get<Neighbors>(`projects/${pid}/images/${iid}/neighbors`, { ...o, query: { ...toFilterQuery(filters) } })
export function thumbUrl(pid: number, iid: number, size = 256): string {
  return apiUrl(`projects/${pid}/images/${iid}/thumb`) + buildQuery({ size })
}
export const updateImage = (pid: number, iid: number, body: UpdateImageBody) =>
  http.patch<ImageItem>(`projects/${pid}/images/${iid}`, body)
export const setImageStatus = (pid: number, iid: number, action: StatusAction, comment?: string) =>
  http.post<ImageItem>(`projects/${pid}/images/${iid}/status`, { action, comment })
export const bulkImages = (pid: number, body: BulkBody) =>
  http.post<{ updated: number }>(`projects/${pid}/images/bulk`, body)

// ---------- Annotations ----------
export const getAnnotation = (pid: number, iid: number, o?: Opts) =>
  http.get<AnnotationDoc>(`projects/${pid}/images/${iid}/annotation`, o)
export const saveAnnotation = (pid: number, iid: number, body: SaveAnnotationBody) =>
  http.put<SaveAnnotationResult>(`projects/${pid}/images/${iid}/annotation`, body)
export const getRevisions = (pid: number, iid: number, o?: Opts) =>
  http.get<RevisionSummary[]>(`projects/${pid}/images/${iid}/revisions`, o)
export const getRevision = (pid: number, iid: number, rid: number, o?: Opts) =>
  http.get<RevisionDetail>(`projects/${pid}/images/${iid}/revisions/${rid}`, o)
export const restoreRevision = (pid: number, iid: number, rid: number, baseVersion: string | null) =>
  http.post<SaveAnnotationResult>(`projects/${pid}/images/${iid}/revisions/${rid}/restore`, {
    base_version: baseVersion,
  })

// ---------- Image comments ----------
export const getComments = (pid: number, iid: number, o?: Opts) =>
  http.get<Comment[]>(`projects/${pid}/images/${iid}/comments`, o)
export const addComment = (pid: number, iid: number, body: string, pin?: CommentPin | null) =>
  http.post<Comment>(`projects/${pid}/images/${iid}/comments`, pin ? { body, pin } : { body })
export const updateComment = (pid: number, cid: number, body: { body?: string; resolved?: boolean }) =>
  http.patch<Comment>(`projects/${pid}/comments/${cid}`, body)
export const deleteComment = (pid: number, cid: number) => http.delete(`projects/${pid}/comments/${cid}`)
export const getProjectComments = (
  pid: number,
  q: CursorQuery & { resolved?: boolean } = {},
  o?: Opts,
) => http.get<CursorPage<ThreadComment>>(`projects/${pid}/comments`, { ...o, query: { ...q } })

// ---------- Project chat ----------
export const getChat = (pid: number, q: CursorQuery = {}, o?: Opts) =>
  http.get<CursorPage<ChatMessage>>(`projects/${pid}/chat`, { ...o, query: { ...q } })
export const postChat = (pid: number, body: string, imageId?: number | null) =>
  http.post<ChatMessage>(`projects/${pid}/chat`, imageId ? { body, image_id: imageId } : { body })
export const editChat = (pid: number, mid: number, body: string) =>
  http.patch<ChatMessage>(`projects/${pid}/chat/${mid}`, { body })
export const deleteChat = (pid: number, mid: number) => http.delete(`projects/${pid}/chat/${mid}`)
export const markChatRead = (pid: number, lastId: number) => http.post<void>(`projects/${pid}/chat/read`, { last_id: lastId })

// ---------- Direct messages ----------
export const getConversations = (o?: Opts) => http.get<Conversation[]>('dm', o)
export const getDirectMessages = (userId: number, q: CursorQuery = {}, o?: Opts) =>
  http.get<CursorPage<DirectMessage>>(`dm/${userId}`, { ...o, query: { ...q } })
export const sendDirectMessage = (userId: number, body: string) => http.post<DirectMessage>(`dm/${userId}`, { body })
export const markDirectRead = (userId: number) => http.post<void>(`dm/${userId}/read`)

// ---------- Notifications ----------
export const getNotifications = (q: CursorQuery & { unread?: boolean } = {}, o?: Opts) =>
  http.get<NotificationsPage>('notifications', { ...o, query: { ...q, unread: q.unread || undefined } })
export const markNotificationsRead = (body: { ids?: number[]; all?: boolean }) =>
  http.post<{ unread_count: number }>('notifications/read', body)

// ---------- Activity ----------
export const getActivity = (
  pid: number,
  q: CursorQuery & { user_id?: number; image_id?: number } = {},
  o?: Opts,
) => http.get<CursorPage<Activity>>(`projects/${pid}/activity`, { ...o, query: { ...q } })
