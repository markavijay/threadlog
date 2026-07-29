/**
 * ThreadLog — Event Log Sync Engine (eventlog.js)
 *
 * Devices never share threadlog.db directly. Instead, every local change is
 * appended as an event to THIS device's own log file (log-<deviceId>.jsonl),
 * living in the same Resilio-synced folder as threadlog.db. Because no two
 * devices ever write to the same file, Resilio never has to merge or produce
 * conflict copies — it just moves files around, which it's good at.
 *
 * On sync, every device reads all log-*.jsonl files, applies any events it
 * hasn't seen yet (in timestamp order), and ends up with the same data.
 *
 * See threadlog_sync_schema_v1.md for the full design and rationale.
 *
 * v1 scope: contacts, entries, projects (+ project membership). Reminders
 * and topics stay local-only/embedded for now — see the schema doc's
 * "upgrade path" notes if that needs to change later.
 */

const TL_EVENTLOG = (() => {

  let _deviceId = null;
  let _dirHandle = null;
  let _ownLines = [];          // in-memory cache of this device's own log lines (for cheap re-writes)
  let _syncing = false;        // re-entrancy guard
  let _syncTimer = null;

  const LOG_PREFIX = 'log-';
  const LOG_SUFFIX = '.jsonl';

  // ─── Device identity ─────────────────────────────────────────────────────

  function _ensureDeviceId() {
    if (_deviceId) return _deviceId;
    _deviceId = TL_DB.getSetting('device_id');
    if (!_deviceId) {
      _deviceId = _uuid();
      TL_DB.setSetting('device_id', _deviceId);
    }
    return _deviceId;
  }

  function getDeviceId() { return _ensureDeviceId(); }

  function _uuid() {
    return (crypto.randomUUID ? crypto.randomUUID() :
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      }));
  }

  function _logFileName(deviceId) { return `${LOG_PREFIX}${deviceId}${LOG_SUFFIX}`; }

  // ─── Emitting events (called by db.js after every local write) ──────────

  // `at` is optional — pass the record's own timestamp (e.g. created_at) when
  // available so replay order matches when things actually happened; defaults
  // to now.
  function emit(type, payload, at) {
    if (!_dirHandle) return; // no folder connected yet — local-only for now, nothing to sync
    const event = {
      ...payload,
      id: `evt_${_uuid()}`,
      device: _ensureDeviceId(),
      at: new Date(at || Date.now()).toISOString(),
      type,
    };
    _ownLines.push(JSON.stringify(event));
    _queueWriteOwnLog(); // queued, not fire-and-forget — see below
  }

  // Writes race if two emit() calls overlap (e.g. bootstrap emitting many events
  // in a tight loop) — each write dumps the *whole* _ownLines buffer, so an
  // earlier write finishing after a later one would truncate our own log back
  // to a shorter, stale state. Chain writes through one promise so they run
  // strictly one at a time, always writing the latest _ownLines.
  let _writeChain = Promise.resolve();
  function _queueWriteOwnLog() {
    _writeChain = _writeChain.then(_writeOwnLog);
    return _writeChain;
  }

  async function _writeOwnLog() {
    if (!_dirHandle) return;
    try {
      const fileHandle = await _dirHandle.getFileHandle(_logFileName(_ensureDeviceId()), { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(_ownLines.join('\n') + (_ownLines.length ? '\n' : ''));
      await writable.close();
      // We just wrote our own events — advance our own cursor so the next sync()
      // doesn't try to re-apply them to ourselves.
      TL_DB.setSetting(`eventlog_cursor_${_logFileName(_deviceId)}`, String(_ownLines.length));
    } catch (e) {
      console.error('[EventLog] Failed to write own log:', e);
    }
  }

  // ─── Folder lifecycle ─────────────────────────────────────────────────────

  async function onFolderReady() {
    _dirHandle = TL_DB.getDirHandle ? TL_DB.getDirHandle() : null;
    if (!_dirHandle) return;
    _ensureDeviceId();
    await _loadOwnLog();
    await _bootstrapIfNeeded();
    await _writeChain; // make sure all bootstrap events are actually on disk first
    await sync();
    if (!_syncTimer) {
      // Pick up changes Resilio brings in from the other device in the background.
      _syncTimer = setInterval(() => { sync(); }, 20000);
    }
  }

  async function _loadOwnLog() {
    try {
      const fileHandle = await _dirHandle.getFileHandle(_logFileName(_deviceId), { create: true });
      const file = await fileHandle.getFile();
      const text = await file.text();
      _ownLines = text.split('\n').filter(l => l.trim());
    } catch (e) {
      console.warn('[EventLog] Could not load own log:', e);
      _ownLines = [];
    }
  }

  // One-time per device: if this device already has data (from before the sync
  // engine existed, or just from normal local use) but hasn't logged any events
  // yet, write a full history of "created" events for everything that already
  // exists, using each record's own created_at so replay order stays correct.
  // Without this, a second device connecting later would never receive this
  // device's pre-existing contacts/entries/projects at all.
  async function _bootstrapIfNeeded() {
    const flag = `eventlog_bootstrapped_${_deviceId}`;
    if (TL_DB.getSetting(flag) === 'true') return;

    const db = TL_DB._db();
    if (!db) return;

    const contacts = _rows(db, `SELECT * FROM contacts`);
    contacts.forEach(c => {
      const phones = _rows(db, `SELECT type, number FROM contact_phones WHERE contact_id = ?`, [c.id]);
      const emails = _rows(db, `SELECT email FROM contact_emails WHERE contact_id = ?`, [c.id]).map(e => e.email);
      const topics = _rows(db, `SELECT name FROM topics WHERE contact_id = ?`, [c.id]).map(t => t.name);
      emit('contact.created', {
        globalId: c.global_id, first_name: c.first_name, last_name: c.last_name,
        descriptor: c.descriptor, notes: c.notes, avatar_color: c.avatar_color,
        phones, emails, topics,
      }, c.created_at);
    });

    const entries = _rows(db, `SELECT * FROM entries`);
    const contactGlobalById = {};
    contacts.forEach(c => contactGlobalById[c.id] = c.global_id);
    entries.forEach(e => {
      const topic_names = _rows(db, `
        SELECT t.name FROM topics t JOIN entry_topics et ON et.topic_id = t.id WHERE et.entry_id = ?
      `, [e.id]).map(t => t.name);
      emit('entry.created', {
        globalId: e.global_id, contactGlobalId: contactGlobalById[e.contact_id],
        entry_type: e.type, direction: e.direction, timestamp: e.timestamp, duration_s: e.duration_s,
        subject: e.subject, body: e.body, doc_name: e.doc_name, doc_url: e.doc_url, doc_type: e.doc_type,
        location: e.location, auto_captured: e.auto_captured, source_id: e.source_id, topic_names,
      }, e.created_at);
    });

    const projects = _rows(db, `SELECT * FROM projects`);
    projects.forEach(p => {
      emit('project.created', { globalId: p.global_id, name: p.name, description: p.description, status: p.status }, p.created_at);
      const members = _rows(db, `SELECT contact_id, added_at FROM project_contacts WHERE project_id = ?`, [p.id]);
      members.forEach(m => {
        emit('project.contact_added', { projectGlobalId: p.global_id, contactGlobalId: contactGlobalById[m.contact_id] }, m.added_at);
      });
    });

    TL_DB.setSetting(flag, 'true');
  }

  // ─── Reading + applying events ────────────────────────────────────────────

  async function sync() {
    if (_syncing || !_dirHandle) return;
    _syncing = true;
    try {
      const newEvents = []; // { event, fileName }
      for await (const [name, handle] of _dirHandle.entries()) {
        if (handle.kind !== 'file') continue;
        if (!name.startsWith(LOG_PREFIX) || !name.endsWith(LOG_SUFFIX)) continue;

        const file = await handle.getFile();
        const text = await file.text();
        const lines = text.split('\n').filter(l => l.trim());

        const cursorKey = `eventlog_cursor_${name}`;
        const cursor = parseInt(TL_DB.getSetting(cursorKey) || '0', 10);
        if (lines.length <= cursor) continue;

        for (let i = cursor; i < lines.length; i++) {
          try {
            newEvents.push({ event: JSON.parse(lines[i]), fileName: name, lineIndex: i });
          } catch (e) {
            console.warn('[EventLog] Skipping malformed line in', name, e);
          }
        }
      }

      if (!newEvents.length) return;

      // Apply strictly in timestamp order — this IS the merge rule. Two events
      // touching different fields both survive naturally; same-field conflicts
      // resolve to whichever event is later. Tie-break deterministically.
      newEvents.sort((a, b) => {
        const t = new Date(a.event.at) - new Date(b.event.at);
        if (t !== 0) return t;
        return String(a.event.id).localeCompare(String(b.event.id));
      });

      newEvents.forEach(({ event }) => _apply(event));

      // Advance cursors to the end of what we just read, per file.
      const maxLineByFile = {};
      newEvents.forEach(({ fileName, lineIndex }) => {
        maxLineByFile[fileName] = Math.max(maxLineByFile[fileName] || 0, lineIndex + 1);
      });
      Object.entries(maxLineByFile).forEach(([fileName, line]) => {
        TL_DB.setSetting(`eventlog_cursor_${fileName}`, String(line));
      });

      await TL_DB.persist();
      if (window.TL_CONTACTS?.render) TL_CONTACTS.render();
      if (window.TL_APP?.toast) TL_APP.toast(`Synced ${newEvents.length} change${newEvents.length === 1 ? '' : 's'}`);
    } catch (e) {
      console.error('[EventLog] Sync failed:', e);
    } finally {
      _syncing = false;
    }
  }

  function _apply(event) {
    const db = TL_DB._db();
    if (!db) return;
    try {
      switch (event.type) {
        case 'contact.created': return _applyContactCreated(db, event);
        case 'contact.updated': return _applyContactUpdated(db, event);
        case 'contact.deleted': return _run(db, `DELETE FROM contacts WHERE global_id = ?`, [event.globalId]);
        case 'entry.created':   return _applyEntryCreated(db, event);
        case 'entry.updated':   return _applyEntryUpdated(db, event);
        case 'entry.deleted':   return _run(db, `DELETE FROM entries WHERE global_id = ?`, [event.globalId]);
        case 'project.created': return _applyProjectCreated(db, event);
        case 'project.updated': return _applyProjectUpdated(db, event);
        case 'project.deleted': return _run(db, `DELETE FROM projects WHERE global_id = ?`, [event.globalId]);
        case 'project.contact_added':   return _applyProjectContactAdded(db, event);
        case 'project.contact_removed': return _applyProjectContactRemoved(db, event);
        default: console.warn('[EventLog] Unknown event type:', event.type);
      }
    } catch (e) {
      console.error('[EventLog] Failed to apply event', event, e);
    }
  }

  function _applyContactCreated(db, e) {
    if (_localId(db, 'contacts', e.globalId)) return; // already have it (e.g. our own bootstrap event coming back)
    const now = Date.parse(e.at) || Date.now();
    _run(db, `INSERT INTO contacts(global_id, first_name, last_name, descriptor, notes, avatar_color, created_at, updated_at)
               VALUES(?,?,?,?,?,?,?,?)`,
      [e.globalId, e.first_name, e.last_name || '', e.descriptor || '', e.notes || '', e.avatar_color || 'teal', now, now]);
    const id = _localId(db, 'contacts', e.globalId);
    (e.phones || []).forEach(p => _run(db, `INSERT INTO contact_phones(contact_id,type,number) VALUES(?,?,?)`, [id, p.type, p.number]));
    (e.emails || []).forEach(em => _run(db, `INSERT INTO contact_emails(contact_id,email) VALUES(?,?)`, [id, em]));
    (e.topics || []).forEach(name => TL_DB.createTopic(id, name));
  }

  function _applyContactUpdated(db, e) {
    const id = _localId(db, 'contacts', e.globalId);
    if (!id) { console.warn('[EventLog] contact.updated for unknown global_id', e.globalId); return; }
    const now = Date.parse(e.at) || Date.now();
    const fieldMap = { first_name: e.first_name, last_name: e.last_name, descriptor: e.descriptor,
      notes: e.notes, avatar_color: e.avatar_color, keep_in_touch_days: e.keep_in_touch_days };
    const sets = [], vals = [];
    Object.entries(fieldMap).forEach(([k, v]) => { if (v !== undefined) { sets.push(`${k} = ?`); vals.push(v); } });
    if (sets.length) _run(db, `UPDATE contacts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, now, id]);
    else _run(db, `UPDATE contacts SET updated_at = ? WHERE id = ?`, [now, id]);
    if (e.phones !== undefined) {
      _run(db, `DELETE FROM contact_phones WHERE contact_id = ?`, [id]);
      e.phones.forEach(p => _run(db, `INSERT INTO contact_phones(contact_id,type,number) VALUES(?,?,?)`, [id, p.type, p.number]));
    }
    if (e.emails !== undefined) {
      _run(db, `DELETE FROM contact_emails WHERE contact_id = ?`, [id]);
      e.emails.forEach(em => _run(db, `INSERT INTO contact_emails(contact_id,email) VALUES(?,?)`, [id, em]));
    }
  }

  function _applyEntryCreated(db, e) {
    if (_localId(db, 'entries', e.globalId)) return;
    const contactId = _localId(db, 'contacts', e.contactGlobalId);
    if (!contactId) { console.warn('[EventLog] entry.created for unknown contact', e.contactGlobalId); return; }
    const now = Date.parse(e.at) || Date.now();
    _run(db, `INSERT INTO entries(global_id, contact_id, type, direction, timestamp, duration_s, subject, body, doc_name, doc_url, doc_type, location, auto_captured, source_id, created_at, updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [e.globalId, contactId, e.entry_type, e.direction || 'none', e.timestamp || now, e.duration_s ?? null,
       e.subject ?? null, e.body ?? null, e.doc_name ?? null, e.doc_url ?? null, e.doc_type ?? null,
       e.location ?? null, e.auto_captured ? 1 : 0, e.source_id ?? null, now, now]);
    const id = _localId(db, 'entries', e.globalId);
    (e.topic_names || []).forEach(name => {
      const topicId = TL_DB.createTopic(contactId, name);
      if (topicId) { try { _run(db, `INSERT OR IGNORE INTO entry_topics(entry_id, topic_id) VALUES(?,?)`, [id, topicId]); } catch (err) {} }
    });
  }

  function _applyEntryUpdated(db, e) {
    const id = _localId(db, 'entries', e.globalId);
    if (!id) { console.warn('[EventLog] entry.updated for unknown global_id', e.globalId); return; }
    const now = Date.parse(e.at) || Date.now();
    const fieldMap = { direction: e.direction, timestamp: e.timestamp, duration_s: e.duration_s, subject: e.subject,
      body: e.body, doc_name: e.doc_name, doc_url: e.doc_url, doc_type: e.doc_type, location: e.location,
      highlight_color: e.highlight_color };
    const sets = [], vals = [];
    Object.entries(fieldMap).forEach(([k, v]) => { if (v !== undefined) { sets.push(`${k} = ?`); vals.push(v); } });
    if (sets.length) _run(db, `UPDATE entries SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, now, id]);
    if (e.topic_names !== undefined) {
      const row = _rows(db, `SELECT contact_id FROM entries WHERE id = ?`, [id])[0];
      _run(db, `DELETE FROM entry_topics WHERE entry_id = ?`, [id]);
      if (row) e.topic_names.forEach(name => {
        const topicId = TL_DB.createTopic(row.contact_id, name);
        if (topicId) { try { _run(db, `INSERT OR IGNORE INTO entry_topics(entry_id, topic_id) VALUES(?,?)`, [id, topicId]); } catch (err) {} }
      });
    }
  }

  function _applyProjectCreated(db, e) {
    if (_localId(db, 'projects', e.globalId)) return;
    const now = Date.parse(e.at) || Date.now();
    _run(db, `INSERT INTO projects(global_id, name, description, status, created_at, updated_at) VALUES(?,?,?,?,?,?)`,
      [e.globalId, e.name, e.description || '', e.status || 'active', now, now]);
  }

  function _applyProjectUpdated(db, e) {
    const id = _localId(db, 'projects', e.globalId);
    if (!id) { console.warn('[EventLog] project.updated for unknown global_id', e.globalId); return; }
    const now = Date.parse(e.at) || Date.now();
    const fieldMap = { name: e.name, description: e.description, status: e.status };
    const sets = [], vals = [];
    Object.entries(fieldMap).forEach(([k, v]) => { if (v !== undefined) { sets.push(`${k} = ?`); vals.push(v); } });
    if (sets.length) _run(db, `UPDATE projects SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, now, id]);
  }

  function _applyProjectContactAdded(db, e) {
    const projectId = _localId(db, 'projects', e.projectGlobalId);
    const contactId = _localId(db, 'contacts', e.contactGlobalId);
    if (!projectId || !contactId) return;
    try { _run(db, `INSERT OR IGNORE INTO project_contacts(project_id, contact_id, added_at) VALUES(?,?,?)`, [projectId, contactId, Date.parse(e.at) || Date.now()]); }
    catch (err) {}
  }

  function _applyProjectContactRemoved(db, e) {
    const projectId = _localId(db, 'projects', e.projectGlobalId);
    const contactId = _localId(db, 'contacts', e.contactGlobalId);
    if (!projectId || !contactId) return;
    _run(db, `DELETE FROM project_contacts WHERE project_id = ? AND contact_id = ?`, [projectId, contactId]);
  }

  // ─── Small raw-SQL helpers (mirrors the pattern already used in contacts.js) ─

  function _run(db, sql, params = []) {
    db.run(sql, params.map(p => p === undefined ? null : p));
  }

  function _rows(db, sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    const cols = stmt.getColumnNames();
    const out = [];
    while (stmt.step()) {
      const row = {};
      const vals = stmt.get();
      cols.forEach((c, i) => row[c] = vals[i]);
      out.push(row);
    }
    stmt.free();
    return out;
  }

  function _localId(db, table, globalId) {
    if (!globalId) return null;
    const row = _rows(db, `SELECT id FROM ${table} WHERE global_id = ?`, [globalId])[0];
    return row ? row.id : null;
  }

  // ─── Public ────────────────────────────────────────────────────────────────

  return {
    emit,
    sync,
    onFolderReady,
    getDeviceId,
  };

})();

window.TL_EVENTLOG = TL_EVENTLOG;
