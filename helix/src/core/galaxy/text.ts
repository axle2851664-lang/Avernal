/**
 * Markdown text handling for the galaxy: reducing a note to prose, to an
 * excerpt, and to a normalised form that can be matched without tripping over
 * punctuation or casing.
 */

const FRONT_MATTER = /^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;
const INDENTED_HTML = /<[^>\n]*>/g;
const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const WIKILINK_DISPLAY = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
const LEADING_MARKER = /^[ \t]*(?:[>#]+|[-*+]|\d+[.)])[ \t]*/gm;
const RULE = /^[ \t]*(?:[-*_][ \t]*){3,}$/gm;
const EMPHASIS = /[*_~`]+/g;
const WHITESPACE = /\s+/g;

/** Anything that is not a letter or a digit, in any script. */
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

/** Removes a leading YAML front-matter block, if present. */
export function stripFrontMatter(markdown: string): string {
  return markdown.replace(FRONT_MATTER, '');
}

/**
 * Reduces markdown to readable prose. Link and wikilink *text* is kept — it is
 * part of the sentence — while the targets, code blocks and markup are dropped.
 */
export function toPlainText(markdown: string): string {
  return stripFrontMatter(markdown)
    .replace(FENCED_CODE, ' ')
    .replace(IMAGE, ' ')
    .replace(MD_LINK, '$1')
    .replace(WIKILINK_DISPLAY, (_match, target: string, alias?: string) =>
      alias !== undefined && alias.trim() !== '' ? alias : target,
    )
    .replace(INDENTED_HTML, ' ')
    .replace(RULE, ' ')
    .replace(LEADING_MARKER, '')
    .replace(EMPHASIS, '')
    .replace(WHITESPACE, ' ')
    .trim();
}

/**
 * Prose cut to `length` characters on a word boundary, with an ellipsis when
 * anything was dropped.
 */
export function makeExcerpt(markdown: string, length: number): string {
  const prose = toPlainText(markdown);
  if (prose.length <= length) return prose;

  const clipped = prose.slice(0, length);
  const lastSpace = clipped.lastIndexOf(' ');
  const body = lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped;
  return `${body.trimEnd()}…`;
}

/**
 * Casefolded, punctuation-free form used for all matching. Reducing both sides
 * of a comparison to this makes word-boundary matching a plain substring test,
 * which behaves the same for "Design Notes" and "design-notes".
 */
export function normalise(value: string): string {
  return value.replace(NON_ALPHANUMERIC, ' ').trim().toLowerCase();
}

/**
 * Normalised and space-padded, so `includes(pad(x))` matches whole words only
 * and never a fragment inside a longer word.
 */
export function pad(value: string): string {
  return ` ${normalise(value)} `;
}

/** Every distinct wikilink target in a note, in order of first appearance. */
export function extractWikilinkTargets(markdown: string): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();

  for (const match of stripFrontMatter(markdown).matchAll(WIKILINK_DISPLAY)) {
    const raw = match[1];
    if (raw === undefined) continue;

    // A wikilink may address a heading or a path: [[note#section]], [[dir/note]].
    const target = raw.split('#')[0]?.split('/').pop() ?? '';
    const key = normalise(target);
    if (key === '' || seen.has(key)) continue;

    seen.add(key);
    targets.push(key);
  }

  return targets;
}
