/**
 * ThreadLog — App Controller (app.js)
 * Bootstraps the app, registers the service worker, handles routing,
 * PWA install prompt, and wires up all UI interactions.
 */

const TL_APP = (() => {

  let _currentContact = null;
  let _activeTypeFilter = 'all';
  let _activeTopicId = null;
  let _deferredInstallPrompt = null;

  // ── Boot ──────────────────────────────────────────────────────────────────

  async function boot() {
    try {
      await TL_DB.init();
      _handleGoogleCallback();
      _registerServiceWorker();
      _wireInstallPrompt();
      _wireNavigation();
      _wireContactList();
      _wireTypeFilters();
      _wireQuickAdd();
      _wireSearch();
      _checkUrlParams();
      TL_CONTACTS.render();
      // If contacts list is empty after Google redirect, DB may need a moment
      setTimeout(() => TL_CONTACTS.render(), 500);
      TL_REMINDERS.startPolling();
      TL_SYNC.startAutoSync();
      _hideLoader();
    } catch (err) {
      console.error('[App] Boot failed:', err);
      document.getElementById('loading-screen').innerHTML = `
        <div style="padding:24px;text-align:center;color:#712B13">
          <i class="ti ti-alert-circle" style="font-size:40px;display:block;margin-bottom:12px"></i>
          <strong>ThreadLog couldn't start</strong><br>
          <span style="font-size:13px;color:#9B9B95;margin-top:8px;display:block">${err.message}</span>
        </div>`;
    }
  }

  function _handleGoogleCallback() {
    const hash = window.location.hash;
    if (!hash.includes('access_token')) return;
    const params = new URLSearchParams(hash.slice(1));
    const token = params.get('access_token');
    if (!token) return;
    console.log('[Auth] Google token received');
    TL_DB.setSetting('google_token', token);
    TL_DB.setSetting('google_connected', 'true');
    // Fetch user email
    fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` }
    }).then(r => r.json()).then(data => {
      const email = data.email || 'Connected';
      TL_DB.setSetting('google_email', email);
      TL_DB.setSetting('google_email', email);
      TL_APP.toast(`✓ Google connected: ${email}`);
      console.log('[Auth] Connected as:', email);
      // Auto-start sync
      setTimeout(() => {
        TL_SYNC.syncGmail();
        TL_SYNC.syncCalendar();
      }, 1000);
    }).catch(e => {
      TL_APP.toast('✓ Google connected');
      console.warn('[Auth] Could not fetch email:', e);
      setTimeout(() => {
        TL_SYNC.syncGmail();
        TL_SYNC.syncCalendar();
      }, 1000);
    });
    // Clean URL
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function _hideLoader() {
    const el = document.getElementById('loading-screen');
    el.classList.add('hidden');
    setTimeout(() => el.style.display = 'none', 400);
  }

  // ── Service Worker ────────────────────────────────────────────────────────

  function _registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').then(reg => {
      console.log('[SW] Registered:', reg.scope);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            TL_APP.toast('Update available — refresh to get the latest');
          }
        });
      });
    }).catch(err => console.warn('[SW] Registration failed:', err));

    // Handle messages from SW
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'OPEN_CONTACT') openContact(e.data.contactId);
      if (e.data?.type === 'CHECK_REMINDERS') TL_REMINDERS.checkDue();
    });
  }

  // ── PWA Install ───────────────────────────────────────────────────────────

  function _wireInstallPrompt() {
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      _deferredInstallPrompt = e;
      const banner = document.getElementById('install-banner');
      banner.classList.add('show');
    });

    document.getElementById('install-btn').addEventListener('click', async () => {
      if (!_deferredInstallPrompt) return;
      _deferredInstallPrompt.prompt();
      const { outcome } = await _deferredInstallPrompt.userChoice;
      if (outcome === 'accepted') {
        document.getElementById('install-banner').classList.remove('show');
        TL_APP.toast('ThreadLog installed ✓');
      }
      _deferredInstallPrompt = null;
    });

    window.addEventListener('appinstalled', () => {
      document.getElementById('install-banner').classList.remove('show');
    });
  }

  // ── Routing ───────────────────────────────────────────────────────────────

  function showView(id) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(id).classList.add('active');
  }

  function openContact(contactId) {
    const contact = TL_DB.getContact(contactId);
    if (!contact) return;
    _currentContact = contact;
    _activeTypeFilter = 'all';
    _activeTopicId = null;

    // Header
    const av = document.getElementById('tl-avatar');
    av.className = `avatar av-${contact.avatar_color || 'teal'}`;
    av.textContent = contact.initials;
    document.getElementById('tl-name').textContent = contact.display_name;
    document.getElementById('tl-sub').textContent = _lastActivityLabel(contactId);

    TL_TIMELINE.renderTopics(contact);
    TL_TIMELINE.renderEntries(contact.id, { type: null, topicId: null });
    _resetTypeFilters();
    showView('view-timeline');
  }

  function refreshContactHeader() {
    if (!_currentContact) return;
    document.getElementById('tl-sub').textContent = _lastActivityLabel(_currentContact.id);
  }

  function _lastActivityLabel(contactId) {
    const entries = TL_DB.getEntries(contactId, { limit: 1 });
    if (!entries.length) return 'No activity yet';
    const ts = entries[0].timestamp;
    const diff = Date.now() - ts;
    if (diff < 0) return `Last activity ${new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
    if (diff < 60000) return 'Last activity just now';
    if (diff < 3600000) return `Last activity ${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return 'Last activity today';
    if (diff < 172800000) return 'Last activity yesterday';
    return `Last activity ${new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
  }

  function _checkUrlParams() {
    const p = new URLSearchParams(window.location.search);
    if (p.get('contact')) openContact(parseInt(p.get('contact')));
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  function _wireNavigation() {
    document.getElementById('btn-back-timeline').addEventListener('click', () => {
      _currentContact = null;
      TL_CONTACTS.render();
      showView('view-contacts');
    });

    document.getElementById('btn-settings').addEventListener('click', () => {
      TL_SHEETS.openSettings();
    });

    document.getElementById('btn-reminders-global').addEventListener('click', () => {
      TL_SHEETS.openGlobalReminders();
    });

    document.getElementById('btn-add-reminder').addEventListener('click', () => {
      if (_currentContact) TL_REMINDERS.openContactReminders(_currentContact);
    });

    document.getElementById('btn-contact-menu').addEventListener('click', () => {
      if (_currentContact) TL_SHEETS.openContactMenu(_currentContact);
    });

    document.getElementById('fab-add-contact').addEventListener('click', () => {
      TL_SHEETS.openAddContact();
    });

    // Sheet overlay — close on backdrop tap
    document.getElementById('sheet-overlay').addEventListener('click', e => {
      if (e.target.id === 'sheet-overlay') TL_SHEETS.close();
    });

    // Call overlay dismiss
    document.getElementById('call-rem-dismiss').addEventListener('click', () => {
      document.getElementById('call-overlay').classList.remove('show');
    });
  }

  // ── Contact List ──────────────────────────────────────────────────────────

  function _wireContactList() {
    document.getElementById('contact-list').addEventListener('click', e => {
      const row = e.target.closest('.contact-row');
      if (row) openContact(parseInt(row.dataset.contactId));
    });
  }

  // ── Type Filters ──────────────────────────────────────────────────────────

  function _wireTypeFilters() {
    document.getElementById('type-filters').addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      _activeTypeFilter = chip.dataset.filter;
      _resetTypeFilters(chip);
      if (_currentContact) {
        TL_TIMELINE.renderEntries(_currentContact.id, {
          type: _activeTypeFilter === 'all' ? null : _activeTypeFilter,
          topicId: _activeTopicId,
        });
      }
    });
  }

  function _resetTypeFilters(activeChip = null) {
    const chips = document.querySelectorAll('#type-filters .chip');
    chips.forEach(c => {
      c.className = 'chip';
      if (activeChip ? c === activeChip : c.dataset.filter === 'all') {
        c.classList.add(`active-${c.dataset.filter}`);
      }
    });
    if (!activeChip) _activeTypeFilter = 'all';
  }

  // ── Quick Add ─────────────────────────────────────────────────────────────

  function _wireQuickAdd() {
    document.querySelectorAll('.qa-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (_currentContact) {
          TL_SHEETS.openAddEntry(_currentContact, btn.dataset.entryType);
        }
      });
    });
  }

  // ── Search ────────────────────────────────────────────────────────────────

  function _wireSearch() {
    const input = document.getElementById('contact-search');
    const clearBtn = document.getElementById('search-clear');

    input.addEventListener('input', () => {
      clearBtn.classList.toggle('visible', input.value.length > 0);
      TL_CONTACTS.render(input.value);
    });

    clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.classList.remove('visible');
      TL_CONTACTS.render();
      input.focus();
    });
  }

  // ── Topic Filter (called from TL_TIMELINE) ─────────────────────────────

  function setTopicFilter(topicId) {
    _activeTopicId = topicId;
    if (_currentContact) {
      TL_TIMELINE.renderEntries(_currentContact.id, {
        type: _activeTypeFilter === 'all' ? null : _activeTypeFilter,
        topicId,
      });
    }
  }

  // ── Toast ─────────────────────────────────────────────────────────────────

  function toast(msg, duration = 2500) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), duration);
  }

  // ── Call Reminder Overlay ─────────────────────────────────────────────────

  function showCallReminders(contact) {
    const reminders = TL_DB.getCallReminders(contact.id);
    if (!reminders.length) return;

    document.getElementById('call-rem-title').textContent = `Before you speak with ${contact.first_name}`;
    document.getElementById('call-rem-count').textContent = `${reminders.length} reminder${reminders.length > 1 ? 's' : ''}`;

    const list = document.getElementById('call-rem-list');
    list.innerHTML = reminders.map(r => `
      <div class="call-rem-item">
        <div class="call-rem-item-title">${_esc(r.title)}</div>
        ${r.description ? `<div class="call-rem-item-meta">${_esc(r.description)}</div>` : ''}
        ${r.due_at ? `<div class="call-rem-item-meta">Due ${_relDate(r.due_at)}</div>` : ''}
      </div>
    `).join('');

    document.getElementById('call-overlay').classList.add('show');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _esc(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _relDate(ts) {
    const d = new Date(ts);
    const diff = d - Date.now();
    if (diff < 0) return `overdue since ${d.toLocaleDateString('en-IN', { day:'numeric', month:'short' })}`;
    if (diff < 86400000) return 'today';
    if (diff < 172800000) return 'tomorrow';
    return d.toLocaleDateString('en-IN', { day:'numeric', month:'short' });
  }

  // ── Public ────────────────────────────────────────────────────────────────

  return {
    boot,
    showView,
    openContact,
    setTopicFilter,
    toast,
    showCallReminders,
    get currentContact() { return _currentContact; },
    get activeTypeFilter() { return _activeTypeFilter; },
    get activeTopicId() { return _activeTopicId; },
    refreshContactHeader,
    _esc,
    _relDate,
  };

})();

// Boot on DOM ready
document.addEventListener('DOMContentLoaded', () => TL_APP.boot());
