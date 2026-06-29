/**
 * ThreadLog — Timeline (timeline.js)
 * Renders the per-contact activity timeline with date groups,
 * entry cards, topic filters, and empty states.
 */

const TL_TIMELINE = (() => {

  const TYPE_META = {
    call:  { icon: 'ti-phone',           badge: 'tb-call',  label: 'Call' },
    sms:   { icon: 'ti-message',         badge: 'tb-sms',   label: 'SMS' },
    email: { icon: 'ti-mail',            badge: 'tb-email', label: 'Email' },
    meet:  { icon: 'ti-video',           badge: 'tb-meet',  label: 'Meeting' },
    wa:    { icon: 'ti-brand-whatsapp',  badge: 'tb-wa',    label: 'WhatsApp' },
    doc:   { icon: 'ti-file',            badge: 'tb-doc',   label: 'Document' },
    note:  { icon: 'ti-notes',           badge: 'tb-note',  label: 'Note' },
  };

  // ── Topics bar ────────────────────────────────────────────────────────────

  function renderTopics(contact) {
    const bar = document.getElementById('topic-filters');
    const topics = TL_DB.getContactTopics(contact.id);

    // Always start with All chip
    let html = `<span class="topic-label">Topics</span>
      <div class="topic-chip active" data-topic-id="all">All</div>`;

    topics.forEach(t => {
      html += `<div class="topic-chip" data-topic-id="${t.id}">${TL_APP._esc(t.name)}</div>`;
    });

    bar.innerHTML = html;

    // Wire clicks
    bar.addEventListener('click', e => {
      const chip = e.target.closest('.topic-chip');
      if (!chip) return;
      bar.querySelectorAll('.topic-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      const topicId = chip.dataset.topicId === 'all' ? null : parseInt(chip.dataset.topicId);
      TL_APP.setTopicFilter(topicId);
    });
  }

  // ── Timeline entries ──────────────────────────────────────────────────────

  function renderEntries(contactId, { type = null, topicId = null } = {}) {
    const tl = document.getElementById('timeline');
    const entries = TL_DB.getEntries(contactId, { type, topicId, limit: 200 });

    if (!entries.length) {
      tl.innerHTML = `
        <div class="tl-empty">
          <i class="ti ti-timeline"></i>
          ${type || topicId
            ? 'No entries match this filter.<br>Try a different filter or log a new entry below.'
            : 'No activity logged yet.<br>Use the quick-add bar below to log your first entry.'}
        </div>`;
      return;
    }

    // Group by date
    const groups = _groupByDate(entries);
    let html = '';

    groups.forEach(group => {
      html += `<div class="tl-date">${group.label}</div>`;
      group.entries.forEach(e => {
        html += _entryCardHTML(e);
      });
    });

    tl.innerHTML = html;

    // Wire card clicks
    tl.addEventListener('click', e => {
      const card = e.target.closest('.tl-card');
      if (!card) return;
      const entryId = parseInt(card.dataset.entryId);
      const entry = TL_DB.getEntries(contactId, { limit: 500 }).find(e => e.id === entryId);
      if (entry) _openEntryDetail(entry, contactId);
    });
  }

  function _groupByDate(entries) {
    const groups = [];
    const map = {};
    const today = _dayKey(Date.now());
    const yesterday = _dayKey(Date.now() - 86400000);

    entries.forEach(e => {
      const key = _dayKey(e.timestamp);
      if (!map[key]) {
        let label;
        if (key === today) label = 'Today';
        else if (key === yesterday) label = 'Yesterday';
        else {
          const d = new Date(e.timestamp);
          const diff = Date.now() - e.timestamp;
          if (diff < 604800000) label = d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
          else label = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: diff > 31536000000 ? 'numeric' : undefined });
        }
        map[key] = { label, entries: [] };
        groups.push(map[key]);
      }
      map[key].entries.push(e);
    });

    return groups;
  }

  function _dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function _entryCardHTML(e) {
    const meta = TYPE_META[e.type] || TYPE_META.note;
    const time = new Date(e.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

    // Build body text
    let body = '';
    if (e.type === 'call') {
      const dir = e.direction === 'in' ? 'Incoming' : e.direction === 'missed' ? 'Missed' : 'Outgoing';
      const dur = e.duration_s ? ` · ${_formatDuration(e.duration_s)}` : '';
      body += `<strong>${dir}${dur}</strong>`;
      if (e.body) body += `<br>${TL_APP._esc(e.body)}`;
    } else if (e.type === 'email') {
      if (e.subject) body += `<strong>${TL_APP._esc(e.subject)}</strong>`;
      if (e.body) body += (body ? '<br>' : '') + TL_APP._esc(e.body);
      if (e.source_id && e.source_id.startsWith('gmail-')) {
        const msgId = e.source_id.replace('gmail-', '');
        body += `<br><a href="https://mail.google.com/mail/u/0/#all/${msgId}" target="_blank" rel="noopener" style="font-size:12px;color:var(--tl-accent);text-decoration:none" onclick="event.stopPropagation()"><i class="ti ti-external-link"></i> Open in Gmail</a>`;
      }
    } else if (e.type === 'meet') {
      const dur = e.duration_s ? ` · ${_formatDuration(e.duration_s)}` : '';
      const loc = e.location ? ` · ${TL_APP._esc(e.location)}` : '';
      body += `<strong>${e.direction === 'none' ? 'Meeting' : (e.direction === 'in' ? 'Online' : 'In person')}${dur}${loc}</strong>`;
      if (e.body) body += `<br>${TL_APP._esc(e.body)}`;
    } else if (e.type === 'doc') {
      if (e.doc_name) body += `<strong>Shared:</strong> ${TL_APP._esc(e.doc_name)}`;
      if (e.doc_url) body += ` <a href="${TL_APP._esc(e.doc_url)}" target="_blank" rel="noopener" style="color:var(--tl-accent);text-decoration:none" onclick="event.stopPropagation()">↗ Open</a>`;
      if (e.body) body += `<br>${TL_APP._esc(e.body)}`;
    } else if (e.type === 'wa') {
      const lines = (e.body || '').split('\n').filter(Boolean);
      body = lines.map(line => {
        // Split on first colon after sender name
        const colonIdx = line.indexOf(']: ');
        if (colonIdx !== -1) {
          const meta = line.slice(0, colonIdx + 1); // e.g. "Joe [10:24 am]"
          const msg = line.slice(colonIdx + 3);
          return `<div style="padding:2px 0;border-bottom:1px solid var(--border)"><span style="font-size:11px;color:var(--text-tertiary)">${TL_APP._esc(meta)}</span><br>${TL_APP._esc(msg)}</div>`;
        }
        return `<div style="padding:2px 0">${TL_APP._esc(line)}</div>`;
      }).join('');
    } else {
      body = TL_APP._esc(e.body || '');
    }

    // Topics
    const topicTags = (e.topics || []).map(t =>
      `<span class="topic-tag">${TL_APP._esc(t.name)}</span>`
    ).join('');

    const autoBadge = e.auto_captured ? `<span class="auto-badge">AUTO</span>` : '';

    return `
      <div class="tl-card" data-type="${e.type}" data-entry-id="${e.id}">
        <div class="card-header">
          <div class="type-badge ${meta.badge}"><i class="ti ${meta.icon}"></i></div>
          <span class="card-type-name">${meta.label}</span>
          ${autoBadge}
          <span class="card-time">${time}</span>
        </div>
        <div class="card-body">${body || '<span style="color:var(--text-tertiary)">No notes</span>'}</div>
        ${topicTags ? `<div class="card-footer">${topicTags}</div>` : ''}
      </div>`;
  }

  function _formatDuration(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m} min`;
    return `${s}s`;
  }

  // ── Entry detail sheet ────────────────────────────────────────────────────

  function _openEntryDetail(entry, contactId) {
    const meta = TYPE_META[entry.type] || TYPE_META.note;
    const d = new Date(entry.timestamp);
    const dateStr = d.toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
    const timeStr = d.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12:true });

    const content = document.getElementById('sheet-content');
    content.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <div style="display:flex;align-items:center;gap:8px">
          <div class="type-badge ${meta.badge}" style="width:30px;height:30px;border-radius:8px;font-size:15px"><i class="ti ${meta.icon}"></i></div>
          <span class="sheet-title">${meta.label}</span>
        </div>
        <button class="icon-btn" id="ed-delete" title="Delete entry" style="color:var(--text-tertiary)"><i class="ti ti-trash"></i></button>
      </div>

      <div style="padding:16px">
        <div style="font-size:12px;color:var(--text-tertiary);margin-bottom:16px">${dateStr} · ${timeStr}</div>

        ${_entryDetailBody(entry)}

        ${(entry.topics||[]).length ? `
          <div style="margin-top:16px">
            <div class="form-section-label">Topics</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
              ${(entry.topics||[]).map(t => `<span class="topic-tag" style="font-size:12px;padding:3px 9px">${TL_APP._esc(t.name)}</span>`).join('')}
            </div>
          </div>` : ''}

        <div style="margin-top:20px;display:flex;gap:8px">
          <button class="icon-btn" id="ed-close" style="flex:1;background:var(--bg-secondary);border-radius:var(--radius-md);height:40px;font-size:13px;color:var(--text-secondary);font-family:var(--font)">Close</button>
        </div>
      </div>`;

    document.getElementById('ed-close').addEventListener('click', () => TL_SHEETS.close());
    document.getElementById('ed-delete').addEventListener('click', () => {
      if (confirm('Delete this entry?')) {
        TL_DB.deleteEntry(entry.id);
        TL_SHEETS.close();
        renderEntries(contactId, {
          type: TL_APP.activeTypeFilter === 'all' ? null : TL_APP.activeTypeFilter,
          topicId: TL_APP.activeTopicId,
        });
        TL_APP.toast('Entry deleted');
      }
    });

    TL_SHEETS.open();
  }

  function _entryDetailBody(e) {
    let html = '';

    if (e.type === 'call') {
      const dir = { in:'Incoming', out:'Outgoing', missed:'Missed' }[e.direction] || 'Call';
      html += `<div style="font-size:15px;font-weight:500;color:var(--text-primary);margin-bottom:8px">${dir} call</div>`;
      if (e.duration_s) html += `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px">Duration: ${_formatDuration(e.duration_s)}</div>`;
    }
    if (e.type === 'meet') {
      const type = e.direction === 'in' ? 'Online meeting' : e.direction === 'out' ? 'In-person meeting' : 'Meeting';
      html += `<div style="font-size:15px;font-weight:500;color:var(--text-primary);margin-bottom:8px">${type}</div>`;
      if (e.duration_s) html += `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:4px">Duration: ${_formatDuration(e.duration_s)}</div>`;
      if (e.location) html += `<div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px">Location: ${TL_APP._esc(e.location)}</div>`;
    }
    if (e.type === 'email' && e.subject) {
      html += `<div style="font-size:15px;font-weight:500;color:var(--text-primary);margin-bottom:8px">${TL_APP._esc(e.subject)}</div>`;
    }
    if (e.type === 'doc') {
      if (e.doc_name) html += `<div style="font-size:15px;font-weight:500;color:var(--text-primary);margin-bottom:4px">${TL_APP._esc(e.doc_name)}</div>`;
      if (e.doc_type) html += `<div style="font-size:12px;color:var(--text-tertiary);margin-bottom:8px">${TL_APP._esc(e.doc_type)}</div>`;
      if (e.doc_url) html += `<a href="${TL_APP._esc(e.doc_url)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--tl-accent);text-decoration:none;margin-bottom:12px"><i class="ti ti-external-link"></i> Open document</a>`;
    }
    if (e.body) {
      html += `<div style="font-size:14px;color:var(--text-primary);line-height:1.6;white-space:pre-wrap;border-top:${(e.type==='call'||e.type==='meet'||e.type==='email'||e.type==='doc')?'1px solid var(--border)':'none'};padding-top:${(e.type==='call'||e.type==='meet'||e.type==='email'||e.type==='doc')?'12px':'0'}">${TL_APP._esc(e.body)}</div>`;
    }
    if (!e.body && e.type === 'note') {
      html += `<div style="font-size:14px;color:var(--text-tertiary)">No note content</div>`;
    }

    return html || `<div style="font-size:14px;color:var(--text-tertiary)">No details recorded</div>`;
  }

  // ── Public ────────────────────────────────────────────────────────────────

  return { renderTopics, renderEntries };

})();
