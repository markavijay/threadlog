/**
 * ThreadLog — Contacts (contacts.js)
 * Renders the contact list, handles add/edit contact UI.
 */

const TL_CONTACTS = (() => {

  const AVATAR_COLORS = ['teal','blue','amber','coral','purple','green'];

  // ── Render contact list ───────────────────────────────────────────────────

  function render(query = '') {
    const list = document.getElementById('contact-list');
    const contacts = query
      ? TL_DB.searchContacts(query)
      : TL_DB.getContacts();

    if (!contacts.length) {
      list.innerHTML = `
        <div style="text-align:center;padding:48px 24px;color:var(--text-tertiary)">
          <i class="ti ti-address-book" style="font-size:40px;display:block;margin-bottom:12px;opacity:0.3"></i>
          <div style="font-size:14px;font-weight:500;color:var(--text-secondary);margin-bottom:6px">
            ${query ? 'No contacts found' : 'No contacts yet'}
          </div>
          <div style="font-size:13px;line-height:1.6">
            ${query ? `No results for "${query}"` : 'Tap the + button to add your first contact'}
          </div>
        </div>`;
      return;
    }

    // Group by first letter
    const grouped = {};
    contacts.forEach(c => {
      const letter = c.first_name[0].toUpperCase();
      if (!grouped[letter]) grouped[letter] = [];
      grouped[letter].push(c);
    });

    let html = '';

    if (!query) {
      // Show "Recent" section (contacts with activity, sorted by last_activity)
      const recent = contacts.filter(c => c.last_activity).slice(0, 5);
      const recentIds = new Set(recent.map(c => c.id));
      if (recent.length) {
        html += `<div class="list-section-label">Recent</div>`;
        recent.forEach(c => { html += _contactRowHTML(c); });
      }
      // All contacts — exclude those already shown in Recent
      const rest = contacts.filter(c => !recentIds.has(c.id));
      if (rest.length) {
        html += `<div class="list-section-label">All contacts</div>`;
        rest.forEach(c => { html += _contactRowHTML(c); });
      }
    } else {
      contacts.forEach(c => { html += _contactRowHTML(c); });
    }

    list.innerHTML = html;
  }

  function _contactRowHTML(c) {
    const lastActivity = c.last_activity
      ? _relTime(c.last_activity)
      : '';
    const preview = _getPreview(c);
    const hasReminder = c.pending_reminders > 0;

    return `
      <div class="contact-row" data-contact-id="${c.id}">
        <div class="avatar av-${c.avatar_color || 'teal'}">${TL_APP._esc(c.initials)}</div>
        <div class="contact-info">
          <div class="contact-name">
            ${TL_APP._esc(c.first_name)}${c.last_name ? ' ' + TL_APP._esc(c.last_name) : ''}
            ${c.descriptor ? `<span class="descriptor"> — ${TL_APP._esc(c.descriptor)}</span>` : ''}
          </div>
          <div class="contact-preview">${TL_APP._esc(preview)}</div>
        </div>
        <div class="contact-meta">
          <span class="contact-time">${lastActivity}</span>
          ${hasReminder ? '<div class="reminder-dot" title="Pending reminders"></div>' : ''}
        </div>
      </div>`;
  }

  function _getPreview(c) {
    const entries = TL_DB.getEntries(c.id, { limit: 1 });
    if (!entries.length) return 'No activity yet';
    const e = entries[0];
    if (e.body) return e.body.replace(/<[^>]+>/g, '').slice(0, 60);
    if (e.subject) return e.subject;
    if (e.doc_name) return `Shared: ${e.doc_name}`;
    return _typeName(e.type);
  }

  function _typeName(type) {
    return { call:'Call', sms:'SMS', email:'Email', meet:'Meeting', wa:'WhatsApp', doc:'Document', note:'Note' }[type] || type;
  }

  function _relTime(ts) {
    if (!ts || ts <= 0) return '';
    const diff = Date.now() - ts;
    if (diff < 0) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return 'Today';
    if (diff < 172800000) return 'Yesterday';
    if (diff < 604800000) return new Date(ts).toLocaleDateString('en-IN', { weekday: 'short' });
    return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  // ── Add Contact Sheet ─────────────────────────────────────────────────────

  function openAddContact() {
    const content = document.getElementById('sheet-content');
    content.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">New contact</span>
        <button class="text-btn" id="sc-save">Save</button>
      </div>

      <div style="padding:20px 16px 12px;text-align:center">
        <div class="avatar av-teal" id="sc-avatar" style="width:64px;height:64px;font-size:22px;margin:0 auto 8px">
          <i class="ti ti-user" style="font-size:28px"></i>
        </div>
        <div style="font-size:11px;color:var(--text-tertiary)">Initials appear automatically</div>
      </div>

      <div style="padding:0 16px">
        <div class="form-section-label">Name</div>
        <div class="form-field">
          <i class="ti ti-user form-field-icon"></i>
          <div class="form-field-inner">
            <div class="form-field-label">First name *</div>
            <input type="text" id="sc-first" placeholder="e.g. Joe" class="form-input" autocomplete="off" />
          </div>
        </div>
        <div class="form-field">
          <i class="ti ti-user form-field-icon" style="opacity:0"></i>
          <div class="form-field-inner">
            <div class="form-field-label">Last name</div>
            <input type="text" id="sc-last" placeholder="e.g. Sharma" class="form-input" autocomplete="off" />
          </div>
        </div>
        <div class="form-field">
          <i class="ti ti-tag form-field-icon"></i>
          <div class="form-field-inner">
            <div class="form-field-label">Descriptor tag</div>
            <input type="text" id="sc-descriptor" placeholder="e.g. The Trader, CA – Tax Consult" class="form-input" autocomplete="off" />
          </div>
        </div>

        <div class="form-section-label" style="margin-top:8px">Phone numbers</div>
        <div id="sc-phones">
          <div class="form-field phone-row">
            <i class="ti ti-phone form-field-icon"></i>
            <select class="phone-type-select">
              <option value="mobile">Mobile</option>
              <option value="work">Work</option>
              <option value="home">Home</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
            <input type="tel" placeholder="+91 98xxx xxxxx" class="form-input phone-input" />
          </div>
        </div>
        <button class="add-more-btn" id="sc-add-phone">
          <i class="ti ti-plus"></i> Add another number
        </button>

        <div class="form-section-label" style="margin-top:8px">Email</div>
        <div id="sc-emails">
          <div class="form-field">
            <i class="ti ti-mail form-field-icon"></i>
            <div class="form-field-inner">
              <input type="email" placeholder="joe@example.com" class="form-input" />
            </div>
          </div>
        </div>
        <button class="add-more-btn" id="sc-add-email">
          <i class="ti ti-plus"></i> Add another email
        </button>

        <div class="form-section-label" style="margin-top:8px">Default topics</div>
        <div class="topics-picker" id="sc-topics">
          ${_defaultTopicChips()}
        </div>
        <div class="new-topic-row" id="sc-new-topic-row" style="display:none">
          <input type="text" id="sc-new-topic-input" placeholder="Topic name…" class="form-input" style="flex:1" />
          <button class="text-btn" id="sc-new-topic-confirm">Add</button>
          <button class="icon-btn" id="sc-new-topic-cancel"><i class="ti ti-x"></i></button>
        </div>

        <div class="form-section-label" style="margin-top:8px">Opening note</div>
        <div class="form-field" style="align-items:flex-start">
          <i class="ti ti-notes form-field-icon" style="margin-top:2px"></i>
          <div class="form-field-inner">
            <textarea id="sc-notes" placeholder="How do you know this person? Any context to remember…" class="form-input form-textarea" rows="3"></textarea>
          </div>
        </div>

        <div style="height:24px"></div>
      </div>`;

    _injectFormStyles();
    _wireAddContactForm();
    TL_SHEETS.open();
  }

  function _defaultTopicChips() {
    const defaults = ['Pricing','Vendor development','Personal','Finance','Legal','Logistics'];
    return defaults.map(t => `
      <div class="topic-picker-chip" data-topic="${t}">${t}</div>
    `).join('') + `<div class="topic-picker-chip add-topic-chip" id="sc-add-topic-btn">
      <i class="ti ti-plus"></i> New topic
    </div>`;
  }

  function _wireAddContactForm() {
    let colorIdx = 0;

    // Live avatar preview
    const updateAvatar = () => {
      const f = document.getElementById('sc-first').value.trim();
      const l = document.getElementById('sc-last').value.trim();
      const av = document.getElementById('sc-avatar');
      if (f || l) {
        const initials = (f[0] || '').toUpperCase() + (l[0] || '').toUpperCase();
        av.textContent = initials || f[0]?.toUpperCase() || '';
        if (!av.dataset.colorSet) {
          av.className = `avatar av-${AVATAR_COLORS[colorIdx % AVATAR_COLORS.length]}`;
          av.style.cssText = 'width:64px;height:64px;font-size:22px;margin:0 auto 8px';
          av.dataset.colorSet = '1';
        }
      } else {
        av.innerHTML = '<i class="ti ti-user" style="font-size:28px"></i>';
        av.className = 'avatar av-teal';
        av.style.cssText = 'width:64px;height:64px;font-size:22px;margin:0 auto 8px';
        delete av.dataset.colorSet;
      }
    };
    document.getElementById('sc-first').addEventListener('input', updateAvatar);
    document.getElementById('sc-last').addEventListener('input', updateAvatar);

    // Add phone
    document.getElementById('sc-add-phone').addEventListener('click', () => {
      const div = document.createElement('div');
      div.className = 'form-field phone-row';
      div.innerHTML = `
        <i class="ti ti-phone form-field-icon" style="opacity:0"></i>
        <select class="phone-type-select">
          <option value="mobile">Mobile</option>
          <option value="work">Work</option>
          <option value="home">Home</option>
          <option value="whatsapp">WhatsApp</option>
        </select>
        <input type="tel" placeholder="+91 98xxx xxxxx" class="form-input phone-input" style="flex:1" />
        <button onclick="this.parentElement.remove()" class="icon-btn" style="color:var(--text-tertiary)"><i class="ti ti-x"></i></button>`;
      document.getElementById('sc-phones').appendChild(div);
    });

    // Add email
    document.getElementById('sc-add-email').addEventListener('click', () => {
      const div = document.createElement('div');
      div.className = 'form-field';
      div.innerHTML = `
        <i class="ti ti-mail form-field-icon" style="opacity:0"></i>
        <div class="form-field-inner" style="flex:1">
          <input type="email" placeholder="another@example.com" class="form-input" />
        </div>
        <button onclick="this.parentElement.remove()" class="icon-btn" style="color:var(--text-tertiary)"><i class="ti ti-x"></i></button>`;
      document.getElementById('sc-emails').appendChild(div);
    });

    // Topic chips
    document.getElementById('sc-topics').addEventListener('click', e => {
      const chip = e.target.closest('.topic-picker-chip');
      if (!chip) return;
      if (chip.id === 'sc-add-topic-btn') {
        document.getElementById('sc-new-topic-row').style.display = 'flex';
        document.getElementById('sc-new-topic-input').focus();
        return;
      }
      chip.classList.toggle('active');
    });

    // New topic
    document.getElementById('sc-new-topic-confirm').addEventListener('click', _addNewTopicChip);
    document.getElementById('sc-new-topic-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') _addNewTopicChip();
    });
    document.getElementById('sc-new-topic-cancel').addEventListener('click', () => {
      document.getElementById('sc-new-topic-row').style.display = 'none';
      document.getElementById('sc-new-topic-input').value = '';
    });

    // Save
    document.getElementById('sc-save').addEventListener('click', _saveContact);
  }

  function _addNewTopicChip() {
    const input = document.getElementById('sc-new-topic-input');
    const val = input.value.trim();
    if (!val) return;
    const wrap = document.getElementById('sc-topics');
    const addBtn = document.getElementById('sc-add-topic-btn');
    const chip = document.createElement('div');
    chip.className = 'topic-picker-chip active';
    chip.dataset.topic = val;
    chip.textContent = val;
    wrap.insertBefore(chip, addBtn);
    document.getElementById('sc-new-topic-row').style.display = 'none';
    input.value = '';
  }

  function _saveContact() {
    const first = document.getElementById('sc-first').value.trim();
    if (!first) {
      document.getElementById('sc-first').focus();
      document.getElementById('sc-first').style.borderBottom = '2px solid #E24B4A';
      return;
    }

    // Phones
    const phones = [];
    document.querySelectorAll('#sc-phones .phone-row').forEach(row => {
      const type = row.querySelector('.phone-type-select')?.value;
      const number = row.querySelector('.phone-input')?.value.trim();
      if (number) phones.push({ type, number });
    });

    // Emails
    const emails = [];
    document.querySelectorAll('#sc-emails input[type="email"]').forEach(inp => {
      if (inp.value.trim()) emails.push(inp.value.trim());
    });

    // Topics
    const topics = [];
    document.querySelectorAll('#sc-topics .topic-picker-chip.active').forEach(chip => {
      if (chip.dataset.topic) topics.push(chip.dataset.topic);
    });

    // Avatar color
    const av = document.getElementById('sc-avatar');
    const colorClass = av.className.match(/av-(\w+)/)?.[1] || 'teal';

    const id = TL_DB.createContact({
      first_name: first,
      last_name: document.getElementById('sc-last').value.trim(),
      descriptor: document.getElementById('sc-descriptor').value.trim(),
      notes: document.getElementById('sc-notes').value.trim(),
      avatar_color: colorClass,
      phones,
      emails,
      topics,
    });

    TL_SHEETS.close();
    TL_APP.toast(`${first} added`);
    render();
    // Open their timeline immediately
    setTimeout(() => TL_APP.openContact(id), 300);
  }

  // ── Form styles (injected once) ───────────────────────────────────────────

  function _injectFormStyles() {
    if (document.getElementById('tl-form-styles')) return;
    const style = document.createElement('style');
    style.id = 'tl-form-styles';
    style.textContent = `
      .form-section-label {
        font-size: 11px; font-weight: 600; letter-spacing: 0.07em;
        text-transform: uppercase; color: var(--text-tertiary);
        padding: 12px 0 6px;
      }
      .form-field {
        display: flex; align-items: center; gap: 10px;
        padding: 9px 0; border-bottom: 1px solid var(--border);
      }
      .form-field:last-of-type { border-bottom: none; }
      .form-field-icon { font-size: 18px; color: var(--text-tertiary); flex-shrink: 0; width: 20px; text-align: center; }
      .form-field-inner { flex: 1; min-width: 0; }
      .form-field-label { font-size: 10px; color: var(--text-tertiary); margin-bottom: 2px; }
      .form-input {
        width: 100%; border: none; background: none; outline: none;
        font-size: 14px; color: var(--text-primary); font-family: var(--font);
        padding: 0; resize: none;
      }
      .form-input::placeholder { color: var(--text-tertiary); }
      .form-textarea { line-height: 1.5; }
      .phone-row { gap: 8px; }
      .phone-type-select {
        font-size: 12px; color: var(--text-secondary);
        background: var(--bg-secondary); border: 1px solid var(--border);
        border-radius: var(--radius-sm); padding: 4px 6px;
        cursor: pointer; font-family: var(--font); outline: none; flex-shrink: 0;
      }
      .phone-input { flex: 1; }
      .add-more-btn {
        display: flex; align-items: center; gap: 4px;
        font-size: 13px; color: var(--tl-accent); background: none;
        border: none; cursor: pointer; padding: 8px 0;
        font-family: var(--font);
      }
      .topics-picker { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 0 8px; }
      .topic-picker-chip {
        font-size: 12px; font-weight: 500; padding: 5px 11px;
        border-radius: var(--radius-xl); cursor: pointer;
        border: 1px solid var(--border); background: var(--bg);
        color: var(--text-secondary); transition: all 0.1s;
        display: flex; align-items: center; gap: 4px; user-select: none;
      }
      .topic-picker-chip.active { background: #EEEDFE; color: #3C3489; border-color: #AFA9EC; }
      .add-topic-chip { border-style: dashed; color: var(--text-tertiary); }
      .new-topic-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
      .dir-toggle { display: flex; gap: 6px; flex-wrap: wrap; }
      .dir-btn {
        padding: 5px 12px; border-radius: var(--radius-xl); font-size: 12px;
        font-weight: 500; cursor: pointer; border: 1px solid var(--border);
        background: var(--bg); color: var(--text-secondary);
        font-family: var(--font); transition: all 0.1s; user-select: none;
      }
      .dir-btn.active { background: var(--tl-accent-light); color: var(--tl-accent-text); border-color: var(--tl-accent); }
      .toggle-row {
        display: flex; align-items: center; gap: 12px;
        padding: 12px 0; border-bottom: 1px solid var(--border); cursor: pointer;
      }
      .toggle-track {
        width: 38px; height: 22px; border-radius: 11px;
        background: var(--border-strong); position: relative;
        transition: background 0.2s; flex-shrink: 0;
      }
      .toggle-track.on { background: var(--tl-accent); }
      .toggle-thumb {
        width: 18px; height: 18px; border-radius: 50%; background: white;
        position: absolute; top: 2px; left: 2px; transition: left 0.2s;
      }
      .toggle-track.on .toggle-thumb { left: 18px; }
      .reminder-fields { padding-top: 4px; }
      .pri-toggle { display: flex; gap: 6px; }
      .pri-btn {
        flex: 1; padding: 7px; border-radius: var(--radius-md);
        font-size: 12px; font-weight: 500; cursor: pointer; text-align: center;
        border: 1px solid var(--border); background: var(--bg);
        color: var(--text-secondary); font-family: var(--font); transition: all 0.1s;
      }
      .pri-btn.active-low  { background: var(--tl-accent-light); color: var(--tl-accent-text); border-color: var(--tl-accent); }
      .pri-btn.active-med  { background: #FAEEDA; color: #633806; border-color: #EF9F27; }
      .pri-btn.active-high { background: #FCEBEB; color: #791F1F; border-color: #F09595; }
    `;
    document.head.appendChild(style);
  }

  // ── Edit Contact Sheet ────────────────────────────────────────────────────

  function openEditContact(contact) {
    const phones = TL_DB.getContactPhones(contact.id);
    const emails = TL_DB.getContactEmails(contact.id);
    const topics = TL_DB.getContactTopics(contact.id);
    const content = document.getElementById('sheet-content');

    content.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">Edit — ${TL_APP._esc(contact.first_name)}</span>
        <button class="text-btn" id="ec-save">Save</button>
      </div>
      <div style="padding:0 16px 32px">
        <div class="form-section-label">Name</div>
        <div class="form-field">
          <i class="ti ti-user form-field-icon"></i>
          <div class="form-field-inner">
            <div class="form-field-label">First name *</div>
            <input type="text" id="ec-first" class="form-input" value="${TL_APP._esc(contact.first_name)}" />
          </div>
        </div>
        <div class="form-field">
          <i class="ti ti-user form-field-icon" style="opacity:0"></i>
          <div class="form-field-inner">
            <div class="form-field-label">Last name</div>
            <input type="text" id="ec-last" class="form-input" value="${TL_APP._esc(contact.last_name || '')}" />
          </div>
        </div>
        <div class="form-field">
          <i class="ti ti-tag form-field-icon"></i>
          <div class="form-field-inner">
            <div class="form-field-label">Descriptor tag</div>
            <input type="text" id="ec-descriptor" class="form-input" value="${TL_APP._esc(contact.descriptor || '')}" />
          </div>
        </div>

        <div class="form-section-label" style="margin-top:8px">Phone numbers</div>
        <div id="ec-phones">
          ${phones.length ? phones.map(p => `
            <div class="form-field phone-row">
              <i class="ti ti-phone form-field-icon"></i>
              <select class="phone-type-select">
                <option value="mobile" ${p.type==='mobile'?'selected':''}>Mobile</option>
                <option value="work" ${p.type==='work'?'selected':''}>Work</option>
                <option value="home" ${p.type==='home'?'selected':''}>Home</option>
                <option value="whatsapp" ${p.type==='whatsapp'?'selected':''}>WhatsApp</option>
              </select>
              <input type="tel" class="form-input phone-input" value="${TL_APP._esc(p.number)}" style="flex:1" />
              <button onclick="this.parentElement.remove()" class="icon-btn" style="color:var(--text-tertiary)"><i class="ti ti-x"></i></button>
            </div>`).join('') : `
            <div class="form-field phone-row">
              <i class="ti ti-phone form-field-icon"></i>
              <select class="phone-type-select">
                <option value="mobile">Mobile</option>
                <option value="work">Work</option>
                <option value="home">Home</option>
                <option value="whatsapp">WhatsApp</option>
              </select>
              <input type="tel" class="form-input phone-input" placeholder="+91 98xxx xxxxx" style="flex:1" />
            </div>`}
        </div>
        <button class="add-more-btn" id="ec-add-phone"><i class="ti ti-plus"></i> Add number</button>

        <div class="form-section-label" style="margin-top:8px">Email addresses</div>
        <div id="ec-emails">
          ${emails.length ? emails.map(e => `
            <div class="form-field">
              <i class="ti ti-mail form-field-icon"></i>
              <div class="form-field-inner" style="flex:1">
                <input type="email" class="form-input ec-email-input" value="${TL_APP._esc(e.email)}" />
              </div>
              <button onclick="this.parentElement.remove()" class="icon-btn" style="color:var(--text-tertiary)"><i class="ti ti-x"></i></button>
            </div>`).join('') : `
            <div class="form-field">
              <i class="ti ti-mail form-field-icon"></i>
              <div class="form-field-inner">
                <input type="email" class="form-input ec-email-input" placeholder="email@example.com" />
              </div>
            </div>`}
        </div>
        <button class="add-more-btn" id="ec-add-email"><i class="ti ti-plus"></i> Add email</button>

        <div class="form-section-label" style="margin-top:8px">Topics</div>
        <div class="topics-picker" id="ec-topics">
          ${topics.map(t => `<div class="topic-picker-chip active" data-topic="${TL_APP._esc(t.name)}">${TL_APP._esc(t.name)}</div>`).join('')}
          <div class="topic-picker-chip add-topic-chip" id="ec-add-topic-btn"><i class="ti ti-plus"></i> New</div>
        </div>
        <div class="new-topic-row" id="ec-new-topic-row" style="display:none">
          <input type="text" id="ec-new-topic-input" placeholder="Topic name…" class="form-input" style="flex:1" />
          <button class="text-btn" id="ec-topic-confirm">Add</button>
          <button class="icon-btn" id="ec-topic-cancel"><i class="ti ti-x"></i></button>
        </div>

        <div class="form-section-label" style="margin-top:8px">Notes</div>
        <div class="form-field" style="align-items:flex-start">
          <i class="ti ti-notes form-field-icon" style="margin-top:2px"></i>
          <div class="form-field-inner">
            <textarea id="ec-notes" class="form-input form-textarea" rows="3">${TL_APP._esc(contact.notes || '')}</textarea>
          </div>
        </div>

        <div style="height:8px"></div>
        <button onclick="TL_CONTACTS.deleteContact(${contact.id})"
          style="width:100%;padding:11px;border-radius:var(--radius-lg);background:none;border:1px solid #F09595;color:#A32D2D;font-size:14px;font-weight:500;cursor:pointer;font-family:var(--font)">
          <i class="ti ti-trash"></i> Delete contact
        </button>
      </div>`;

    _injectFormStyles();
    _wireEditContactForm(contact);
    TL_SHEETS.open();
  }

  function _wireEditContactForm(contact) {
    // Add phone
    document.getElementById('ec-add-phone').addEventListener('click', () => {
      const div = document.createElement('div');
      div.className = 'form-field phone-row';
      div.innerHTML = `
        <i class="ti ti-phone form-field-icon" style="opacity:0"></i>
        <select class="phone-type-select">
          <option value="mobile">Mobile</option>
          <option value="work">Work</option>
          <option value="home">Home</option>
          <option value="whatsapp">WhatsApp</option>
        </select>
        <input type="tel" class="form-input phone-input" placeholder="+91 98xxx xxxxx" style="flex:1" />
        <button onclick="this.parentElement.remove()" class="icon-btn" style="color:var(--text-tertiary)"><i class="ti ti-x"></i></button>`;
      document.getElementById('ec-phones').appendChild(div);
    });

    // Add email
    document.getElementById('ec-add-email').addEventListener('click', () => {
      const div = document.createElement('div');
      div.className = 'form-field';
      div.innerHTML = `
        <i class="ti ti-mail form-field-icon" style="opacity:0"></i>
        <div class="form-field-inner" style="flex:1">
          <input type="email" class="form-input ec-email-input" placeholder="email@example.com" />
        </div>
        <button onclick="this.parentElement.remove()" class="icon-btn" style="color:var(--text-tertiary)"><i class="ti ti-x"></i></button>`;
      document.getElementById('ec-emails').appendChild(div);
    });

    // Topics
    document.getElementById('ec-topics').addEventListener('click', e => {
      const chip = e.target.closest('.topic-picker-chip');
      if (!chip) return;
      if (chip.id === 'ec-add-topic-btn') {
        document.getElementById('ec-new-topic-row').style.display = 'flex';
        document.getElementById('ec-new-topic-input').focus();
        return;
      }
      chip.classList.toggle('active');
    });

    document.getElementById('ec-topic-confirm').addEventListener('click', () => {
      const inp = document.getElementById('ec-new-topic-input');
      const val = inp.value.trim();
      if (!val) return;
      const wrap = document.getElementById('ec-topics');
      const addBtn = document.getElementById('ec-add-topic-btn');
      const chip = document.createElement('div');
      chip.className = 'topic-picker-chip active';
      chip.dataset.topic = val;
      chip.textContent = val;
      wrap.insertBefore(chip, addBtn);
      document.getElementById('ec-new-topic-row').style.display = 'none';
      inp.value = '';
    });

    document.getElementById('ec-topic-cancel').addEventListener('click', () => {
      document.getElementById('ec-new-topic-row').style.display = 'none';
    });

    // Save
    document.getElementById('ec-save').addEventListener('click', () => {
      const first = document.getElementById('ec-first').value.trim();
      if (!first) { document.getElementById('ec-first').focus(); return; }

      // Update basic fields
      TL_DB.updateContact(contact.id, {
        first_name: first,
        last_name: document.getElementById('ec-last').value.trim(),
        descriptor: document.getElementById('ec-descriptor').value.trim(),
        notes: document.getElementById('ec-notes').value.trim(),
      });

      // Update phones — delete all and re-insert
      TL_DB._db()?.run(`DELETE FROM contact_phones WHERE contact_id = ?`, [contact.id]);
      document.querySelectorAll('#ec-phones .phone-row').forEach(row => {
        const type = row.querySelector('.phone-type-select')?.value;
        const number = row.querySelector('.phone-input')?.value.trim();
        if (number) TL_DB._db()?.run(`INSERT INTO contact_phones(contact_id,type,number) VALUES(?,?,?)`, [contact.id, type, number]);
      });

      // Update emails — delete all and re-insert
      TL_DB._db()?.run(`DELETE FROM contact_emails WHERE contact_id = ?`, [contact.id]);
      document.querySelectorAll('#ec-emails .ec-email-input').forEach(inp => {
        if (inp.value.trim()) TL_DB._db()?.run(`INSERT INTO contact_emails(contact_id,email) VALUES(?,?)`, [contact.id, inp.value.trim()]);
      });

      // Topics
      document.querySelectorAll('#ec-topics .topic-picker-chip.active').forEach(chip => {
        if (chip.dataset.topic) TL_DB.createTopic(contact.id, chip.dataset.topic);
      });

      TL_DB.persist();
      TL_SHEETS.close();
      TL_APP.toast('Contact updated');
      TL_CONTACTS.render();
      TL_APP.openContact(contact.id);
    });
  }

  function deleteContact(id) {
    if (!confirm('Delete this contact and all their entries? This cannot be undone.')) return;
    TL_DB.deleteContact(id);
    TL_SHEETS.close();
    TL_APP.showView('view-contacts');
    TL_CONTACTS.render();
    TL_APP.toast('Contact deleted');
  }

  // ── Public ────────────────────────────────────────────────────────────────

  return { render, openAddContact, openEditContact, deleteContact, injectFormStyles: _injectFormStyles };

})();
