/**
 * ThreadLog — Reconnect (reconnect.js)
 * Proactive "keep in touch" nudges (Section 10.4). Quiet and opt-in per
 * contact — only contacts with a cadence set ever show up here, and only
 * once they're actually overdue. Dismissing resets the clock without
 * requiring an interaction; logging any real activity resets it naturally
 * since the DB layer takes the max of last activity and last dismissal.
 */

const TL_RECONNECT = (() => {

  function render() {
    const list = document.getElementById('reconnect-list');
    if (!list) return;
    const contacts = TL_DB.getReconnectContacts();

    if (!contacts.length) {
      list.innerHTML = `
        <div style="text-align:center;padding:48px 24px;color:var(--text-tertiary)">
          <i class="ti ti-heart-handshake" style="font-size:40px;display:block;margin-bottom:12px;opacity:0.3"></i>
          <div style="font-size:14px;font-weight:500;color:var(--text-secondary);margin-bottom:6px">You're all caught up</div>
          <div style="font-size:13px;line-height:1.6">
            Nobody's overdue for a check-in right now. Set a "keep in touch" cadence on a contact's edit screen to get gentle nudges here.
          </div>
        </div>`;
      return;
    }

    list.innerHTML = contacts.map(c => _rowHTML(c)).join('');
  }

  function _rowHTML(c) {
    const cadenceLabel = _cadenceLabel(c.keep_in_touch_days);
    const overdueLabel = _overdueLabel(c.overdue_days);
    return `
      <div class="reconnect-row" data-contact-id="${c.id}">
        <div class="avatar av-${c.avatar_color || 'teal'}">${TL_APP._esc(c.initials)}</div>
        <div class="reconnect-info">
          <div class="reconnect-name">${TL_APP._esc(c.display_name)}</div>
          <div class="reconnect-meta">${overdueLabel} · ${cadenceLabel}</div>
        </div>
        <button class="reconnect-dismiss" data-contact-id="${c.id}" title="Not now — reset the clock">
          <i class="ti ti-check"></i> Dismiss
        </button>
      </div>`;
  }

  function _cadenceLabel(days) {
    if (days === 14) return 'Every 2 weeks';
    if (days === 30) return 'Monthly';
    if (days === 90) return 'Quarterly';
    return `Every ${days} days`;
  }

  function _overdueLabel(overdueDays) {
    if (overdueDays <= 0) return 'Due today';
    if (overdueDays < 7) return `${overdueDays} day${overdueDays !== 1 ? 's' : ''} overdue`;
    if (overdueDays < 60) return `${Math.floor(overdueDays / 7)} week${Math.floor(overdueDays / 7) !== 1 ? 's' : ''} overdue`;
    return `${Math.floor(overdueDays / 30)} month${Math.floor(overdueDays / 30) !== 1 ? 's' : ''} overdue`;
  }

  function _wireList() {
    const list = document.getElementById('reconnect-list');
    if (!list) return;
    list.addEventListener('click', e => {
      const dismissBtn = e.target.closest('.reconnect-dismiss');
      if (dismissBtn) {
        TL_DB.dismissReconnect(parseInt(dismissBtn.dataset.contactId));
        TL_APP.toast('Snoozed — you\'ll be nudged again next cycle');
        render();
        return;
      }
      const row = e.target.closest('.reconnect-row');
      if (row) TL_APP.openContact(parseInt(row.dataset.contactId));
    });
  }

  function _wireNav() {
    const backBtn = document.getElementById('btn-back-reconnect');
    if (backBtn) {
      backBtn.addEventListener('click', () => TL_APP.showView('view-contacts'));
    }
  }

  let _stylesInjected = false;
  function _injectStyles() {
    if (_stylesInjected) return;
    _stylesInjected = true;
    const s = document.createElement('style');
    s.id = 'reconnect-styles';
    s.textContent = `
      .reconnect-row { display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid var(--border); }
      .reconnect-info { flex:1; min-width:0; }
      .reconnect-name { font-size:15px; font-weight:500; color:var(--text-primary); }
      .reconnect-meta { font-size:12px; color:var(--text-tertiary); margin-top:2px; }
      .reconnect-dismiss {
        display:flex; align-items:center; gap:5px; flex-shrink:0;
        padding:6px 12px; border-radius:var(--radius-xl); border:1px solid var(--border);
        background:none; color:var(--text-secondary); font-size:12px; font-weight:500;
        font-family:var(--font); cursor:pointer;
      }
      .reconnect-dismiss:hover { background:var(--bg-secondary); }
      .reconnect-dismiss i { font-size:13px; }
    `;
    document.head.appendChild(s);
  }

  function init() {
    _injectStyles();
    _wireNav();
    _wireList();
  }

  return { init, render };

})();
