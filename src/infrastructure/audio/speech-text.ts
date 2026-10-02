/**
 * Turns LLM output into text that sounds natural when read by a TTS voice:
 * strips markdown syntax, list markers and emoji that would otherwise be
 * spoken literally ("asterisco asterisco") or produce awkward pauses.
 */
export function toSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')            // code blocks are unreadable aloud
    .replace(/`([^`]*)`/g, '$1')                // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')       // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')    // links → label
    .replace(/(\*\*|__)(.*?)\1/g, '$2')         // bold
    .replace(/(\*|_)(\S.*?\S|\S)\1/g, '$2')     // italic
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')       // headings
    .replace(/^[ \t]*>[ \t]?/gm, '')                // blockquotes
    .replace(/^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+/gm, '') // list markers
    .replace(/[*#_~|]/g, ' ')                   // leftover markdown symbols
    .replace(/\p{Extended_Pictographic}/gu, '') // emoji
    // Each line (heading, list item, paragraph) becomes its own sentence so the
    // voice pauses between them instead of running them together.
    .replace(/([^\s.!?:;,])[ \t]*\n\s*/g, '$1. ')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
