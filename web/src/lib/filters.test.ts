import { describe, expect, it } from 'vitest'
import {
  filtersFromParams,
  filtersToParams,
  hasActiveFilters,
  toFilterQuery,
  type ImageFilters,
} from './filters'

describe('toFilterQuery', () => {
  it('produces a canonical query with a stable key order', () => {
    const q = toFilterQuery({
      sort: 'updated',
      has_comments: 'open',
      class_id: 3,
      flagged: false,
      assignee: 'me',
      status: ['review', 'done'],
      q: '  cat ',
    })
    expect(q).toEqual({
      q: 'cat',
      status: 'done,review',
      assignee: 'me',
      flagged: 'false',
      class_id: 3,
      has_comments: 'open',
      sort: 'updated',
    })
    expect(Object.keys(q)).toEqual(['q', 'status', 'assignee', 'flagged', 'class_id', 'has_comments', 'sort'])
  })

  it('drops empty values and the default sort', () => {
    expect(toFilterQuery({})).toEqual({})
    expect(toFilterQuery({ q: '   ', status: [], sort: 'name' })).toEqual({})
    expect(toFilterQuery({ assignee: 12 })).toEqual({ assignee: '12' })
    expect(toFilterQuery({ assignee: 'none', flagged: true })).toEqual({ assignee: 'none', flagged: 'true' })
  })

  it('does not mutate the input status array', () => {
    const status: ImageFilters['status'] = ['todo', 'done']
    toFilterQuery({ status })
    expect(status).toEqual(['todo', 'done'])
  })
})

describe('filtersFromParams / filtersToParams', () => {
  it('parses every filter from URL params', () => {
    const f = filtersFromParams(
      new URLSearchParams('q=a&status=todo,bogus,done&assignee=7&flagged=true&class_id=2&has_comments=any&sort=updated'),
    )
    expect(f).toEqual({
      q: 'a',
      status: ['todo', 'done'],
      assignee: 7,
      flagged: true,
      class_id: 2,
      has_comments: 'any',
      sort: 'updated',
    })
  })

  it('ignores invalid values', () => {
    expect(
      filtersFromParams(
        new URLSearchParams('status=bogus&assignee=abc&flagged=maybe&class_id=x&has_comments=all&sort=name'),
      ),
    ).toEqual({})
    expect(filtersFromParams(new URLSearchParams('assignee=me&flagged=false'))).toEqual({ assignee: 'me', flagged: false })
    expect(filtersFromParams(new URLSearchParams('assignee=none'))).toEqual({ assignee: 'none' })
  })

  it('writes filters while keeping unrelated params', () => {
    const params = filtersToParams({ q: 'new', status: ['review'] }, new URLSearchParams('tab=info&q=old&flagged=true'))
    expect(params.get('tab')).toBe('info')
    expect(params.get('q')).toBe('new')
    expect(params.get('status')).toBe('review')
    expect(params.has('flagged')).toBe(false)
  })

  it('round-trips', () => {
    const f: ImageFilters = {
      q: 'frame',
      status: ['done', 'in_progress'],
      assignee: 4,
      flagged: false,
      class_id: 9,
      has_comments: 'open',
      sort: 'updated',
    }
    expect(filtersFromParams(filtersToParams(f))).toEqual(f)
    expect(filtersFromParams(filtersToParams({}))).toEqual({})
  })
})

describe('hasActiveFilters', () => {
  it('ignores the sort order when deciding if filters are active', () => {
    expect(hasActiveFilters({})).toBe(false)
    expect(hasActiveFilters({ sort: 'updated' })).toBe(false)
    expect(hasActiveFilters({ q: ' ' })).toBe(false)
    expect(hasActiveFilters({ q: 'x' })).toBe(true)
    expect(hasActiveFilters({ flagged: false })).toBe(true)
    expect(hasActiveFilters({ status: ['todo'] })).toBe(true)
  })
})
