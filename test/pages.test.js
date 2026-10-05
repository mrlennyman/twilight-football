const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { renderMarkup } = require('../src/lib/markup');
const { slugify, createPage, seedStarterPages, STARTER_PAGES } = require('../src/lib/pages');
const { getPages, countPublishedPages, getPublishedPageBySlug } = require('../src/lib/queries');
const { parsePageInput } = require('../src/lib/validate');

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  db.prepare("INSERT INTO leagues (id, name, season) VALUES (1, 'L', '2026'), (2, 'M', '2026')").run();
  return db;
}

test('renderMarkup: headings, bullets, numbers, bold, paragraphs', () => {
  const html = renderMarkup(
    '# Big\n\nSome **bold** text\nsecond line\n\n## Small\n- one\n- two\n\n1. first\n2. second'
  );
  assert.match(html, /<h2>Big<\/h2>/);
  assert.match(html, /<h3>Small<\/h3>/);
  assert.match(html, /<p>Some <strong>bold<\/strong> text<br>second line<\/p>/);
  assert.match(html, /<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
  assert.match(html, /<ol>\s*<li>first<\/li>\s*<li>second<\/li>\s*<\/ol>/);
});

test('renderMarkup: cannot inject HTML, scripts or javascript: links', () => {
  const html = renderMarkup(
    '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1))\n\n- <b>x</b>'
  );
  assert.ok(!html.includes('<script'), 'script tag must be escaped');
  assert.ok(!html.includes('<img'), 'img tag must be escaped');
  assert.ok(!/<a /.test(html.replace(/<a href="https?:[^>]*>/g, '')), 'only http(s) links become anchors');
  assert.ok(!html.includes('<b>'));
  assert.match(html, /&lt;script&gt;/);
});

test('renderMarkup: http(s) links work and attribute quotes are escaped', () => {
  const html = renderMarkup('[NZ Football](https://www.nzfootball.co.nz/a?b=1&c="2")');
  assert.match(html, /<a href="https:\/\/www\.nzfootball\.co\.nz\/a\?b=1&amp;c=&quot;2&quot;" target="_blank" rel="noopener noreferrer">NZ Football<\/a>/);
});

test('slugify and unique slugs per league', () => {
  assert.equal(slugify('Parents & Supporters!'), 'parents-supporters');
  assert.equal(slugify('!!!'), 'page');
  const db = makeDb();
  createPage(db, 1, { title: 'Rules' });
  createPage(db, 1, { title: 'Rules' });
  createPage(db, 2, { title: 'Rules' });
  const slugs = getPages(db, 1).map((p) => p.slug);
  assert.deepEqual(slugs, ['rules', 'rules-2']);
  assert.deepEqual(getPages(db, 2).map((p) => p.slug), ['rules'], 'slugs are per league');
});

test('starter pages are unpublished drafts, so nothing is public until approved', () => {
  const db = makeDb();
  seedStarterPages(db, 1);
  assert.equal(getPages(db, 1).length, STARTER_PAGES.length);
  assert.equal(countPublishedPages(db, 1), 0);
  assert.equal(getPublishedPageBySlug(db, 1, 'referee-guide'), undefined);

  db.prepare("UPDATE pages SET published = 1 WHERE slug = 'referee-guide'").run();
  assert.equal(countPublishedPages(db, 1), 1);
  assert.equal(getPublishedPageBySlug(db, 1, 'referee-guide').title, 'Referee guide');
  assert.equal(getPublishedPageBySlug(db, 2, 'referee-guide'), undefined, 'not visible via another league');
});

test('parsePageInput validates title, order and the published checkbox', () => {
  const ok = parsePageInput({ title: ' Rules ', body: 'x', sort_order: '20', published: 'on' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.title, 'Rules');
  assert.equal(ok.value.published, true);
  assert.equal(parsePageInput({ title: 'T', body: '' }).value.published, false);
  assert.equal(parsePageInput({ title: '', body: '' }).errors.length, 1);
  assert.equal(parsePageInput({ title: 'T', body: '', sort_order: 'abc' }).errors.length, 1);
});
