import { describe, expect, it } from 'vitest';

import { extractWikilinkTargets, makeExcerpt, normalise, toPlainText } from '../text.js';

describe('toPlainText', () => {
  it('drops YAML front matter', () => {
    expect(toPlainText('---\ntitle: Notes\ntags: [a]\n---\nThe body.')).toBe('The body.');
  });

  it('drops fenced code but keeps the prose around it', () => {
    expect(toPlainText('Before.\n\n```ts\nconst x = 1;\n```\n\nAfter.')).toBe('Before. After.');
  });

  it('keeps link text and discards the target', () => {
    expect(toPlainText('See [the spec](https://example.com/spec) today.')).toBe('See the spec today.');
  });

  it('keeps a wikilink alias when there is one, otherwise the target', () => {
    expect(toPlainText('Read [[Portable Mode|the rules]].')).toBe('Read the rules.');
    expect(toPlainText('Read [[Portable Mode]].')).toBe('Read Portable Mode.');
  });

  it('strips headings, list markers and emphasis', () => {
    expect(toPlainText('# Title\n\n- **bold** item\n- _plain_ item')).toBe('Title bold item plain item');
  });

  it('removes images entirely', () => {
    expect(toPlainText('Text ![a diagram](x.png) more.')).toBe('Text more.');
  });
});

describe('makeExcerpt', () => {
  it('returns short prose unchanged and without an ellipsis', () => {
    expect(makeExcerpt('Just a line.', 700)).toBe('Just a line.');
  });

  it('cuts to a word boundary and marks the cut', () => {
    const excerpt = makeExcerpt('alpha beta gamma delta', 12);

    expect(excerpt).toBe('alpha beta…');
    expect(excerpt.length).toBeLessThanOrEqual(13);
  });

  it('measures the excerpt against prose, not raw markdown', () => {
    const markdown = `---\ntitle: x\n---\n# Heading\n\n${'word '.repeat(400)}`;
    const excerpt = makeExcerpt(markdown, 700);

    expect(excerpt.length).toBeLessThanOrEqual(701);
    expect(excerpt.startsWith('Heading word')).toBe(true);
  });
});

describe('normalise', () => {
  it('casefolds and reduces punctuation to single spaces', () => {
    expect(normalise('Hand-Tracking / Gestures!')).toBe('hand tracking gestures');
  });

  it('keeps letters outside ASCII', () => {
    expect(normalise('Café Notes')).toBe('café notes');
  });
});

describe('extractWikilinkTargets', () => {
  it('collects distinct targets in order of appearance', () => {
    expect(extractWikilinkTargets('[[Beta]] then [[Alpha]] then [[Beta]] again')).toEqual([
      'beta',
      'alpha',
    ]);
  });

  it('reduces headings and paths to the note name', () => {
    expect(extractWikilinkTargets('[[docs/Portable Mode#Paths]]')).toEqual(['portable mode']);
  });

  it('ignores wikilinks inside front matter', () => {
    expect(extractWikilinkTargets('---\nrelated: [[Hidden]]\n---\nBody [[Shown]].')).toEqual(['shown']);
  });
});
