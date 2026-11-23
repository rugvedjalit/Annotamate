// @mention helpers shared by the composer (autocomplete) and the message renderer.

/** The "@partial" being typed at the caret, if any. */
export function activeMentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret)
  const m = /(^|[\s(])@([a-z0-9_.-]{0,32})$/i.exec(before)
  if (!m) return null
  return { query: m[2]!.toLowerCase(), start: caret - m[2]!.length - 1 }
}

export type MessageToken =
  | { type: 'text'; value: string }
  | { type: 'mention'; username: string; value: string }
  | { type: 'link'; href: string; value: string }

const TOKEN_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])|(^|[^\w@])@([a-z0-9_.-]{3,32})/gi

/** Split a message body into text, @mention and link tokens (no HTML is ever produced). */
export function tokenizeMessage(text: string): MessageToken[] {
  const tokens: MessageToken[] = []
  let last = 0
  for (const m of text.matchAll(TOKEN_RE)) {
    const index = m.index ?? 0
    if (m[1]) {
      if (index > last) tokens.push({ type: 'text', value: text.slice(last, index) })
      tokens.push({ type: 'link', href: m[1], value: m[1] })
      last = index + m[1].length
    } else {
      const prefix = m[2] ?? ''
      const start = index + prefix.length
      if (start > last) tokens.push({ type: 'text', value: text.slice(last, start) })
      const username = m[3]!.replace(/[.-]+$/, '')
      tokens.push({ type: 'mention', username: username.toLowerCase(), value: `@${username}` })
      last = start + 1 + username.length
    }
  }
  if (last < text.length) tokens.push({ type: 'text', value: text.slice(last) })
  return tokens
}
