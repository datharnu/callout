/** Link targets Telegram hides behind text ("Join VIP" → https://t.me/...). The visible text never shows them. */
export function hiddenLinks(m: { entities?: { type: string; url?: string }[]; caption_entities?: { type: string; url?: string }[] }): string[] {
  return [...(m.entities ?? []), ...(m.caption_entities ?? [])].filter(e => e.type === 'text_link' && e.url).map(e => e.url!)
}
