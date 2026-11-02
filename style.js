// style.js — header tabs (Plan an event / About). No dependencies.
// Pre-redesign version (jQuery): archive/2026-11-02_pre_redesign/style.js
(function () {
  function showTab(name) {
    document.querySelectorAll('.tab-button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('.tab-content').forEach(function (t) {
      t.classList.toggle('active', t.id === 'tab-' + name);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.tab-button').forEach(function (b) {
      b.addEventListener('click', function () {
        // "Plan an event" from an event page goes back to the create form.
        if (b.dataset.tab === 'plan' && document.body.classList.contains('is-event') &&
            document.getElementById('tab-plan').classList.contains('active')) {
          window.location.hash = '#/';
        }
        showTab(b.dataset.tab);
      });
    });
    // Following any link (brand, event link) brings the planner back into view.
    window.addEventListener('hashchange', function () { showTab('plan'); });
    // In-app links (brand, My events cards) may point at the page already open, so no hashchange fires.
    document.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('a[href^="#/"]')) showTab('plan');
    });
  });
})();
