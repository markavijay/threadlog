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

  // Entry highlight colors — free-form flags for priority/importance, independent
  // of entry type. Stored in entries.highlight_color; null/undefined = no flag.
  const HIGHLIGHT_COLORS = [
    { key: 'red',    label: 'Urgent',    hex: '#E5484D' },
    { key: 'amber',  label: 'Important', hex: '#F5A524' },
    { key: 'green',  label: 'Resolved',  hex: '#2F9E67' },
    { key: 'blue',   label: 'Follow up', hex: '#3B82F6' },
    { key: 'purple', label: 'Personal',  hex: '#8B5CF6' },
  ];

  // ── Color filter chips (reused by app.js and projects.js) ─────────────────

  function colorFilterChipsHTML(active = 'all') {
    const isAll = active === 'all';
    const allChip = `
      <div class="chip" data-color="all" style="${isAll ? 'background:var(--tl-accent-light);color:var(--tl-accent-text);border-color:var(--tl-accent)' : ''}">
        <i class="ti ti-flag-2"></i> All
      </div>`;
    const colorChips = HIGHLIGHT_COLORS.map(h => {
      const isActive = active === h.key;
      return `
        <div class="chip" data-color="${h.key}" style="${isActive ? `background:${h.hex}22;color:${h.hex};border-color:${h.hex}` : ''}">
          <span style="width:8px;height:8px;border-radius:50%;background:${h.hex};display:inline-block;flex-shrink:0"></span> ${h.label}
        </div>`;
    }).join('');
    return allChip + colorChips;
  }

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

  function renderEntries(contactId, { type = null, topicId = null, color = null } = {}) {
    const tl = document.getElementById('timeline');
    const entries = TL_DB.getEntries(contactId, { type, topicId, color, limit: 200 });

    if (!entries.length) {
      tl.innerHTML = `
        <div class="tl-empty">
          <i class="ti ti-timeline"></i>
          ${type || topicId || color
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

    // Wire card clicks. "Open in Gmail" is now a plain target="_blank" anchor
    // (see _entryCardHTML) so the browser handles it natively — no JS needed here.
    tl.addEventListener('click', e => {
      if (e.target.closest('.gmail-open-link')) return;
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
      const dirIcon = e.direction === 'in'
        ? '<i class="ti ti-phone-incoming" style="font-size:12px;color:var(--tl-accent)"></i>'
        : e.direction === 'missed'
        ? '<i class="ti ti-phone-missed" style="font-size:12px;color:#E24B4A"></i>'
        : '<i class="ti ti-phone-outgoing" style="font-size:12px;color:var(--text-tertiary)"></i>';
      const dirLabel = e.direction === 'in' ? 'Incoming' : e.direction === 'missed' ? 'Missed call' : 'Outgoing';
      const dur = e.duration_s ? ` · <span style="color:var(--text-secondary)">${_formatDuration(e.duration_s)}</span>` : '';
      const missedStyle = e.direction === 'missed' ? 'color:#E24B4A;' : '';
      body += `<span style="display:inline-flex;align-items:center;gap:5px;${missedStyle}font-weight:500">${dirIcon} ${dirLabel}${dur}</span>`;
      if (e.body) body += `<br><span style="color:var(--text-secondary);font-size:13px">${TL_APP._esc(e.body)}</span>`;
    } else if (e.type === 'email') {
      if (e.subject) body += `<strong>${TL_APP._esc(e.subject)}</strong>`;
      if (e.body) body += (body ? '<br>' : '') + TL_APP._esc(e.body);
      if (e.source_id && e.source_id.startsWith('gmail-')) {
        const msgId = e.source_id.replace('gmail-', '');
        body += `<br><a href="https://mail.google.com/mail/u/0/#all/${msgId}" target="_blank" rel="noopener" class="gmail-open-link" style="font-size:12px;color:var(--tl-accent);text-decoration:none" onclick="event.stopPropagation()"><i class="ti ti-external-link"></i> Open in Gmail</a>`;
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

    // In a merged Project timeline, each entry carries a `.contact` object so the
    // card can show whose interaction this is (Section 7.3).
    const contactBadge = e.contact ? `
      <span style="display:inline-flex;align-items:center;gap:5px;margin-right:2px">
        <span class="mini-av av-${e.contact.avatar_color || 'teal'}" style="width:18px;height:18px;font-size:9px">${TL_APP._esc(e.contact.initials)}</span>
        <span style="font-size:12px;font-weight:500;color:var(--text-secondary)">${TL_APP._esc(e.contact.first_name)}</span>
      </span>
      <span style="color:var(--text-tertiary);font-size:11px">·</span>` : '';

    const highlight = HIGHLIGHT_COLORS.find(h => h.key === e.highlight_color);
    const highlightDot = highlight
      ? `<span title="${highlight.label}" style="width:8px;height:8px;border-radius:50%;background:${highlight.hex};flex-shrink:0"></span>`
      : '';
    const highlightRing = highlight ? `box-shadow:0 0 0 1.5px ${highlight.hex};` : '';

    return `
      <div class="tl-card" data-type="${e.type}" data-entry-id="${e.id}"${e.contact ? ` data-contact-id="${e.contact.id}"` : ''} style="${highlightRing}">
        <div class="card-header">
          ${contactBadge}
          <div class="type-badge ${meta.badge}"><i class="ti ${meta.icon}"></i></div>
          <span class="card-type-name">${meta.label}</span>
          ${autoBadge}
          ${highlightDot}
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
    if (m > 0) return s > 0 ? `${m}m ${s}s` : `${m} min`;
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

        <div style="margin-top:16px">
          <div class="form-section-label">Priority</div>
          <div style="display:flex;gap:10px;align-items:center;margin-top:6px">
            <button class="hl-swatch${!entry.highlight_color ? ' hl-swatch-active' : ''}" data-color=""
              title="None" style="width:26px;height:26px;border-radius:50%;border:1.5px dashed var(--border-strong);background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--text-tertiary);font-size:12px;padding:0">
              <i class="ti ti-x"></i>
            </button>
            ${HIGHLIGHT_COLORS.map(h => `
              <button class="hl-swatch${entry.highlight_color === h.key ? ' hl-swatch-active' : ''}" data-color="${h.key}"
                title="${h.label}" style="width:26px;height:26px;border-radius:50%;border:1.5px solid ${entry.highlight_color === h.key ? h.hex : 'transparent'};background:${h.hex};cursor:pointer;padding:0;box-shadow:${entry.highlight_color === h.key ? `0 0 0 2px var(--bg), 0 0 0 3.5px ${h.hex}` : 'none'}">
              </button>`).join('')}
          </div>
        </div>

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

    document.querySelectorAll('.hl-swatch').forEach(btn => {
      btn.addEventListener('click', () => {
        const color = btn.dataset.color || null;
        TL_DB.setEntryHighlight(entry.id, color);
        entry.highlight_color = color;
        document.querySelectorAll('.hl-swatch').forEach(b => {
          b.classList.remove('hl-swatch-active');
          const hex = HIGHLIGHT_COLORS.find(h => h.key === b.dataset.color)?.hex;
          if (hex) { b.style.border = '1.5px solid transparent'; b.style.boxShadow = 'none'; }
        });
        btn.classList.add('hl-swatch-active');
        const hex = HIGHLIGHT_COLORS.find(h => h.key === color)?.hex;
        if (hex) { btn.style.border = `1.5px solid ${hex}`; btn.style.boxShadow = `0 0 0 2px var(--bg), 0 0 0 3.5px ${hex}`; }
        // Refresh whichever timeline is currently visible behind this sheet —
        // a merged Project view or a single contact's timeline.
        const projectViewActive = document.getElementById('view-project-detail')?.classList.contains('active');
        if (projectViewActive && typeof TL_PROJECTS !== 'undefined') {
          TL_PROJECTS.refreshCurrentProject();
        } else {
          renderEntries(contactId, {
            type: TL_APP.activeTypeFilter === 'all' ? null : TL_APP.activeTypeFilter,
            topicId: TL_APP.activeTopicId,
            color: TL_APP.activeColorFilter === 'all' ? null : TL_APP.activeColorFilter,
          });
        }
      });
    });

    document.getElementById('ed-close').addEventListener('click', () => TL_SHEETS.close());
    document.getElementById('ed-delete').addEventListener('click', () => {
      if (confirm('Delete this entry?')) {
        TL_DB.deleteEntry(entry.id);
        TL_SHEETS.close();
        renderEntries(contactId, {
          type: TL_APP.activeTypeFilter === 'all' ? null : TL_APP.activeTypeFilter,
          topicId: TL_APP.activeTopicId,
          color: TL_APP.activeColorFilter === 'all' ? null : TL_APP.activeColorFilter,
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

  return {
    renderTopics, renderEntries,
    // Exposed so TL_PROJECTS can reuse the same grouping/card rendering
    // for the merged project timeline instead of duplicating formatting logic.
    groupByDate: _groupByDate,
    entryCardHTML: _entryCardHTML,
    openEntryDetail: _openEntryDetail,
    formatDuration: _formatDuration,
    HIGHLIGHT_COLORS,
    colorFilterChipsHTML,
  };

})();
