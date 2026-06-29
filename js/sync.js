/**
 * ThreadLog — Sync (sync.js)
 * 1. WhatsApp export parser
 * 2. Google OAuth (Gmail + Calendar)
 * 3. Gmail auto-capture
 * 4. Google Calendar auto-capture
 */

const TL_SYNC = (() => {

  // ── WhatsApp Parser ───────────────────────────────────────────────────────

  /**
   * Parse a WhatsApp exported .txt file into structured messages.
   * Handles both 12h and 24h formats, and both / and - date separators.
   *
   * Line formats:
   *   22/06/2026, 10:24 am - Joe Sharma: Hello
   *   22/06/2026, 22:24 - Joe Sharma: Hello
   *   [22/06/2026, 10:24 am] Joe Sharma: Hello
   */
  function parseWhatsAppExport(text) {
    const messages = [];

    // Match both bracket and dash formats
    const lineRegex = /^[\[‎]?(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]m)?)\]?\s*[-–]\s*([^:]+?):\s(.+)$/im;

    const lines = text.split('\n');
    let currentMsg = null;

    lines.forEach(line => {
      line = line.trim();
      if (!line) return;

      // Skip system messages
      if (line.includes('Messages and calls are end-to-end encrypted') ||
          line.includes('created group') ||
          line.includes('added you') ||
          line.includes('changed the subject') ||
          line.includes('changed this group') ||
          line.includes('<Media omitted>') ||
          line.includes('This message was deleted')) return;

      const match = line.match(lineRegex);
      if (match) {
        // Save previous message
        if (currentMsg) messages.push(currentMsg);

        const [, dateStr, timeStr, sender, body] = match;
        const timestamp = _parseWADate(dateStr, timeStr);

        currentMsg = {
          timestamp,
          sender: sender.trim(),
          body: body.trim(),
          isOwn: _isOwnMessage(sender.trim()),
        };
      } else if (currentMsg) {
        // Continuation line — append to previous message body
        currentMsg.body += '\n' + line;
      }
    });

    if (currentMsg) messages.push(currentMsg);
    return messages;
  }

  function _parseWADate(dateStr, timeStr) {
    try {
      // Normalise date — handle d/m/yy, d/m/yyyy, d-m-yy etc.
      const dateParts = dateStr.split(/[\/\-]/);
      let day, month, year;

      if (dateParts.length === 3) {
        // WhatsApp exports in M/D/YY format (e.g. 3/28/26 = March 28, 2026)
        month = parseInt(dateParts[0]) - 1; // JS months are 0-indexed
        day   = parseInt(dateParts[1]);
        year  = parseInt(dateParts[2]);
        if (year < 100) year += 2000;
      }

      // Normalise time — handle 10:24 am, 22:24, 10:24:05 am
      let hours = 0, minutes = 0;
      const timeParts = timeStr.trim().toLowerCase();
      const isPM = timeParts.includes('pm');
      const isAM = timeParts.includes('am');
      const timeNumbers = timeParts.replace(/[ap]m/i, '').trim().split(':');
      hours = parseInt(timeNumbers[0]);
      minutes = parseInt(timeNumbers[1]);

      if (isPM && hours !== 12) hours += 12;
      if (isAM && hours === 12) hours = 0;

      const d = new Date(year, month, day, hours, minutes, 0);
      return d.getTime();
    } catch (e) {
      return Date.now();
    }
  }

  function _isOwnMessage(sender) {
    // Common own-message indicators in WhatsApp exports
    const ownIndicators = ['you', 'me', 'yourself'];
    return ownIndicators.some(s => sender.toLowerCase() === s);
  }

  /**
   * Import parsed WhatsApp messages into ThreadLog for a contact.
   * Groups consecutive messages into conversation blocks.
   */
  function importWhatsAppMessages(messages, contactId, topicNames = []) {
    if (!messages.length) return 0;

    // Group messages by day
    const dayGroups = {};
    messages.forEach(msg => {
      const dayKey = new Date(msg.timestamp).toDateString();
      if (!dayGroups[dayKey]) dayGroups[dayKey] = [];
      dayGroups[dayKey].push(msg);
    });

    let imported = 0;

    Object.entries(dayGroups).forEach(([day, msgs]) => {
      // Format as a clean conversation — each message on its own line
      const body = msgs.map(m => {
        const time = new Date(m.timestamp).toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', hour12: true
        });
        // Shorten long sender names — take first name only
        const sender = m.sender.split(' ')[0];
        return `${sender} [${time}]: ${m.body}`;
      }).join('\n');

      // Use timestamp of first message in the group
      const timestamp = msgs[0].timestamp;

      // Check if already imported (avoid duplicates)
      const sourceId = `wa-${contactId}-${timestamp}`;
      if (TL_DB.entryExistsBySourceId(sourceId)) return;

      TL_DB.createEntry({
        contact_id: contactId,
        type: 'wa',
        direction: 'none',
        timestamp,
        body,
        source_id: sourceId,
        topic_names: topicNames,
      });

      imported++;
    });

    return imported;
  }

  // ── WhatsApp Import UI ────────────────────────────────────────────────────

  function openWhatsAppImport(contact) {
    const topics = TL_DB.getContactTopics(contact.id);
    const content = document.getElementById('sheet-content');

    content.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">WhatsApp Import — ${TL_APP._esc(contact.first_name)}</span>
        <button class="icon-btn" onclick="TL_SHEETS.close()"><i class="ti ti-x"></i></button>
      </div>
      <div style="padding:0 16px 32px">

        <div style="background:var(--c-wa);border-radius:var(--radius-lg);padding:14px;margin:12px 0">
          <div style="font-size:13px;font-weight:500;color:var(--c-wa-fg);margin-bottom:6px">
            <i class="ti ti-brand-whatsapp"></i> How to export from WhatsApp
          </div>
          <div style="font-size:12px;color:var(--c-wa-fg);line-height:1.7;opacity:0.85">
            1. Open WhatsApp → chat with ${TL_APP._esc(contact.first_name)}<br>
            2. Tap ⋮ More → Export chat<br>
            3. Choose <strong>Without media</strong><br>
            4. Save the .txt file and select it below
          </div>
        </div>

        <div id="wa-drop-zone" style="border:2px dashed var(--border-strong);border-radius:var(--radius-lg);padding:28px;text-align:center;cursor:pointer;margin:12px 0;transition:border-color 0.15s"
          onclick="document.getElementById('wa-file-input').click()"
          ondragover="event.preventDefault();this.style.borderColor='var(--tl-accent)'"
          ondragleave="this.style.borderColor='var(--border-strong)'"
          ondrop="TL_SYNC.handleWADrop(event, ${contact.id})">
          <i class="ti ti-file-text" style="font-size:32px;color:var(--text-tertiary);display:block;margin-bottom:10px;opacity:0.5"></i>
          <div style="font-size:14px;font-weight:500;color:var(--text-primary);margin-bottom:4px">Tap to select .txt file</div>
          <div style="font-size:12px;color:var(--text-tertiary)">Or drag and drop here</div>
        </div>
        <input type="file" id="wa-file-input" accept=".txt" style="display:none" />

        <div id="wa-preview" style="display:none">
          <div style="font-size:11px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:var(--text-tertiary);padding:12px 0 6px">Preview</div>
          <div id="wa-preview-content" style="background:var(--bg-secondary);border-radius:var(--radius-lg);padding:12px;max-height:200px;overflow-y:auto;font-size:12px;color:var(--text-secondary);line-height:1.6"></div>
          <div style="font-size:12px;color:var(--text-tertiary);margin-top:6px" id="wa-msg-count"></div>
        </div>

        <div id="wa-topics-wrap" style="display:none">
          <div style="font-size:11px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:var(--text-tertiary);padding:12px 0 6px">Tag with topics</div>
          <div class="topics-picker" id="wa-topics">
            ${topics.map(t => `<div class="topic-picker-chip" data-topic="${TL_APP._esc(t.name)}">${TL_APP._esc(t.name)}</div>`).join('')}
            <div class="topic-picker-chip add-topic-chip" onclick="document.getElementById('wa-new-topic-row').style.display='flex'"><i class="ti ti-plus"></i> New</div>
          </div>
          <div class="new-topic-row" id="wa-new-topic-row" style="display:none">
            <input type="text" id="wa-new-topic-input" placeholder="Topic name…" class="form-input" style="flex:1" />
            <button class="text-btn" onclick="TL_SYNC.addWATopic()">Add</button>
            <button class="icon-btn" onclick="document.getElementById('wa-new-topic-row').style.display='none'"><i class="ti ti-x"></i></button>
          </div>
        </div>

        <div id="wa-import-btn-wrap" style="display:none;margin-top:16px">
          <button id="wa-import-btn" onclick="TL_SYNC.confirmWAImport(${contact.id})"
            style="width:100%;padding:12px;border-radius:var(--radius-lg);background:var(--tl-accent);color:white;border:none;font-size:14px;font-weight:500;cursor:pointer;font-family:var(--font)">
            Import messages
          </button>
        </div>

        <div id="wa-success" style="display:none;background:var(--tl-accent-light);border-radius:var(--radius-lg);padding:14px;margin-top:12px;text-align:center">
          <i class="ti ti-circle-check" style="font-size:24px;color:var(--tl-accent);display:block;margin-bottom:6px"></i>
          <div style="font-size:14px;font-weight:500;color:var(--tl-accent-text)" id="wa-success-msg"></div>
        </div>
      </div>`;

    // Wire file input
    document.getElementById('wa-file-input').addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) _handleWAFile(file, contact.id);
    });

    // Wire topic chips
    document.getElementById('wa-topics')?.addEventListener('click', e => {
      const chip = e.target.closest('.topic-picker-chip');
      if (chip && !chip.classList.contains('add-topic-chip')) {
        chip.classList.toggle('active');
      }
    });

    TL_CONTACTS.injectFormStyles();
    TL_SHEETS.open();
  }

  let _parsedMessages = [];

  function _handleWAFile(file, contactId) {
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target.result;
      _parsedMessages = parseWhatsAppExport(text);

      if (!_parsedMessages.length) {
        document.getElementById('wa-preview-content').textContent = 'No messages found. Make sure this is a WhatsApp export .txt file.';
        document.getElementById('wa-preview').style.display = 'block';
        return;
      }

      // Show preview — first 10 messages
      const preview = _parsedMessages.slice(0, 10).map(m =>
        `<div style="padding:3px 0;border-bottom:1px solid var(--border)">
          <span style="color:var(--text-tertiary);font-size:11px">${new Date(m.timestamp).toLocaleDateString('en-IN', {day:'numeric',month:'short'})} ${new Date(m.timestamp).toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',hour12:true})}</span><br>
          <strong>${TL_APP._esc(m.sender)}:</strong> ${TL_APP._esc(m.body.slice(0, 80))}${m.body.length > 80 ? '…' : ''}
        </div>`
      ).join('');

      document.getElementById('wa-preview-content').innerHTML = preview;
      document.getElementById('wa-msg-count').textContent = `${_parsedMessages.length} messages found across ${_countDays(_parsedMessages)} days`;
      document.getElementById('wa-preview').style.display = 'block';
      document.getElementById('wa-topics-wrap').style.display = 'block';
      document.getElementById('wa-import-btn-wrap').style.display = 'block';
      document.getElementById('wa-drop-zone').style.display = 'none';
    };
    reader.readAsText(file);
  }

  function _countDays(messages) {
    return new Set(messages.map(m => new Date(m.timestamp).toDateString())).size;
  }

  function handleWADrop(event, contactId) {
    event.preventDefault();
    document.getElementById('wa-drop-zone').style.borderColor = 'var(--border-strong)';
    const file = event.dataTransfer.files[0];
    if (file && file.name.endsWith('.txt')) {
      _handleWAFile(file, contactId);
    } else {
      TL_APP.toast('Please drop a .txt file');
    }
  }

  function addWATopic() {
    const inp = document.getElementById('wa-new-topic-input');
    const val = inp.value.trim();
    if (!val) return;
    const wrap = document.getElementById('wa-topics');
    const addBtn = wrap.querySelector('.add-topic-chip');
    const chip = document.createElement('div');
    chip.className = 'topic-picker-chip active';
    chip.dataset.topic = val;
    chip.textContent = val;
    chip.addEventListener('click', () => chip.classList.toggle('active'));
    wrap.insertBefore(chip, addBtn);
    document.getElementById('wa-new-topic-row').style.display = 'none';
    inp.value = '';
  }

  function confirmWAImport(contactId) {
    if (!_parsedMessages.length) return;

    const topicNames = [...document.querySelectorAll('#wa-topics .topic-picker-chip.active')]
      .map(c => c.dataset.topic).filter(Boolean);

    const imported = importWhatsAppMessages(_parsedMessages, contactId, topicNames);

    document.getElementById('wa-import-btn-wrap').style.display = 'none';
    document.getElementById('wa-topics-wrap').style.display = 'none';
    document.getElementById('wa-preview').style.display = 'none';
    document.getElementById('wa-success').style.display = 'block';
    document.getElementById('wa-success-msg').textContent =
      imported > 0
        ? `${imported} day${imported > 1 ? 's' : ''} of messages imported successfully`
        : 'Already imported — no new messages found';

    _parsedMessages = [];

    // Refresh timeline after a moment
    setTimeout(() => {
      TL_SHEETS.close();
      const contact = TL_DB.getContact(contactId);
      if (contact) {
        TL_TIMELINE.renderTopics(contact);
        TL_TIMELINE.renderEntries(contactId, {});
      }
      TL_APP.toast('WhatsApp messages imported ✓');
    }, 1500);
  }

  // ── Google OAuth ──────────────────────────────────────────────────────────

  const GOOGLE_CLIENT_ID = '658624997765-0qcshd25frgn3hugi3du3a2gl7atv49k.apps.googleusercontent.com'; // Set after Google Cloud setup
  const GOOGLE_SCOPES = [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/userinfo.email',
  ].join(' ');

  let _googleToken = null;

 function startGoogleAuth() {
    if (!GOOGLE_CLIENT_ID) {
      TL_APP.toast('Google Cloud not set up yet');
      return;
    }

    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: window.location.origin + '/app/index.html',
      response_type: 'token',
      scope: GOOGLE_SCOPES,
      include_granted_scopes: 'true',
    });

    const popup = window.open(
      `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      'googleauth',
      'width=500,height=600,left=200,top=100'
    );

    // Poll for token in popup URL
    const timer = setInterval(() => {
      try {
        const url = popup.location.href;
        if (url.includes('access_token')) {
          clearInterval(timer);
          const hash = popup.location.hash;
          popup.close();
          const p = new URLSearchParams(hash.slice(1));
          const token = p.get('access_token');
          if (token) {
            TL_DB.setSetting('google_token', token);
            TL_DB.setSetting('google_connected', 'true');
            fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
              headers: { Authorization: `Bearer ${token}` }
            }).then(r => r.json()).then(data => {
              TL_DB.setSetting('google_email', data.email || 'Connected');
              TL_APP.toast(`✓ Connected: ${data.email}`);
              TL_SHEETS.openSettings();
              setTimeout(() => { TL_SYNC.syncGmail(); TL_SYNC.syncCalendar(); }, 1000);
            });
          }
        }
      } catch(e) {
        // Cross-origin — popup still on Google's page, keep waiting
      }
      if (popup.closed) clearInterval(timer);
    }, 500);
  }

  function handleGoogleCallback(token, email) {
    _googleToken = token;
    TL_DB.setSetting('google_connected', 'true');
    TL_DB.setSetting('google_email', email);
    TL_APP.toast(`Connected: ${email}`);
    TL_SHEETS.openSettings();
    // Start syncing
    syncGmail();
    syncCalendar();
  }

  // ── Gmail Sync ────────────────────────────────────────────────────────────

  async function syncGmail() {
    if (!_googleToken) {
      _googleToken = TL_DB.getSetting('google_token');
      if (!_googleToken) return;
    }

    const contacts = TL_DB.getContacts();
    const emails = contacts.flatMap(c =>
      TL_DB.getContactEmails(c.id).map(e => ({ email: e.email, contact: c }))
    );

    if (!emails.length) {
      TL_APP.toast('Add email addresses to contacts first');
      return;
    }

    let totalImported = 0;

    for (const { email, contact } of emails) {
      try {
        const imported = await _fetchGmailThreads(email, contact);
        totalImported += imported;
      } catch (e) {
        console.error(`[Sync] Gmail error for ${email}:`, e);
      }
    }

    TL_DB.setSetting('last_gmail_sync', Date.now().toString());
    if (totalImported > 0) {
      TL_APP.toast(`${totalImported} emails imported`);
    }
  }

  async function _fetchGmailThreads(email, contact) {
    const query = encodeURIComponent(`from:${email} OR to:${email}`);
    const syncFromDate = TL_DB.getSetting('gmail_sync_from_date');
    const queryStr = syncFromDate
      ? `${query} after:${Math.floor(new Date(syncFromDate).getTime() / 1000)}`
      : decodeURIComponent(query);

    const res = await fetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages?q=${queryStr}&maxResults=50`,
      { headers: { Authorization: `Bearer ${_googleToken}` } }
    );

    if (!res.ok) throw new Error(`Gmail API error: ${res.status}`);
    const data = await res.json();
    if (!data.messages?.length) return 0;

    let imported = 0;

    for (const msg of data.messages.slice(0, 50)) {
      try {
        const detail = await fetch(
          `https://www.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${_googleToken}` } }
        );
        const msgData = await detail.json();

        const sourceId = `gmail-${msg.id}`;
        if (TL_DB.entryExistsBySourceId(sourceId)) continue;

        const headers = {};
        msgData.payload?.headers?.forEach(h => { headers[h.name] = h.value; });

        const subject = headers['Subject'] || '(no subject)';
        const from = headers['From'] || '';
        const date = headers['Date'] ? new Date(headers['Date']).getTime() : Date.now();
        const direction = from.toLowerCase().includes(email.toLowerCase()) ? 'in' : 'out';

        TL_DB.createEntry({
          contact_id: contact.id,
          type: 'email',
          direction,
          timestamp: date,
          subject,
          body: `From: ${from}`,
          auto_captured: 1,
          source_id: sourceId,
          topic_names: [],
        });

        imported++;
      } catch (e) {
        console.warn('[Sync] Error fetching message:', e);
      }
    }

    return imported;
  }

  // ── Google Calendar Sync ──────────────────────────────────────────────────

  async function syncCalendar() {
    if (!_googleToken) return;

    const contacts = TL_DB.getContacts();
    const contactEmails = {};
    contacts.forEach(c => {
      TL_DB.getContactEmails(c.id).forEach(e => {
        contactEmails[e.email.toLowerCase()] = c;
      });
    });

    if (!Object.keys(contactEmails).length) return;

    try {
      // Fetch events from the last 30 days and next 30 days
      const timeMin = new Date(Date.now() - 30 * 86400000).toISOString();
      const timeMax = new Date(Date.now() + 30 * 86400000).toISOString();

      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&maxResults=100&singleEvents=true`,
        { headers: { Authorization: `Bearer ${_googleToken}` } }
      );

      if (!res.ok) throw new Error(`Calendar API error: ${res.status}`);
      const data = await res.json();

      let imported = 0;

      for (const event of data.items || []) {
        const attendees = event.attendees || [];
        const attendeeEmails = attendees.map(a => a.email?.toLowerCase()).filter(Boolean);

        // Find if any contact is an attendee
        const matchedContact = Object.entries(contactEmails).find(([email]) =>
          attendeeEmails.includes(email)
        )?.[1];

        if (!matchedContact) continue;

        const sourceId = `cal-${event.id}`;
        if (TL_DB.entryExistsBySourceId(sourceId)) continue;

        const start = event.start?.dateTime || event.start?.date;
        const timestamp = start ? new Date(start).getTime() : Date.now();
        const endTime = event.end?.dateTime || event.end?.date;
        const duration_s = endTime && start
          ? Math.floor((new Date(endTime) - new Date(start)) / 1000)
          : null;

        const isOnline = !!(event.hangoutLink || event.conferenceData);
        const location = event.hangoutLink || event.location || null;

        TL_DB.createEntry({
          contact_id: matchedContact.id,
          type: 'meet',
          direction: isOnline ? 'in' : 'out',
          timestamp,
          duration_s,
          subject: event.summary || 'Meeting',
          body: event.description || null,
          location,
          auto_captured: 1,
          source_id: sourceId,
          topic_names: [],
        });

        imported++;
      }

      TL_DB.setSetting('last_calendar_sync', Date.now().toString());
      if (imported > 0) TL_APP.toast(`${imported} meetings imported from Calendar`);

    } catch (e) {
      console.error('[Sync] Calendar error:', e);
    }
  }

  // ── Auto sync on schedule ─────────────────────────────────────────────────

  function startAutoSync() {
    if (TL_DB.getSetting('google_connected') !== 'true') return;

    const freqMin = parseInt(TL_DB.getSetting('gmail_sync_freq_min') || '30');
    const freqMs = freqMin * 60 * 1000;

    setInterval(() => {
      if (TL_DB.getSetting('gmail_sync') === 'true') syncGmail();
      if (TL_DB.getSetting('calendar_sync') === 'true') syncCalendar();
    }, freqMs);
  }

  // ── Public ────────────────────────────────────────────────────────────────

  return {
    // WhatsApp
    parseWhatsAppExport,
    importWhatsAppMessages,
    openWhatsAppImport,
    handleWADrop,
    addWATopic,
    confirmWAImport,
    // Google
    startGoogleAuth,
    handleGoogleCallback,
    syncGmail,
    syncCalendar,
    startAutoSync,
  };

})();
