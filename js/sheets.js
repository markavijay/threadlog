/**
 * ThreadLog — Sheets (sheets.js)
 * Bottom sheet controller + all entry forms (call, sms, email, meet, wa, doc, note)
 * + reminder form + settings sheet.
 */

const TL_SHEETS = (() => {

  // ── Sheet open/close ──────────────────────────────────────────────────────

  function open() {
    document.getElementById('sheet-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    document.getElementById('sheet-overlay').classList.remove('open');
    document.body.style.overflow = '';
  }

  // ── Add contact ───────────────────────────────────────────────────────────

  function openAddContact() {
    TL_CONTACTS.injectFormStyles();
    TL_CONTACTS.openAddContact();
  }

  // ── Add entry ─────────────────────────────────────────────────────────────

  function openAddEntry(contact, type) {
    if (type === 'wa') {
      TL_SYNC.openWhatsAppImport(contact);
      return;
    }
    TL_CONTACTS.injectFormStyles();
    const content = document.getElementById('sheet-content');
    const topics = TL_DB.getContactTopics(contact.id);

    content.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <div style="display:flex;align-items:center;gap:8px">
          <div class="mini-av av-${contact.avatar_color||'teal'}">${TL_APP._esc(contact.initials)}</div>
          <span class="sheet-title">${_typeLabel(type)} — ${TL_APP._esc(contact.first_name)}</span>
        </div>
        <button class="text-btn" id="ae-save">Save</button>
      </div>
      <div style="padding:0 16px 32px" id="ae-body">
        ${_entryFormHTML(type, topics, contact)}
      </div>`;

    _wireEntryForm(type, contact, topics);
    open();
  }

  function _typeLabel(type) {
    return { call:'Log call', sms:'Log SMS', email:'Log email', meet:'Log meeting', wa:'WhatsApp', doc:'Document', note:'Note' }[type] || 'Log entry';
  }

  function _entryFormHTML(type, topics, contact) {
    const now = new Date();
    const localDT = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

    let html = `
      <div class="form-section-label">Date &amp; time</div>
      <div class="form-field">
        <i class="ti ti-calendar form-field-icon"></i>
        <div class="form-field-inner">
          <input type="datetime-local" id="ae-datetime" class="form-input" value="${localDT}" />
        </div>
      </div>`;

    // Type-specific fields
    if (type === 'call') {
      html += `
        <div class="form-section-label">Direction</div>
        <div class="form-field">
          <i class="ti ti-arrow-right form-field-icon"></i>
          <div class="form-field-inner">
            <div class="dir-toggle">
              <div class="dir-btn active" data-dir="out">Outgoing</div>
              <div class="dir-btn" data-dir="in">Incoming</div>
              <div class="dir-btn" data-dir="missed">Missed</div>
            </div>
          </div>
        </div>
        <div class="form-section-label">Duration</div>
        <div class="form-field">
          <i class="ti ti-clock form-field-icon"></i>
          <div class="form-field-inner">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
              <input type="number" id="ae-dur-h" min="0" max="23" placeholder="0" class="form-input" style="width:48px;text-align:center" />
              <span style="color:var(--text-tertiary);font-size:13px">hr</span>
              <input type="number" id="ae-dur-m" min="0" max="59" placeholder="0" class="form-input" style="width:48px;text-align:center" />
              <span style="color:var(--text-tertiary);font-size:13px">min</span>
              <input type="number" id="ae-dur-s" min="0" max="59" placeholder="0" class="form-input" style="width:48px;text-align:center" />
              <span style="color:var(--text-tertiary);font-size:13px">sec</span>
            </div>
            <button id="ae-timer-btn" style="display:flex;align-items:center;gap:8px;padding:8px 14px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--bg-secondary);font-size:13px;color:var(--text-primary);font-family:var(--font);cursor:pointer;width:100%">
              <i class="ti ti-player-play" id="ae-timer-icon"></i>
              <span id="ae-timer-label">Start call timer</span>
              <span id="ae-timer-display" style="margin-left:auto;font-variant-numeric:tabular-nums;font-weight:500;color:var(--tl-accent);display:none">0:00</span>
            </button>
          </div>
        </div>`;
    }

    if (type === 'sms') {
      html += `
        <div class="form-section-label">Direction</div>
        <div class="form-field">
          <i class="ti ti-arrow-right form-field-icon"></i>
          <div class="form-field-inner">
            <div class="dir-toggle">
              <div class="dir-btn active" data-dir="out">Sent</div>
              <div class="dir-btn" data-dir="in">Received</div>
            </div>
          </div>
        </div>`;
    }

    if (type === 'email') {
      html += `
        <div class="form-section-label">Direction</div>
        <div class="form-field">
          <i class="ti ti-arrow-right form-field-icon"></i>
          <div class="form-field-inner">
            <div class="dir-toggle">
              <div class="dir-btn active" data-dir="out">Sent</div>
              <div class="dir-btn" data-dir="in">Received</div>
            </div>
          </div>
        </div>
        <div class="form-section-label">Subject</div>
        <div class="form-field">
          <i class="ti ti-mail form-field-icon"></i>
          <div class="form-field-inner">
            <input type="text" id="ae-subject" placeholder="Email subject line" class="form-input" />
          </div>
        </div>`;
    }

    if (type === 'meet') {
      html += `
        <div class="form-section-label">Type</div>
        <div class="form-field">
          <i class="ti ti-building form-field-icon"></i>
          <div class="form-field-inner">
            <div class="dir-toggle">
              <div class="dir-btn active" data-dir="in">Online</div>
              <div class="dir-btn" data-dir="out">In person</div>
            </div>
          </div>
        </div>
        <div class="form-section-label">Duration</div>
        <div class="form-field">
          <i class="ti ti-clock form-field-icon"></i>
          <div class="form-field-inner" style="display:flex;align-items:center;gap:8px">
            <input type="number" id="ae-dur-h" min="0" max="23" placeholder="0" class="form-input" style="width:48px;text-align:center" />
            <span style="color:var(--text-tertiary);font-size:13px">hr</span>
            <input type="number" id="ae-dur-m" min="0" max="59" placeholder="0" class="form-input" style="width:48px;text-align:center" />
            <span style="color:var(--text-tertiary);font-size:13px">min</span>
          </div>
        </div>
        <div class="form-section-label">Location / Link</div>
        <div class="form-field">
          <i class="ti ti-map-pin form-field-icon"></i>
          <div class="form-field-inner">
            <input type="text" id="ae-location" placeholder="e.g. Joe's office or meet.google.com/…" class="form-input" />
          </div>
        </div>`;
    }

    if (type === 'doc') {
      html += `
        <div class="form-section-label">Direction</div>
        <div class="form-field">
          <i class="ti ti-arrow-right form-field-icon"></i>
          <div class="form-field-inner">
            <div class="dir-toggle">
              <div class="dir-btn active" data-dir="out">I shared</div>
              <div class="dir-btn" data-dir="in">${TL_APP._esc(contact.first_name)} shared</div>
            </div>
          </div>
        </div>
        <div class="form-section-label">Document</div>
        <div class="form-field">
          <i class="ti ti-file form-field-icon"></i>
          <div class="form-field-inner">
            <div class="form-field-label">Document name</div>
            <input type="text" id="ae-doc-name" placeholder="e.g. Q3 Vendor Scorecard.xlsx" class="form-input" />
          </div>
        </div>
        <div class="form-field">
          <i class="ti ti-link form-field-icon"></i>
          <div class="form-field-inner">
            <div class="form-field-label">Google Drive link (optional)</div>
            <input type="url" id="ae-doc-url" placeholder="https://drive.google.com/…" class="form-input" />
          </div>
        </div>
        <div class="form-field">
          <i class="ti ti-category form-field-icon"></i>
          <div class="form-field-inner">
            <div class="form-field-label">Type</div>
            <select id="ae-doc-type" class="form-input" style="appearance:none;cursor:pointer">
              <option>PDF</option><option>Excel</option><option>Word</option>
              <option>PowerPoint</option><option>Other</option>
            </select>
          </div>
        </div>`;
    }

    if (type === 'wa') {
      html += `
        <div class="form-section-label">WhatsApp import</div>
        <div id="ae-wa-import-box" style="border:1px dashed var(--border-strong);border-radius:var(--radius-lg);padding:20px;text-align:center;cursor:pointer;margin:8px 0" onclick="document.getElementById('ae-wa-file').click()">
          <i class="ti ti-brand-whatsapp" style="font-size:28px;color:#27500A;display:block;margin-bottom:8px"></i>
          <div style="font-size:13px;font-weight:500;color:var(--text-primary);margin-bottom:4px">Tap to import exported chat</div>
          <div style="font-size:11px;color:var(--text-tertiary);line-height:1.6">In WhatsApp → open chat → ⋮ More → Export chat → Without media → share the .txt file</div>
        </div>
        <input type="file" id="ae-wa-file" accept=".txt" style="display:none" />
        <div id="ae-wa-preview" style="display:none;background:var(--c-wa);border-radius:var(--radius-lg);padding:12px;margin:8px 0"></div>`;
    }

    // Notes field (all types except wa which has its own)
    if (type !== 'wa') {
      const notesLabel = type === 'note' ? 'Note' : 'Notes';
      const notesPlaceholder = {
        call: 'What was discussed? Key points, decisions, follow-ups…',
        sms: 'Paste or type the message…',
        email: 'Summary or key points from this email…',
        meet: 'What was discussed? Decisions made, next steps…',
        doc: 'What is this document about? Why was it shared?',
        note: 'Anything worth remembering — a personal detail, an observation…',
      }[type] || 'Notes…';

      html += `
        <div class="form-section-label">${notesLabel}</div>
        <div class="form-field" style="align-items:flex-start">
          <i class="ti ti-notes form-field-icon" style="margin-top:2px"></i>
          <div class="form-field-inner">
            <textarea id="ae-notes" placeholder="${notesPlaceholder}" class="form-input form-textarea" rows="4"></textarea>
          </div>
        </div>`;
    }

    // Topics
    html += `
      <div class="form-section-label">Topics</div>
      <div class="topics-picker" id="ae-topics">
        ${topics.map(t => `<div class="topic-picker-chip" data-topic="${TL_APP._esc(t.name)}">${TL_APP._esc(t.name)}</div>`).join('')}
        <div class="topic-picker-chip add-topic-chip" id="ae-add-topic-btn"><i class="ti ti-plus"></i> New</div>
      </div>
      <div class="new-topic-row" id="ae-new-topic-row" style="display:none">
        <input type="text" id="ae-new-topic-input" placeholder="Topic name…" class="form-input" style="flex:1" />
        <button class="text-btn" id="ae-new-topic-confirm">Add</button>
        <button class="icon-btn" id="ae-new-topic-cancel"><i class="ti ti-x"></i></button>
      </div>`;

    // Reminder toggle
    html += `
      <div style="margin-top:8px;border-top:1px solid var(--border);padding-top:4px">
        <div class="toggle-row" id="ae-rem-toggle">
          <div class="toggle-track" id="ae-rem-track"><div class="toggle-thumb"></div></div>
          <div>
            <div style="font-size:14px;color:var(--text-primary)">Set a reminder</div>
            <div style="font-size:11px;color:var(--text-tertiary)">Get notified about a follow-up</div>
          </div>
        </div>
        <div id="ae-rem-fields" style="display:none">
          <div class="form-field">
            <i class="ti ti-bell form-field-icon"></i>
            <div class="form-field-inner">
              <div class="form-field-label">Reminder note</div>
              <input type="text" id="ae-rem-title" placeholder="e.g. Follow up on pricing decision" class="form-input" />
            </div>
          </div>
          <div class="form-field">
            <i class="ti ti-calendar form-field-icon"></i>
            <div class="form-field-inner">
              <div class="form-field-label">Remind me on</div>
              <input type="datetime-local" id="ae-rem-date" class="form-input" />
            </div>
          </div>
          <div class="form-section-label">Priority</div>
          <div class="pri-toggle" style="margin-bottom:12px">
            <button class="pri-btn" data-pri="low">Low</button>
            <button class="pri-btn active-med" data-pri="medium">Medium</button>
            <button class="pri-btn" data-pri="high">High</button>
          </div>
        </div>
      </div>`;

    return html;
  }

  function _wireEntryForm(type, contact, topics) {
    // Direction toggle
    document.querySelectorAll('.dir-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.closest('.dir-toggle').querySelectorAll('.dir-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Call timer
    if (type === 'call') {
      let _timerInterval = null;
      let _timerSeconds = 0;
      let _timerRunning = false;

      const timerBtn = document.getElementById('ae-timer-btn');
      const timerIcon = document.getElementById('ae-timer-icon');
      const timerLabel = document.getElementById('ae-timer-label');
      const timerDisplay = document.getElementById('ae-timer-display');

      function _updateTimerDisplay() {
        const h = Math.floor(_timerSeconds / 3600);
        const m = Math.floor((_timerSeconds % 3600) / 60);
        const s = _timerSeconds % 60;
        timerDisplay.textContent = h > 0
          ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
          : `${m}:${String(s).padStart(2,'0')}`;
      }

      timerBtn && timerBtn.addEventListener('click', () => {
        if (!_timerRunning) {
          // Start
          _timerRunning = true;
          timerIcon.className = 'ti ti-player-stop';
          timerLabel.textContent = 'Stop timer';
          timerDisplay.style.display = 'block';
          timerBtn.style.borderColor = 'var(--tl-accent)';
          timerBtn.style.background = 'var(--tl-accent-light)';
          _timerInterval = setInterval(() => {
            _timerSeconds++;
            _updateTimerDisplay();
          }, 1000);
        } else {
          // Stop — fill in duration fields
          clearInterval(_timerInterval);
          _timerRunning = false;
          timerIcon.className = 'ti ti-player-play';
          timerLabel.textContent = 'Start call timer';
          timerBtn.style.borderColor = '';
          timerBtn.style.background = '';
          const h = Math.floor(_timerSeconds / 3600);
          const m = Math.floor((_timerSeconds % 3600) / 60);
          const s = _timerSeconds % 60;
          document.getElementById('ae-dur-h').value = h || '';
          document.getElementById('ae-dur-m').value = m || '';
          document.getElementById('ae-dur-s').value = s || '';
        }
      });
    }

    // WhatsApp file import
    if (type === 'wa') {
      document.getElementById('ae-wa-file')?.addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
          const lines = ev.target.result.split('\n').filter(l => l.trim()).slice(0, 10);
          const preview = document.getElementById('ae-wa-preview');
          preview.style.display = 'block';
          preview.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <i class="ti ti-circle-check" style="color:#27500A;font-size:16px"></i>
              <span style="font-size:13px;font-weight:500;color:#27500A">${lines.length} messages loaded</span>
            </div>
            ${lines.map(l => `<div style="font-size:12px;color:#3B6D11;padding:3px 0;border-bottom:1px solid rgba(0,0,0,0.06)">${TL_APP._esc(l.slice(0,80))}</div>`).join('')}`;
          document.getElementById('ae-wa-import-box').style.display = 'none';
          // Store for save
          document.getElementById('ae-wa-file').dataset.content = ev.target.result;
        };
        reader.readAsText(file);
      });
    }

    // Topics
    document.getElementById('ae-topics').addEventListener('click', e => {
      const chip = e.target.closest('.topic-picker-chip');
      if (!chip) return;
      if (chip.id === 'ae-add-topic-btn') {
        document.getElementById('ae-new-topic-row').style.display = 'flex';
        document.getElementById('ae-new-topic-input').focus();
        return;
      }
      chip.classList.toggle('active');
    });

    document.getElementById('ae-new-topic-confirm').addEventListener('click', () => {
      const inp = document.getElementById('ae-new-topic-input');
      const val = inp.value.trim();
      if (!val) return;
      const wrap = document.getElementById('ae-topics');
      const addBtn = document.getElementById('ae-add-topic-btn');
      const chip = document.createElement('div');
      chip.className = 'topic-picker-chip active';
      chip.dataset.topic = val;
      chip.textContent = val;
      wrap.insertBefore(chip, addBtn);
      document.getElementById('ae-new-topic-row').style.display = 'none';
      inp.value = '';
    });

    document.getElementById('ae-new-topic-cancel').addEventListener('click', () => {
      document.getElementById('ae-new-topic-row').style.display = 'none';
      document.getElementById('ae-new-topic-input').value = '';
    });

    // Reminder toggle
    document.getElementById('ae-rem-toggle').addEventListener('click', () => {
      const track = document.getElementById('ae-rem-track');
      const fields = document.getElementById('ae-rem-fields');
      track.classList.toggle('on');
      fields.style.display = track.classList.contains('on') ? 'block' : 'none';
    });

    // Priority
    document.querySelectorAll('.pri-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.pri-btn').forEach(b => b.className = 'pri-btn');
        btn.classList.add(`active-${btn.dataset.pri === 'medium' ? 'med' : btn.dataset.pri}`);
      });
    });

    // Save
    document.getElementById('ae-save').addEventListener('click', () => _saveEntry(type, contact));
  }

  function _saveEntry(type, contact) {
    const dtVal = document.getElementById('ae-datetime')?.value;
    // datetime-local gives "YYYY-MM-DDTHH:MM" — parse as local time, not UTC
    let timestamp = Date.now();
    if (dtVal) {
      const [datePart, timePart] = dtVal.split('T');
      const [y, mo, d] = datePart.split('-').map(Number);
      const [h, mi] = (timePart || '00:00').split(':').map(Number);
      timestamp = new Date(y, mo - 1, d, h, mi).getTime();
    }

    // Direction
    const dirBtn = document.querySelector('.dir-btn.active');
    const direction = dirBtn?.dataset.dir || 'none';

    // Duration
    const durH = parseInt(document.getElementById('ae-dur-h')?.value || 0);
    const durM = parseInt(document.getElementById('ae-dur-m')?.value || 0);
    const durS = parseInt(document.getElementById('ae-dur-s')?.value || 0);
    const duration_s = (durH * 3600 + durM * 60 + durS) || null;

    // Topics
    const topic_names = [];
    document.querySelectorAll('#ae-topics .topic-picker-chip.active').forEach(c => {
      if (c.dataset.topic) topic_names.push(c.dataset.topic);
    });

    // WhatsApp body
    let body = document.getElementById('ae-notes')?.value.trim() || null;
    if (type === 'wa') {
      body = document.getElementById('ae-wa-file')?.dataset.content || body;
    }

    const entryData = {
      contact_id: contact.id,
      type,
      direction,
      timestamp,
      duration_s,
      subject: document.getElementById('ae-subject')?.value.trim() || null,
      body,
      doc_name: document.getElementById('ae-doc-name')?.value.trim() || null,
      doc_url: document.getElementById('ae-doc-url')?.value.trim() || null,
      doc_type: document.getElementById('ae-doc-type')?.value || null,
      location: document.getElementById('ae-location')?.value.trim() || null,
      topic_names,
    };

    const entryId = TL_DB.createEntry(entryData);

    // Reminder
    if (document.getElementById('ae-rem-track')?.classList.contains('on')) {
      const remTitle = document.getElementById('ae-rem-title')?.value.trim();
      const remDate = document.getElementById('ae-rem-date')?.value;
      const priBtn = document.querySelector('.pri-btn[class*="active"]');
      const priority = priBtn?.dataset.pri || 'medium';
      if (remTitle) {
        TL_DB.createReminder({
          contact_id: contact.id,
          entry_id: entryId,
          title: remTitle,
          due_at: remDate ? new Date(remDate).getTime() : null,
          priority,
          topic_names,
        });
      }
    }

    close();
    TL_APP.toast('Entry saved');

    // Refresh timeline + header subtitle
    TL_APP.refreshContactHeader();
    TL_TIMELINE.renderTopics(TL_DB.getContact(contact.id));
    TL_TIMELINE.renderEntries(contact.id, {
      type: TL_APP.activeTypeFilter === 'all' ? null : TL_APP.activeTypeFilter,
      topicId: TL_APP.activeTopicId,
    });
  }

  // ── Add reminder ──────────────────────────────────────────────────────────

  function openAddReminder(contact) {
    TL_CONTACTS.injectFormStyles();
    const topics = TL_DB.getContactTopics(contact.id);
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 86400000);
    const tomorrowDT = new Date(tomorrow - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0,16);

    const content = document.getElementById('sheet-content');
    content.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">New reminder — ${TL_APP._esc(contact.first_name)}</span>
        <button class="text-btn" id="ar-save">Save</button>
      </div>
      <div style="padding:0 16px 32px">
        <div class="form-section-label">Reminder</div>
        <div class="form-field">
          <i class="ti ti-bell form-field-icon"></i>
          <div class="form-field-inner">
            <input type="text" id="ar-title" placeholder="e.g. Follow up on pricing decision" class="form-input" />
          </div>
        </div>
        <div class="form-field" style="align-items:flex-start">
          <i class="ti ti-align-left form-field-icon" style="margin-top:2px"></i>
          <div class="form-field-inner">
            <textarea id="ar-desc" placeholder="Any extra context…" class="form-input form-textarea" rows="2"></textarea>
          </div>
        </div>

        <div class="form-section-label">Due date</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px" id="ar-quick-dates">
          <div class="dir-btn" data-days="0">Today</div>
          <div class="dir-btn active" data-days="1">Tomorrow</div>
          <div class="dir-btn" data-days="3">In 3 days</div>
          <div class="dir-btn" data-days="7">Next week</div>
        </div>
        <div class="form-field">
          <i class="ti ti-calendar form-field-icon"></i>
          <div class="form-field-inner">
            <input type="datetime-local" id="ar-due" class="form-input" value="${tomorrowDT}" />
          </div>
        </div>

        <div class="form-section-label">Priority</div>
        <div class="pri-toggle" style="margin-bottom:4px">
          <button class="pri-btn" data-pri="low">Low</button>
          <button class="pri-btn active-med" data-pri="medium">Medium</button>
          <button class="pri-btn" data-pri="high">High</button>
        </div>

        <div class="form-section-label">Topic</div>
        <div class="topics-picker">
          ${topics.map(t => `<div class="topic-picker-chip" data-topic="${TL_APP._esc(t.name)}">${TL_APP._esc(t.name)}</div>`).join('')}
        </div>

        <div class="toggle-row" id="ar-call-toggle" style="margin-top:8px">
          <div class="toggle-track on" id="ar-call-track"><div class="toggle-thumb"></div></div>
          <div>
            <div style="font-size:14px;color:var(--text-primary)">Show on calls with ${TL_APP._esc(contact.first_name)}</div>
            <div style="font-size:11px;color:var(--text-tertiary)">Appears when you call or receive a call</div>
          </div>
        </div>
      </div>`;

    // Wire quick dates
    document.getElementById('ar-quick-dates').addEventListener('click', e => {
      const btn = e.target.closest('.dir-btn');
      if (!btn) return;
      document.querySelectorAll('#ar-quick-dates .dir-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const d = new Date();
      d.setDate(d.getDate() + parseInt(btn.dataset.days));
      d.setHours(9, 0, 0, 0);
      const dt = new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0,16);
      document.getElementById('ar-due').value = dt;
    });

    // Priority
    document.querySelectorAll('.pri-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.pri-btn').forEach(b => b.className = 'pri-btn');
        btn.classList.add(`active-${btn.dataset.pri === 'medium' ? 'med' : btn.dataset.pri}`);
      });
    });

    // Topics
    document.querySelectorAll('.topic-picker-chip').forEach(chip => {
      chip.addEventListener('click', () => chip.classList.toggle('active'));
    });

    // Call toggle
    document.getElementById('ar-call-toggle').addEventListener('click', () => {
      document.getElementById('ar-call-track').classList.toggle('on');
    });

    // Save
    document.getElementById('ar-save').addEventListener('click', () => {
      const title = document.getElementById('ar-title').value.trim();
      if (!title) { document.getElementById('ar-title').focus(); return; }
      const dueVal = document.getElementById('ar-due').value;
      const priBtn = document.querySelector('.pri-btn[class*="active"]');
      const topic_names = [...document.querySelectorAll('.topic-picker-chip.active')].map(c => c.dataset.topic).filter(Boolean);
      TL_DB.createReminder({
        contact_id: contact.id,
        title,
        description: document.getElementById('ar-desc').value.trim() || null,
        due_at: dueVal ? new Date(dueVal).getTime() : null,
        priority: priBtn?.dataset.pri || 'medium',
        show_on_call: document.getElementById('ar-call-track').classList.contains('on'),
        topic_names,
      });
      close();
      TL_APP.toast('Reminder set');
      TL_CONTACTS.render();
    });

    open();
  }

  // ── Global reminders ──────────────────────────────────────────────────────

  function openGlobalReminders() {
    TL_CONTACTS.injectFormStyles();
    const due = TL_DB.getDueReminders();
    const content = document.getElementById('sheet-content');

    content.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">Reminders</span>
        <button class="icon-btn" onclick="TL_SHEETS.close()"><i class="ti ti-x"></i></button>
      </div>
      <div style="padding:0 16px 32px">
        ${due.length === 0 ? `
          <div style="text-align:center;padding:40px 0;color:var(--text-tertiary)">
            <i class="ti ti-bell-check" style="font-size:36px;display:block;margin-bottom:12px;opacity:0.3"></i>
            <div style="font-size:14px">No due reminders</div>
          </div>` :
          due.map(r => `
            <div style="display:flex;align-items:flex-start;gap:12px;padding:12px 0;border-bottom:1px solid var(--border)">
              <div style="width:34px;height:34px;border-radius:10px;background:${r.priority==='high'?'#FCEBEB':r.priority==='medium'?'#FAEEDA':'var(--tl-accent-light)'};display:flex;align-items:center;justify-content:center;font-size:16px;color:${r.priority==='high'?'#A32D2D':r.priority==='medium'?'#854F0B':'var(--tl-accent-text)'};flex-shrink:0">
                <i class="ti ti-bell"></i>
              </div>
              <div style="flex:1;min-width:0">
                <div style="font-size:14px;font-weight:500;color:var(--text-primary)">${TL_APP._esc(r.title)}</div>
                <div style="font-size:12px;color:var(--text-tertiary);margin-top:2px">${TL_APP._esc(r.first_name)} ${TL_APP._esc(r.last_name||'')}${r.descriptor?' — '+TL_APP._esc(r.descriptor):''}</div>
              </div>
              <button onclick="TL_DB.markReminderDone(${r.id});TL_SHEETS.openGlobalReminders();TL_APP.toast('Done ✓')" style="background:none;border:1px solid var(--border);border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text-tertiary);flex-shrink:0">
                <i class="ti ti-check" style="font-size:14px"></i>
              </button>
            </div>`).join('')}
      </div>`;
    open();
  }

  // ── Contact menu ──────────────────────────────────────────────────────────

  function openContactMenu(contact) {
    TL_CONTACTS.injectFormStyles();
    const content = document.getElementById('sheet-content');
    content.innerHTML = `
      <div class="sheet-handle"></div>
      <div style="padding:16px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <div class="avatar av-${contact.avatar_color||'teal'}" style="width:48px;height:48px;font-size:17px">${TL_APP._esc(contact.initials)}</div>
          <div>
            <div style="font-size:16px;font-weight:500;color:var(--text-primary)">${TL_APP._esc(contact.display_name)}</div>
            <div style="font-size:12px;color:var(--text-tertiary)">${contact.entry_count||0} entries · ${contact.pending_reminders||0} reminders</div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:2px">
          <button onclick="TL_CONTACTS.openEditContact(TL_DB.getContact(${contact.id}));TL_APP.openContact(${contact.id})" class="menu-item-btn"><i class="ti ti-edit"></i> Edit contact</button>
          <button onclick="TL_SHEETS.openAddReminder(TL_DB.getContact(${contact.id}))" class="menu-item-btn"><i class="ti ti-bell"></i> Add reminder</button>
          <button onclick="TL_CONTACTS.deleteContact(${contact.id})" class="menu-item-btn" style="color:#E24B4A"><i class="ti ti-trash"></i> Delete contact</button>
          <button onclick="TL_SHEETS.close()" class="menu-item-btn"><i class="ti ti-x"></i> Cancel</button>
        </div>
      </div>`;

    // Inject menu button style
    if (!document.getElementById('menu-btn-style')) {
      const s = document.createElement('style');
      s.id = 'menu-btn-style';
      s.textContent = `.menu-item-btn { display:flex;align-items:center;gap:10px;width:100%;padding:12px;background:none;border:none;border-radius:var(--radius-md);font-size:14px;color:var(--text-primary);font-family:var(--font);cursor:pointer;text-align:left; } .menu-item-btn:hover { background:var(--bg-secondary); } .menu-item-btn i { font-size:18px;color:var(--text-secondary);width:20px; }`;
      document.head.appendChild(s);
    }
    open();
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  function openSettings() {
    TL_CONTACTS.injectFormStyles();
    const googleConnected = TL_DB.getSetting('google_connected') === 'true';
    const googleEmail = TL_DB.getSetting('google_email') || '';
    const content = document.getElementById('sheet-content');
    content.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">Settings</span>
        <button class="icon-btn" onclick="TL_SHEETS.close()"><i class="ti ti-x"></i></button>
      </div>
      <div style="padding:0 16px 32px">
        <div class="form-section-label">Google account</div>
        ${googleConnected ? `
          <div style="display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid var(--border)">
            <i class="ti ti-circle-check" style="font-size:20px;color:var(--tl-accent)"></i>
            <div style="flex:1">
              <div style="font-size:14px;font-weight:500;color:var(--text-primary)">Connected</div>
              <div style="font-size:12px;color:var(--text-tertiary)">${TL_APP._esc(googleEmail)}</div>
            </div>
            <button onclick="TL_DB.setSetting('google_connected','false');TL_DB.setSetting('google_email','');TL_SHEETS.openSettings()" style="font-size:12px;color:#E24B4A;background:none;border:none;cursor:pointer;font-family:var(--font)">Disconnect</button>
          </div>` : `
          <div style="padding:12px 0;border-bottom:1px solid var(--border)">
            <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;line-height:1.6">Connect Google to auto-capture emails and calendar meetings with your contacts.</p>
            <button onclick="TL_SYNC.startGoogleAuth()" style="display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:11px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--bg);font-size:14px;font-weight:500;color:var(--text-primary);font-family:var(--font);cursor:pointer">
              <svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
              Sign in with Google
            </button>
          </div>`}

        <div class="form-section-label">Storage location</div>
        ${!TL_DB.isFileSystemSupported() ? `
          <div style="padding:12px 0;border-bottom:1px solid var(--border)">
            <p style="font-size:13px;color:var(--text-secondary);line-height:1.6">Your browser doesn't support folder storage. Data is kept in this browser only. Use Chrome or Edge to enable Resilio-synced storage.</p>
          </div>` : TL_DB.isUsingFileSystem() ? `
          <div style="display:flex;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid var(--border)">
            <i class="ti ti-folder-check" style="font-size:20px;color:var(--tl-accent)"></i>
            <div style="flex:1">
              <div style="font-size:14px;font-weight:500;color:var(--text-primary)">Connected to folder</div>
              <div style="font-size:12px;color:var(--text-tertiary)">${TL_APP._esc(TL_DB.getConnectedFolderName() || '')}</div>
            </div>
            <button onclick="TL_DB.connectFolder().then(()=>{TL_APP.toast('Folder reconnected'); TL_SHEETS.openSettings()}).catch(e=>TL_APP.toast(e.message))" style="font-size:12px;color:var(--tl-accent);background:none;border:none;cursor:pointer;font-family:var(--font)">Change</button>
          </div>` : `
          <div style="padding:12px 0;border-bottom:1px solid var(--border)">
            <p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px;line-height:1.6">Connect your Resilio-synced ThreadLog folder so your data lives in a real file and syncs across devices.</p>
            <button onclick="TL_DB.connectFolder().then(()=>{TL_APP.toast('Folder connected ✓'); TL_SHEETS.openSettings()}).catch(e=>TL_APP.toast(e.message))" style="display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:11px;border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--bg);font-size:14px;font-weight:500;color:var(--text-primary);font-family:var(--font);cursor:pointer">
              <i class="ti ti-folder-plus" style="font-size:18px"></i> Choose ThreadLog folder
            </button>
          </div>`}

        <div class="form-section-label">Sync settings</div>
        <div style="padding:10px 0;border-bottom:1px solid var(--border)">
          <div style="font-size:14px;color:var(--text-primary);margin-bottom:6px">Sync emails from</div>
          <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:8px">Only import emails after this date. Leave blank for all history.</div>
          <input type="date" id="sync-from-date" class="form-input"
            style="border:1px solid var(--border);border-radius:var(--radius-md);padding:6px 10px;font-size:13px;width:100%"
            value="${TL_DB.getSetting('gmail_sync_from_date') || ''}"
            onchange="TL_DB.setSetting('gmail_sync_from_date', this.value); TL_APP.toast('Sync date saved')" />
        </div>
        <button onclick="TL_DB.exportDatabase()" style="display:flex;align-items:center;gap:10px;width:100%;padding:12px;background:none;border:none;border-radius:var(--radius-md);font-size:14px;color:var(--text-primary);font-family:var(--font);cursor:pointer;text-align:left">
          <i class="ti ti-download" style="font-size:18px;color:var(--text-secondary)"></i> Export database backup
        </button>

        <div class="form-section-label" style="margin-top:8px">About</div>
        <div style="font-size:13px;color:var(--text-tertiary);line-height:1.7;padding:4px 0">
          ThreadLog v1.0<br>
          Local-first · Private · Resilio sync<br>
          Data stored on your device only
        </div>
      </div>`;
    open();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  return {
    open, close,
    openAddContact, openAddEntry,
    openAddReminder, openGlobalReminders,
    openContactMenu, openSettings,
  };

})();
