/*
 * "Follow this team": remembers one team per league on this phone and highlights it on every page.
 * Everything works without this script - it only adds the highlighting and the follow button.
 */
(function () {
  var KEY = 'bb-my-team';
  var leagueId = document.documentElement.getAttribute('data-league-id');
  if (!leagueId) return;

  function read() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
    } catch (err) {
      return {};
    }
  }
  function write(map) {
    try {
      localStorage.setItem(KEY, JSON.stringify(map));
    } catch (err) {
      /* private mode: following just doesn't stick */
    }
  }

  function highlight() {
    var mine = String(read()[leagueId] || '');
    document.querySelectorAll('.my-team').forEach(function (el) {
      el.classList.remove('my-team');
    });
    if (!mine) return;
    document.querySelectorAll('[data-team-id]').forEach(function (el) {
      if (el.getAttribute('data-team-id') === mine) el.classList.add('my-team');
    });
    document.querySelectorAll('[data-team-ids]').forEach(function (el) {
      if (el.getAttribute('data-team-ids').split(' ').indexOf(mine) !== -1) el.classList.add('my-team');
    });
  }

  var button = document.getElementById('follow-team');
  if (button) {
    var teamId = button.getAttribute('data-team-id');
    var label = function () {
      var following = String(read()[leagueId] || '') === teamId;
      button.textContent = following ? 'Following this team ✓' : 'Follow this team';
      button.setAttribute('aria-pressed', String(following));
    };
    button.hidden = false;
    var help = document.getElementById('follow-help');
    if (help) help.hidden = false;
    label();
    button.addEventListener('click', function () {
      var map = read();
      if (String(map[leagueId] || '') === teamId) delete map[leagueId];
      else map[leagueId] = teamId;
      write(map);
      label();
      highlight();
    });
  }

  highlight();
})();
