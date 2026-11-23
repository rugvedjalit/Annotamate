// The image shown before the current one (for "paste previous image's boxes").
let last: { projectId: number; imageId: number } | null = null

export function setLastVisited(projectId: number, imageId: number): void {
  last = { projectId, imageId }
}

export function getLastVisited(projectId: number, exceptImageId: number): number | null {
  return last && last.projectId === projectId && last.imageId !== exceptImageId ? last.imageId : null
}
