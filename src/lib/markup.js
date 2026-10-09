/**
 * Tiny, safe text-to-HTML for admin-written info pages.
 *   # Heading        -> <h2>      ## Subheading -> <h3>
 *   - item / * item  -> bullet list     1. item -> numbered list
 *   **bold**         -> <strong>
 *   [text](https://example.com) -> link (http/https only)
 * Everything is HTML-escaped first, so nothing typed can inject markup or scripts.
 */

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(text) {
  return escapeHtml(text)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)*]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    )
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderMarkup(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let list = null; // 'ul' | 'ol'
  let paragraph = [];

  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };
  const closeParagraph = () => {
    if (paragraph.length) html.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    paragraph = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    let m;

    if (!line) {
      closeParagraph();
      closeList();
    } else if ((m = /^(#{1,2})\s+(.+)$/.exec(line))) {
      closeParagraph();
      closeList();
      const tag = m[1].length === 1 ? 'h2' : 'h3';
      html.push(`<${tag}>${inline(m[2])}</${tag}>`);
    } else if ((m = /^[-*]\s+(.+)$/.exec(line))) {
      closeParagraph();
      if (list !== 'ul') {
        closeList();
        html.push('<ul>');
        list = 'ul';
      }
      html.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = /^\d+[.)]\s+(.+)$/.exec(line))) {
      closeParagraph();
      if (list !== 'ol') {
        closeList();
        html.push('<ol>');
        list = 'ol';
      }
      html.push(`<li>${inline(m[1])}</li>`);
    } else {
      closeList();
      paragraph.push(line);
    }
  }

  closeParagraph();
  closeList();
  return html.join('\n');
}

module.exports = { renderMarkup };
