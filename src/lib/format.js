/** Parent-friendly date/time display (the DB stores ISO dates and 24h times). */

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-14" -> "Wed 14 Oct" */
function formatDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!m) return iso || '';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${weekday} ${d} ${MONTHS[mo - 1]}`;
}

/** "17:00" -> "5pm", "18:45" -> "6:45pm" */
function formatTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ''));
  if (!m) return hhmm || '';
  const h = Number(m[1]);
  const min = m[2];
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return min === '00' ? `${h12}${suffix}` : `${h12}:${min}${suffix}`;
}

/** SQLite's datetime('now') text ("2026-10-14 05:42:10", UTC) -> Date, or null. */
function parseUtc(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text ?? ''));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
}

const NZ = 'Pacific/Auckland';
const nzIsoDate = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: NZ }).format(date);

/** UTC timestamp -> "5:42pm" in New Zealand time */
function formatNzTime(text) {
  const date = parseUtc(text);
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: NZ, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('hour')}:${get('minute')}${get('dayPeriod').toLowerCase()}`;
}

/** UTC timestamp -> "Wed 14 Oct, 5:42pm" in New Zealand time */
function formatNzDateTime(text) {
  const date = parseUtc(text);
  return date ? `${formatDate(nzIsoDate(date))}, ${formatNzTime(text)}` : '';
}

/** "Updated 5:42pm" today (NZ), "Updated Wed 14 Oct, 5:42pm" on another day; '' when unknown. */
function formatUpdated(text, now = new Date()) {
  const date = parseUtc(text);
  if (!date) return '';
  return nzIsoDate(date) === nzIsoDate(now) ? `Updated ${formatNzTime(text)}` : `Updated ${formatNzDateTime(text)}`;
}

module.exports = { formatDate, formatTime, parseUtc, formatNzTime, formatNzDateTime, formatUpdated };
