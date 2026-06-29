/**
 * ThreadLog — Reminders (reminders.js)
 * Handles reminder polling, due date notifications,
 * and surfacing reminders when a contact is called.
 */

const TL_REMINDERS = (() => {

  let _pollInterval = null;
  let _notifPermission = 'default';

  // ── Boot ──────────────────────────────────────────────────────────────────

  async function startPolling() {
    // Request notification permission
    if ('Notification' in window) {
      _notifPermission = await Notification.requestPermission();
    }

    // Check immediately on boot
    checkDue();

    // Then every 60 seconds
    _pollInterval = setInterval(checkDue, 60000);

    // Also check when tab becomes visible again
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) checkDue();
    });
  }

  // ── Check due reminders ───────────────────────────────────────────────────

  function checkDue() {
    const due = TL_DB.getDueReminders();
    if (!due.length) return;

    due.forEach(r => {
      _fireNotification(r);
    });
  }

  function _fireNotification(reminder) {
    const contactName = [reminder.first_name, reminder.last_name]
      .filter(Boolean).join(' ');
    const descriptor = reminder.descriptor ? ` — ${reminder.descriptor}` : '';

    // Browser notification
    if (_notifPermission === 'granted') {
      const notif = new Notification(`ThreadLog · ${contactName}${descriptor}`, {
        body: reminder.title,
        icon: '/icons/icon-192.png',
        tag: `reminder-${reminder.id}`,
        requireInteraction: reminder.priority === 'high',
      });

      notif.addEventListener('click', () => {
        window.focus();
        TL_APP.openContact(reminder.contact_id);
        notif.close();
      });
    }

    // Also show in-app toast for due reminders
    TL_APP.toast(`⏰ ${reminder.title} — ${contactName}`);
  }

  // ── Call reminder check ───────────────────────────────────────────────────
  // Called when user taps a contact's phone number or from the dialer

  function checkCallReminders(contactId) {
    const contact = TL_DB.getContact(contactId);
    if (!contact) return;
    const reminders = TL_DB.getCallReminders(contactId);
    if (!reminders.length) return;
    TL_APP.showCallReminders(contact);
  }

  // ── Reminder list for a contact ───────────────────────────────────────────

  function openContactReminders(contact) {
    const pending = TL_DB.getReminders(contact.id, { done: false });
    const done = TL_DB.getReminders(contact.id, { done: true });
    const content = document.getElementById('sheet-content');

    content.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">Reminders — ${TL_APP._esc(contact.first_name)}</span>
        <button class="text-btn" onclick="TL_SHEETS.openAddReminder(TL_DB.getContact(${contact.id}))">
          <i class="ti ti-plus"></i> Add
        </button>
      </div>

      <div style="display:flex;border-bottom:1px solid var(--border)">
        <div class="rem-tab active" id="rem-tab-pending" onclick="switchRemTab('pending')"
          style="flex:1;padding:10px;text-align:center;font-size:13px;font-weight:500;cursor:pointer;border-bottom:2px solid var(--tl-accent);color:var(--tl-accent)">
          Pending ${pending.length ? `(${pending.length})` : ''}
        </div>
        <div class="rem-tab" id="rem-tab-done" onclick="switchRemTab('done')"
          style="flex:1;padding:10px;text-align:center;font-size:13px;font-weight:500;cursor:pointer;border-bottom:2px solid transparent;color:var(--text-tertiary)">
          Done ${done.length ? `(${done.length})` : ''}
        </div>
      </div>

      <div id="rem-list-pending" style="padding:0 16px 32px">
        ${_reminderListHTML(pending, contact.id, false)}
      </div>
      <div id="rem-list-done" style="padding:0 16px 32px;display:none">
        ${_reminderListHTML(done, contact.id, true)}
      </div>`;

    TL_SHEETS.open();
  }

  function switchRemTab(tab) {
    document.getElementById('rem-list-pending').style.display = tab === 'pending' ? 'block' : 'none';
    document.getElementById('rem-list-done').style.display = tab === 'done' ? 'block' : 'none';
    document.getElementById('rem-tab-pending').style.cssText = `flex:1;padding:10px;text-align:center;font-size:13px;font-weight:500;cursor:pointer;border-bottom:2px solid ${tab==='pending'?'var(--tl-accent)':'transparent'};color:${tab==='pending'?'var(--tl-accent)':'var(--text-tertiary)'};`;
    document.getElementById('rem-tab-done').style.cssText = `flex:1;padding:10px;text-align:center;font-size:13px;font-weight:500;cursor:pointer;border-bottom:2px solid ${tab==='done'?'var(--tl-accent)':'transparent'};color:${tab==='done'?'var(--tl-accent)':'var(--text-tertiary)'};`;
  }

  function _reminderListHTML(reminders, contactId, isDone) {
    if (!reminders.length) {
      return `<div style="text-align:center;padding:32px 0;color:var(--text-tertiary)">
        <i class="ti ti-bell-check" style="font-size:32px;display:block;margin-bottom:10px;opacity:0.3"></i>
        <div style="font-size:13px">${isDone ? 'No completed reminders' : 'No pending reminders'}</div>
      </div>`;
    }

    // Separate overdue from upcoming
    const now = Date.now();
    const overdue = reminders.filter(r => r.due_at && r.due_at < now && !isDone);
    const upcoming = reminders.filter(r => !r.due_at || r.due_at >= now || isDone);

    let html = '';

    if (overdue.length) {
      html += `<div style="font-size:11px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:#A32D2D;padding:12px 0 6px">Overdue</div>`;
      overdue.forEach(r => { html += _reminderCardHTML(r, contactId, isDone); });
    }

    if (upcoming.length) {
      if (overdue.length) {
        html += `<div style="font-size:11px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:var(--text-tertiary);padding:12px 0 6px">Upcoming</div>`;
      }
      upcoming.forEach(r => { html += _reminderCardHTML(r, contactId, isDone); });
    }

    return html;
  }

  function _reminderCardHTML(r, contactId, isDone) {
    const now = Date.now();
    const isOverdue = r.due_at && r.due_at < now && !isDone;
    const priBg = r.priority === 'high' ? '#FCEBEB' : r.priority === 'medium' ? '#FAEEDA' : 'var(--tl-accent-light)';
    const priColor = r.priority === 'high' ? '#A32D2D' : r.priority === 'medium' ? '#854F0B' : 'var(--tl-accent-text)';
    const topicTags = (r.topics || []).map(t =>
      `<span style="font-size:10px;font-weight:500;padding:2px 7px;border-radius:20px;background:#EEEDFE;color:#3C3489">${TL_APP._esc(t.name)}</span>`
    ).join('');

    return `
      <div style="display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);opacity:${isDone?'0.5':'1'}">
        <div style="width:34px;height:34px;border-radius:10px;background:${priBg};display:flex;align-items:center;justify-content:center;font-size:16px;color:${priColor};flex-shrink:0">
          <i class="ti ${isDone ? 'ti-circle-check' : 'ti-bell'}"></i>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:500;color:var(--text-primary);margin-bottom:2px">${TL_APP._esc(r.title)}</div>
          ${r.description ? `<div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">${TL_APP._esc(r.description)}</div>` : ''}
          <div style="font-size:11px;color:${isOverdue?'#A32D2D':'var(--text-tertiary)'};margin-bottom:${topicTags?'6px':'0'}">
            ${r.due_at ? (isOverdue ? `Overdue since ${_formatDate(r.due_at)}` : `Due ${TL_APP._relDate(r.due_at)}`) : 'No due date'}
            · ${r.priority.charAt(0).toUpperCase() + r.priority.slice(1)} priority
            ${r.show_on_call ? '· Shows on calls' : ''}
          </div>
          ${topicTags ? `<div style="display:flex;flex-wrap:wrap;gap:4px">${topicTags}</div>` : ''}
        </div>
        ${!isDone ? `
          <button onclick="TL_REMINDERS.markDone(${r.id}, ${contactId})"
            style="width:28px;height:28px;border-radius:50%;border:1px solid var(--border);background:none;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text-tertiary);flex-shrink:0">
            <i class="ti ti-check" style="font-size:14px"></i>
          </button>` : ''}
      </div>`;
  }

  function _formatDate(ts) {
    return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  // ── Mark done ─────────────────────────────────────────────────────────────

  function markDone(reminderId, contactId) {
    TL_DB.markReminderDone(reminderId);
    TL_APP.toast('Reminder marked done ✓');
    // Refresh the sheet
    const contact = TL_DB.getContact(contactId);
    if (contact) openContactReminders(contact);
    // Refresh contact list dot
    TL_CONTACTS.render();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  return {
    startPolling,
    checkDue,
    checkCallReminders,
    openContactReminders,
    markDone,
  };

})();

// Make switchRemTab globally accessible (called from inline HTML)
window.switchRemTab = TL_REMINDERS.openContactReminders
  ? (tab) => {
      const pendingEl = document.getElementById('rem-list-pending');
      const doneEl = document.getElementById('rem-list-done');
      const pendingTab = document.getElementById('rem-tab-pending');
      const doneTab = document.getElementById('rem-tab-done');
      if (!pendingEl) return;
      pendingEl.style.display = tab === 'pending' ? 'block' : 'none';
      doneEl.style.display = tab === 'done' ? 'block' : 'none';
      pendingTab.style.cssText = `flex:1;padding:10px;text-align:center;font-size:13px;font-weight:500;cursor:pointer;border-bottom:2px solid ${tab==='pending'?'var(--tl-accent)':'transparent'};color:${tab==='pending'?'var(--tl-accent)':'var(--text-tertiary)'};`;
      doneTab.style.cssText = `flex:1;padding:10px;text-align:center;font-size:13px;font-weight:500;cursor:pointer;border-bottom:2px solid ${tab==='done'?'var(--tl-accent)':'transparent'};color:${tab==='done'?'var(--tl-accent)':'var(--text-tertiary)'};`;
    }
  : () => {};