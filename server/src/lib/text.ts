/** Models occasionally wrap a "reply with only the message" answer in quotes. Strip one layer. */
export function unquote(s: string): string {
  const m = /^"([\s\S]+)"$/.exec(s.trim())
  return m ? m[1]!.trim() : s.trim()
}
