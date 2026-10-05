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

module.exports = { formatDate, formatTime };
