/** The same exact @ grammar is used by the composer and the server. */
export const CHATROOM_MENTION_OPTIONS = Object.freeze([
  { id: 'requirements', name: '需求管理', aliases: ['需求管理', '需求', 'requirements'] },
  { id: 'codes', name: '代码开发', aliases: ['代码开发', '开发', '研发', 'codes'] },
  { id: 'assistant', name: '我的助理', aliases: ['我的助理', '助理', 'assistant'] },
  { id: 'logs', name: '日志查询', aliases: ['日志查询', '日志', 'logs'] },
])

const aliases = new Map(CHATROOM_MENTION_OPTIONS.flatMap(option =>
  option.aliases.map(alias => [alias.toLowerCase(), option.id])))

// A preceding word or email-local character means this @ belongs to an address,
// not a chat mention. An alias must fill the complete token after @.
const MENTION = /(^|[^\p{L}\p{N}._+%-])@([\p{L}\p{N}_-]+)/gu
const DRAFT = /(^|[^\p{L}\p{N}._+%-])@([\p{L}\p{N}_-]*)$/u

export function parseChatroomMentions(body) {
  const mentions = []
  const unknownMentions = []
  const recipients = new Set()
  if (typeof body !== 'string') {
    return { recipientId: null, mentions, unknownMentions, multipleRecipients: false }
  }
  for (const match of body.matchAll(MENTION)) {
    const raw = `@${match[2]}`
    const start = match.index + match[1].length
    const id = aliases.get(match[2].toLowerCase()) ?? null
    mentions.push({ raw, id, start, end: start + raw.length })
    if (id === null) unknownMentions.push(raw)
    else recipients.add(id)
  }
  return {
    recipientId: recipients.size === 1 ? [...recipients][0] : null,
    mentions,
    unknownMentions,
    multipleRecipients: recipients.size > 1,
  }
}

/** Returns the token being typed, including an empty query for a trailing @. */
export function findChatroomMentionDraft(body, cursor = body.length) {
  if (typeof body !== 'string' || !Number.isInteger(cursor) || cursor < 0 || cursor > body.length) return null
  const match = body.slice(0, cursor).match(DRAFT)
  if (!match) return null
  return { query: match[2], start: cursor - match[2].length - 1, end: cursor }
}
