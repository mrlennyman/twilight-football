/**
 * Public menu (the tab bar under the header). Each league can show/hide, rename and
 * reorder its tabs; the choice is stored as JSON in leagues.nav_tabs.
 *
 * Modes:  show = always, hide = never,
 *         auto = bracket: only once the Cup/Plate knockouts have been drawn;
 *                info:    only once at least one Info page is published.
 */
const TABS = [
  { key: 'standings', label: 'Standings', modes: ['show', 'hide'], defaultMode: 'show', path: '' },
  { key: 'teams', label: 'Teams', modes: ['show', 'hide'], defaultMode: 'show', path: '/teams' },
  { key: 'fixtures', label: 'Fixtures', modes: ['show', 'hide'], defaultMode: 'show', path: '/fixtures' },
  { key: 'bracket', label: 'Cup/Plate', modes: ['show', 'auto', 'hide'], defaultMode: 'show', path: '/bracket' },
  { key: 'info', label: 'Info', modes: ['auto', 'hide'], defaultMode: 'auto', path: '/info' },
];

const MAX_LABEL = 20;

function readSaved(league) {
  try {
    const saved = JSON.parse((league && league.nav_tabs) || '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch (err) {
    return {};
  }
}

/** Every tab with its current settings (used by the admin form and the public menu). */
function getNavSettings(league) {
  const saved = readSaved(league);
  return TABS.map((tab, index) => {
    const s = saved[tab.key] && typeof saved[tab.key] === 'object' ? saved[tab.key] : {};
    const label = typeof s.label === 'string' && s.label.trim() ? s.label.trim().slice(0, MAX_LABEL) : tab.label;
    const mode = tab.modes.includes(s.mode) ? s.mode : tab.defaultMode;
    const order = Number.isInteger(s.order) ? s.order : index + 1;
    return { key: tab.key, defaultLabel: tab.label, modes: tab.modes, path: tab.path, label, mode, order, index };
  });
}

/** The tabs parents actually see, in order. counts = { info, knockouts }. */
function resolveNavTabs(league, counts = {}) {
  return getNavSettings(league)
    .filter((tab) => {
      if (tab.mode === 'hide') return false;
      if (tab.key === 'info') return (counts.info || 0) > 0;
      if (tab.key === 'bracket' && tab.mode === 'auto') return (counts.knockouts || 0) > 0;
      return true;
    })
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((tab) => ({ key: tab.key, label: tab.label, href: `/league/${league.id}${tab.path}` }));
}

/** Validates the admin form; returns { errors, value } where value is the JSON string to store. */
function parseNavInput(body) {
  const errors = [];
  const out = {};
  for (const tab of TABS) {
    const mode = String(body[`mode_${tab.key}`] ?? '');
    const label = String(body[`label_${tab.key}`] ?? '').trim();
    const orderText = String(body[`order_${tab.key}`] ?? '').trim();
    if (!tab.modes.includes(mode)) {
      errors.push(`Choose how the ${tab.label} tab should show.`);
      continue;
    }
    if (label.length > MAX_LABEL) errors.push(`The ${tab.label} tab name can be at most ${MAX_LABEL} characters.`);
    if (!/^\d{1,2}$/.test(orderText)) errors.push(`The ${tab.label} tab position must be a number from 1 to 99.`);
    out[tab.key] = { mode, label: label || tab.label, order: Number(orderText) };
  }
  if (!errors.length && Object.values(out).every((t) => t.mode === 'hide')) {
    errors.push('At least one tab has to stay visible.');
  }
  return { errors, value: JSON.stringify(out) };
}

module.exports = { TABS, MAX_LABEL, getNavSettings, resolveNavTabs, parseNavInput };
