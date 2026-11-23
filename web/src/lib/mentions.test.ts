import { describe, expect, it } from 'vitest'
import { activeMentionQuery, tokenizeMessage } from './mentions'

describe('activeMentionQuery', () => {
  it('returns the partial username at the caret', () => {
    expect(activeMentionQuery('hello @al', 9)).toEqual({ query: 'al', start: 6 })
    expect(activeMentionQuery('@', 1)).toEqual({ query: '', start: 0 })
    expect(activeMentionQuery('@Al', 3)).toEqual({ query: 'al', start: 0 })
    expect(activeMentionQuery('(@bob', 5)).toEqual({ query: 'bob', start: 1 })
  })

  it('uses only the text before the caret', () => {
    expect(activeMentionQuery('@bob hi', 4)).toEqual({ query: 'bob', start: 0 })
    expect(activeMentionQuery('@bob hi', 7)).toBeNull()
  })

  it('returns null outside a mention', () => {
    expect(activeMentionQuery('email a@b', 9)).toBeNull()
    expect(activeMentionQuery('hi @alice ', 10)).toBeNull()
    expect(activeMentionQuery('no mention', 10)).toBeNull()
    expect(activeMentionQuery('', 0)).toBeNull()
  })
})

describe('tokenizeMessage', () => {
  it('splits text, mentions and links', () => {
    expect(tokenizeMessage('hey @alice see https://x.com/a?b=1.')).toEqual([
      { type: 'text', value: 'hey ' },
      { type: 'mention', username: 'alice', value: '@alice' },
      { type: 'text', value: ' see ' },
      { type: 'link', href: 'https://x.com/a?b=1', value: 'https://x.com/a?b=1' },
      { type: 'text', value: '.' },
    ])
  })

  it('handles a mention at the start and keeps the original casing in the value', () => {
    expect(tokenizeMessage('@Alice hi')).toEqual([
      { type: 'mention', username: 'alice', value: '@Alice' },
      { type: 'text', value: ' hi' },
    ])
  })

  it('does not treat emails as mentions', () => {
    expect(tokenizeMessage('write to bob@example.com')).toEqual([{ type: 'text', value: 'write to bob@example.com' }])
  })

  it('keeps trailing punctuation out of mentions and links', () => {
    expect(tokenizeMessage('ping @bob.')).toEqual([
      { type: 'text', value: 'ping ' },
      { type: 'mention', username: 'bob', value: '@bob' },
      { type: 'text', value: '.' },
    ])
    expect(tokenizeMessage('(see http://a.io/x)')).toEqual([
      { type: 'text', value: '(see ' },
      { type: 'link', href: 'http://a.io/x', value: 'http://a.io/x' },
      { type: 'text', value: ')' },
    ])
  })

  it('never produces HTML and reconstructs the original text', () => {
    const inputs = [
      '<script>alert(1)</script> @eve',
      'multi\nline @a_b_c\nhttps://example.org/path',
      '',
      'plain',
      'javascript:alert(1) @x.y.z',
    ]
    for (const text of inputs) {
      const tokens = tokenizeMessage(text)
      expect(tokens.map((t) => t.value).join('')).toBe(text)
      for (const t of tokens) if (t.type === 'link') expect(t.href).toMatch(/^https?:\/\//)
    }
    expect(tokenizeMessage('')).toEqual([])
  })
})
