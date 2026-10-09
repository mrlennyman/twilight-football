const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '../src/public/css/style.css'), 'utf8');

test('no underlined links anywhere: links have no underline, and text-style buttons are pill buttons', () => {
  assert.doesNotMatch(css, /text-decoration:\s*underline/, 'nothing in the stylesheet underlines');
  assert.match(css, /\ba\s*\{\s*color:\s*var\(--wine-700\);\s*text-decoration:\s*none;\s*\}/, 'plain links have no underline');
  const linkButton = css.match(/button\.link-button, form button\[type="submit"\]\.link-button\s*\{[^}]*\}/)[0];
  assert.match(linkButton, /border-radius:\s*999px/);
  assert.match(linkButton, /text-decoration:\s*none/);
  assert.match(css, /\.prose a\s*\{[^}]*border-radius:\s*999px[^}]*\}/, 'links inside Info pages are little buttons');
});

test('standalone links in the views are styled as buttons', () => {
  const view = (p) => fs.readFileSync(path.join(__dirname, '../src/views', p), 'utf8');
  assert.match(view('public/team.ejs'), /<a class="btn btn-light btn-sm" href="[^"]*">&larr; All teams<\/a>/);
  assert.match(view('public/team.ejs'), /class="opp-btn"/);
  assert.match(view('public/page.ejs'), /class="btn btn-light btn-sm"/);
  assert.match(view('404.ejs'), /class="btn"/);
  assert.match(view('partials/footer.ejs'), /class="footer-btn"/);
  assert.match(view('admin/error.ejs'), /class="btn btn-light"[\s\S]*class="btn"/);
});
