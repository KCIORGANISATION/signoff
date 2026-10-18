// Turns plain text written by developers and clients into safe HTML pieces.
// Everything is escaped first; only the markup added here is ever trusted.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' };

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

// A file is cited in feedback as /fichier2 (French) or /file2 (English), counting from 1.
export const CITATION_PATTERN = /(?<![\w/])\/(?:fichier|file)(\d{1,3})(?![\w])/gi;

export function citationTag(lang, position) {
  return `/${lang === 'fr' ? 'fichier' : 'file'}${position}`;
}

// The feedback text with each citation as a link to the file it named when it was sent.
// files is the ordered list stored with the feedback; hrefFor(file) returns the link, or null
// when that file is gone.
export function renderFeedback(message, files, hrefFor) {
  const list = Array.isArray(files) ? files : [];
  const html = escapeHtml(message);
  return html.replace(CITATION_PATTERN, (tag, number) => {
    const file = list[Number(number) - 1];
    const href = file ? hrefFor(file) : null;
    if (!href) return `<span class="cite cite-missing">${tag}</span>`;
    return `<a class="cite" href="${escapeHtml(href)}" target="_blank" rel="noopener" title="${escapeHtml(file.name)}">${tag}</a>`;
  });
}

// Splits a milestone description into paragraphs, bullet lists and the "not included" note,
// so the client page can lay it out. Lines starting with "- ", "* " or "• " are bullets;
// a paragraph starting with "Pas inclus" or "Not included" is shown apart.
const EXCLUDED = /^(pas inclus|non inclus|not included)\s*:?\s*/i;
const BULLET = /^\s*[-*•]\s+/;

export function describe(text) {
  const blocks = [];
  for (const chunk of String(text ?? '').replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = chunk.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) continue;
    // Consecutive bullet lines make one list; other lines stay together as a paragraph.
    let run = null;
    for (const line of lines) {
      const bullet = BULLET.test(line);
      if (!run || run.bullet !== bullet) {
        run = { bullet, lines: [] };
        blocks.push(run);
      }
      run.lines.push(bullet ? line.replace(BULLET, '').trim() : line);
    }
  }
  return blocks.map((run) => {
    if (run.bullet) return { type: 'list', items: run.lines };
    const joined = run.lines.join('\n').trim();
    const excluded = joined.match(EXCLUDED);
    return excluded
      ? { type: 'excluded', label: excluded[1], text: joined.slice(excluded[0].length) }
      : { type: 'text', text: joined };
  });
}
