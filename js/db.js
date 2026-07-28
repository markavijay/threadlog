/**
 * ThreadLog — Data Layer (db.js)
 *
 * Uses sql.js (SQLite compiled to WebAssembly) for local storage.
 * The database file (threadlog.db) lives in the Resilio-synced folder.
 * On Android PWA: stored in IndexedDB (persisted across sessions).
 * On desktop: loaded from / saved to the local file system via File System Access API.
 *
 * All public functions return Promises.
 */

var TL_DB = (function() {

  let _db = null;            // sql.js Database instance
  let _SQL = null;           // sql.js module
  let _dirty = false;        // track unsaved changes
  let _dirHandle = null;     // FileSystemDirectoryHandle for the ThreadLog data folder
  let _fileHandle = null;    // FileSystemFileHandle for threadlog.db inside that folder
  let _fsSupported = 'showDirectoryPicker' in window;
  let _usingFileSystem = false; // true once we have a working folder connection

  // ─── Schema ────────────────────────────────────────────────────────────────

  const SCHEMA = `
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS contacts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      global_id   TEXT,
      first_name  TEXT NOT NULL,
      last_name   TEXT,
      descriptor  TEXT,
      notes       TEXT,
      avatar_color TEXT DEFAULT 'teal',
      keep_in_touch_days INTEGER,
      reconnect_dismissed_at INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contact_phones (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      type        TEXT NOT NULL DEFAULT 'mobile',
      number      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contact_emails (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      email       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS topics (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      UNIQUE(contact_id, name)
    );

    CREATE TABLE IF NOT EXISTS entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      global_id   TEXT,
      contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      type        TEXT NOT NULL CHECK(type IN ('call','sms','email','meet','wa','doc','note')),
      direction   TEXT CHECK(direction IN ('in','out','missed','none')),
      timestamp   INTEGER NOT NULL,
      duration_s  INTEGER,
      subject     TEXT,
      body        TEXT,
      doc_name    TEXT,
      doc_url     TEXT,
      doc_type    TEXT,
      location    TEXT,
      auto_captured INTEGER NOT NULL DEFAULT 0,
      source_id   TEXT,
      highlight_color TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entry_topics (
      entry_id    INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
      topic_id    INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      PRIMARY KEY (entry_id, topic_id)
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      entry_id    INTEGER REFERENCES entries(id) ON DELETE SET NULL,
      title       TEXT NOT NULL,
      description TEXT,
      due_at      INTEGER,
      priority    TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
      show_on_call INTEGER NOT NULL DEFAULT 1,
      done        INTEGER NOT NULL DEFAULT 0,
      done_at     INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reminder_topics (
      reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
      topic_id    INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      PRIMARY KEY (reminder_id, topic_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key         TEXT PRIMARY KEY,
      value       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      global_id   TEXT,
      name        TEXT NOT NULL,
      description TEXT,
      status      TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','on_hold','closed')),
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_contacts (
      project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      contact_id  INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      added_at    INTEGER NOT NULL,
      PRIMARY KEY (project_id, contact_id)
    );

    CREATE INDEX IF NOT EXISTS idx_entries_contact    ON entries(contact_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_entries_type       ON entries(type);
    CREATE INDEX IF NOT EXISTS idx_reminders_contact  ON reminders(contact_id, done, due_at);
    CREATE INDEX IF NOT EXISTS idx_reminders_due      ON reminders(due_at, done);
    CREATE INDEX IF NOT EXISTS idx_project_contacts_project ON project_contacts(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_contacts_contact ON project_contacts(contact_id);
  `;

  // ─── Init ──────────────────────────────────────────────────────────────────

  async function init() {
    // Load sql.js WASM
    _SQL = await initSqlJs({
      locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}`
    });

    // Try to reconnect to a previously-chosen folder (desktop Chrome remembers permission)
    let saved = null;
    if (_fsSupported) {
      saved = await _tryReconnectFolder();
    }
    // Fall back to IndexedDB if no folder connected yet
    if (saved === null && !_usingFileSystem) {
      saved = await _loadFromIDB();
    }

    if (saved) {
      _db = new _SQL.Database(saved);
      console.log('[DB] Loaded existing database', _usingFileSystem ? '(folder)' : '(IndexedDB)');
    } else {
      _db = new _SQL.Database();
      console.log('[DB] Created new database');
    }

    _db.run(SCHEMA);
    _migrateSchema();
    _seedDefaultSettings();
    await _persist();

    // Auto-save every 30 seconds if dirty
    setInterval(async () => {
      if (_dirty) await _persist();
    }, 30000);

    // Save before page unload
    window.addEventListener('beforeunload', () => { if (_dirty) _persistSync(); });

    if (_usingFileSystem && window.TL_EVENTLOG) await TL_EVENTLOG.onFolderReady();

    return true;
  }

  // ─── Folder connection (File System Access API) ─────────────────────────────

  // Call this from a user gesture (button click) to let the user pick/create
  // the Resilio-synced ThreadLog data folder.
  async function connectFolder() {
    if (!_fsSupported) {
      throw new Error('Your browser does not support folder access. Use Chrome or Edge.');
    }
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    await _idbSetHandle('threadlog_dir_handle', dir);
    _dirHandle = dir;
    _fileHandle = await _getOrCreateDbFile(dir);
    _usingFileSystem = true;

    // If we already have an in-memory DB (e.g. user connected folder after first run),
    // merge: prefer existing file in folder if present and non-empty, else write current db there.
    const existing = await _readFileHandle(_fileHandle);
    if (existing && existing.byteLength > 0) {
      _db = new _SQL.Database(existing);
      _db.run(SCHEMA); // ensure schema is current
      _migrateSchema();
    } else {
      await _persist();
    }
    if (window.TL_EVENTLOG) await TL_EVENTLOG.onFolderReady();
    return true;
  }

  function isUsingFileSystem() { return _usingFileSystem; }
  function isFileSystemSupported() { return _fsSupported; }
  function getConnectedFolderName() { return _dirHandle ? _dirHandle.name : null; }

  async function hadPreviousFolder() {
    try {
      const dir = await _idbGetHandle('threadlog_dir_handle');
      return !!dir;
    } catch (e) {
      return false;
    }
  }

  async function _tryReconnectFolder() {
    try {
      const dir = await _idbGetHandle('threadlog_dir_handle');
      if (!dir) return null;
      // Check/request permission silently first, prompt only if needed
      const perm = await dir.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        // Can't prompt without a user gesture on boot — mark for reconnect banner
        return null;
      }
      _dirHandle = dir;
      _fileHandle = await _getOrCreateDbFile(dir);
      _usingFileSystem = true;
      return await _readFileHandle(_fileHandle);
    } catch (e) {
      console.warn('[DB] Could not auto-reconnect to folder:', e);
      return null;
    }
  }

  // Call this from a button tap if init() couldn't silently reconnect
  // (e.g. permission needs a fresh user gesture, common after browser restart)
  async function reconnectFolderWithPrompt() {
    try {
      const dir = await _idbGetHandle('threadlog_dir_handle');
      if (!dir) return false;
      const perm = await dir.requestPermission({ mode: 'readwrite' });
      if (perm !== 'granted') return false;
      _dirHandle = dir;
      _fileHandle = await _getOrCreateDbFile(dir);
      _usingFileSystem = true;
      const data = await _readFileHandle(_fileHandle);
      if (data && data.byteLength > 0) {
        _db = new _SQL.Database(data);
        _db.run(SCHEMA);
        _migrateSchema();
      }
      if (window.TL_EVENTLOG) await TL_EVENTLOG.onFolderReady();
      return true;
    } catch (e) {
      console.warn('[DB] Reconnect with prompt failed:', e);
      return false;
    }
  }

  async function _getOrCreateDbFile(dirHandle) {
    return await dirHandle.getFileHandle('threadlog.db', { create: true });
  }

  async function _readFileHandle(fileHandle) {
    try {
      const file = await fileHandle.getFile();
      const buf = await file.arrayBuffer();
      return new Uint8Array(buf);
    } catch (e) {
      return null;
    }
  }

  async function _writeFileHandle(fileHandle, data) {
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  // ─── Storage ───────────────────────────────────────────────────────────────

  async function _loadFromIDB() {
    try {
      const idb = await _idbGet('threadlog_db');
      if (idb) return new Uint8Array(idb);
    } catch (e) {
      console.warn('[DB] Could not load from IndexedDB:', e);
    }
    return null;
  }

  async function _persist() {
    try {
      const data = _db.export();
      if (_usingFileSystem && _fileHandle) {
        await _writeFileHandle(_fileHandle, data);
        console.log('[DB] Saved to folder:', _dirHandle?.name);
      } else {
        await _idbSet('threadlog_db', data.buffer);
        console.log('[DB] Persisted to IndexedDB');
      }
      _dirty = false;
    } catch (e) {
      console.error('[DB] Persist failed:', e);
      // If folder write failed (e.g. permission revoked), fall back to IDB so data isn't lost
      if (_usingFileSystem) {
        try {
          await _idbSet('threadlog_db', _db.export().buffer);
          console.warn('[DB] Folder write failed — saved to IndexedDB as fallback');
        } catch (e2) { /* give up silently */ }
      }
    }
  }

  function _persistSync() {
    // Synchronous best-effort save on page unload.
    // File System Access writes are async-only, so on unload we always fall back to IDB
    // (the next successful periodic/explicit save will catch up the folder copy).
    try {
      const data = _db.export();
      const req = indexedDB.open('ThreadLogStorage', 1);
      req.onsuccess = e => {
        const db = e.target.result;
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(data.buffer, 'threadlog_db');
      };
    } catch (e) { /* silent */ }
  }

  function _idbGet(key) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('ThreadLogStorage', 2);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      };
      req.onsuccess = e => {
        const tx = e.target.result.transaction('kv', 'readonly');
        const r = tx.objectStore('kv').get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  function _idbSet(key, value) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('ThreadLogStorage', 2);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      };
      req.onsuccess = e => {
        const tx = e.target.result.transaction('kv', 'readwrite');
        const r = tx.objectStore('kv').put(value, key);
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  function _idbGetHandle(key) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('ThreadLogStorage', 2);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      };
      req.onsuccess = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('handles')) { resolve(null); return; }
        const tx = db.transaction('handles', 'readonly');
        const r = tx.objectStore('handles').get(key);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = () => reject(r.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  function _idbSetHandle(key, handle) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('ThreadLogStorage', 2);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      };
      req.onsuccess = e => {
        const tx = e.target.result.transaction('handles', 'readwrite');
        const r = tx.objectStore('handles').put(handle, key);
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      };
      req.onerror = () => reject(req.error);
    });
  }

  // Additive, backward-compatible migrations for databases created before a column
  // existed. CREATE TABLE IF NOT EXISTS above only helps brand-new databases —
  // existing threadlog.db files need the column added explicitly. Each ALTER is
  // wrapped so it's a silent no-op once the column already exists.
  function _migrateSchema() {
    try { _db.run(`ALTER TABLE entries ADD COLUMN highlight_color TEXT`); } catch (e) { /* already exists */ }
    try { _db.run(`ALTER TABLE contacts ADD COLUMN keep_in_touch_days INTEGER`); } catch (e) { /* already exists */ }
    try { _db.run(`ALTER TABLE contacts ADD COLUMN reconnect_dismissed_at INTEGER`); } catch (e) { /* already exists */ }

    // Sync engine (Resilio event log) support — additive, safe to run on every boot.
    try { _db.run(`ALTER TABLE contacts ADD COLUMN global_id TEXT`); } catch (e) { /* already exists */ }
    try { _db.run(`ALTER TABLE entries ADD COLUMN global_id TEXT`); } catch (e) { /* already exists */ }
    try { _db.run(`ALTER TABLE projects ADD COLUMN global_id TEXT`); } catch (e) { /* already exists */ }

    // Backfill: any row created before the sync engine existed has no global_id yet.
    // Give every such row a stable id now, once, so it can be referenced by future events.
    ['contacts', 'entries', 'projects'].forEach(table => {
      const stmt = _db.prepare(`SELECT id FROM ${table} WHERE global_id IS NULL`);
      const ids = _rows(stmt).map(r => r.id);
      ids.forEach(id => {
        _db.run(`UPDATE ${table} SET global_id = ? WHERE id = ?`, [_uuid(), id]);
      });
    });

    try { _db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_global ON contacts(global_id)`); } catch (e) {}
    try { _db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_global  ON entries(global_id)`); } catch (e) {}
    try { _db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_global ON projects(global_id)`); } catch (e) {}
  }

  function _uuid() {
    return (crypto.randomUUID ? crypto.randomUUID() :
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      }));
  }

  function _globalIdOf(table, id) {
    const stmt = _db.prepare(`SELECT global_id FROM ${table} WHERE id = ?`);
    stmt.bind([id]);
    return _first(stmt)?.global_id || null;
  }

  function _seedDefaultSettings() {
    const defaults = {
      'google_connected': 'false',
      'google_email': '',
      'gmail_sync': 'true',
      'gmail_sync_freq_min': '30',
      'calendar_sync': 'true',
      'calendar_include_groups': 'false',
      'last_gmail_sync': '0',
      'last_calendar_sync': '0',
      'app_version': '1.0.0',
    };
    for (const [key, value] of Object.entries(defaults)) {
      _db.run(
        `INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)`,
        [key, value]
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function _now() { return Date.now(); }

  function _rows(stmt) {
    const cols = stmt.getColumnNames();
    const rows = [];
    while (stmt.step()) {
      const row = {};
      const vals = stmt.get();
      cols.forEach((c, i) => row[c] = vals[i]);
      rows.push(row);
    }
    stmt.free();
    return rows;
  }

  function _first(stmt) {
    const rows = _rows(stmt);
    return rows[0] || null;
  }

  function _run(sql, params = []) {
    const cleaned = params.map(p => p === undefined ? null : p);
    _db.run(sql, cleaned);
    _dirty = true;
    return _db.exec('SELECT last_insert_rowid() AS id')[0]?.values[0][0];
  }

  // ─── Contacts ──────────────────────────────────────────────────────────────

  function getContacts() {
    const stmt = _db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM entries e WHERE e.contact_id = c.id) AS entry_count,
        (SELECT COUNT(*) FROM reminders r WHERE r.contact_id = c.id AND r.done = 0) AS pending_reminders,
        (SELECT e.timestamp FROM entries e WHERE e.contact_id = c.id ORDER BY e.timestamp DESC LIMIT 1) AS last_activity
      FROM contacts c
      ORDER BY last_activity DESC NULLS LAST, c.first_name ASC
    `);
    const contacts = _rows(stmt);
    return contacts.map(c => ({
      ...c,
      phones: getContactPhones(c.id),
      emails: getContactEmails(c.id),
      display_name: _displayName(c),
      initials: _initials(c),
    }));
  }

  // ─── Reconnect nudges (Section 10.4) ────────────────────────────────────────
  // Cadence is opt-in per contact (keep_in_touch_days). "Reference point" for
  // a contact is the most recent of: last real activity, a dismissed nudge (which
  // resets the clock without requiring an interaction), or when they were added
  // (fallback for a contact with a cadence but no activity yet). A contact
  // surfaces once now - reference exceeds their chosen cadence.

  function getReconnectContacts() {
    const now = _now();
    return getContacts()
      .filter(c => c.keep_in_touch_days)
      .map(c => {
        const reference = Math.max(c.last_activity || 0, c.reconnect_dismissed_at || 0, c.created_at || 0);
        const cadenceMs = c.keep_in_touch_days * 86400000;
        const overdueDays = Math.floor((now - reference - cadenceMs) / 86400000);
        return { ...c, reconnect_reference: reference, overdue_days: overdueDays };
      })
      .filter(c => c.overdue_days >= 0)
      .sort((a, b) => b.overdue_days - a.overdue_days);
  }

  // Resets the clock without logging an interaction — the person said "I know,
  // I'll get to them" and doesn't want to be nagged again immediately.
  function dismissReconnect(contactId) {
    _run(`UPDATE contacts SET reconnect_dismissed_at = ? WHERE id = ?`, [_now(), contactId]);
  }

  function getContact(id) {
    const stmt = _db.prepare(`SELECT * FROM contacts WHERE id = ?`);
    stmt.bind([id]);
    const c = _first(stmt);
    if (!c) return null;
    return {
      ...c,
      phones: getContactPhones(id),
      emails: getContactEmails(id),
      topics: getContactTopics(id),
      display_name: _displayName(c),
      initials: _initials(c),
    };
  }

  function createContact({ first_name, last_name = '', descriptor = '', notes = '', avatar_color = 'teal', phones = [], emails = [], topics = [] }) {
    const now = _now();
    const globalId = _uuid();
    const id = _run(
      `INSERT INTO contacts(global_id, first_name, last_name, descriptor, notes, avatar_color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [globalId, first_name, last_name, descriptor, notes, avatar_color, now, now]
    );
    phones.forEach(p => _run(`INSERT INTO contact_phones(contact_id, type, number) VALUES(?,?,?)`, [id, p.type, p.number]));
    emails.forEach(e => _run(`INSERT INTO contact_emails(contact_id, email) VALUES(?,?)`, [id, e]));
    topics.forEach(t => createTopic(id, t));
    if (window.TL_EVENTLOG) TL_EVENTLOG.emit('contact.created', {
      globalId, first_name, last_name, descriptor, notes, avatar_color,
      phones, emails, topics,
    }, now);
    return id;
  }

  function updateContact(id, fields) {
    const allowed = ['first_name','last_name','descriptor','notes','avatar_color','keep_in_touch_days'];
    const sets = allowed.filter(f => fields[f] !== undefined).map(f => `${f} = ?`);
    const vals = allowed.filter(f => fields[f] !== undefined).map(f => fields[f]);
    if (!sets.length) return;
    const now = _now();
    _run(`UPDATE contacts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, now, id]);
    if (window.TL_EVENTLOG) {
      const globalId = _globalIdOf('contacts', id);
      const changed = {};
      allowed.filter(f => fields[f] !== undefined).forEach(f => changed[f] = fields[f]);
      if (globalId) TL_EVENTLOG.emit('contact.updated', { globalId, ...changed }, now);
    }
  }

  // Full replace of a contact's phones/emails — used by the contact edit sheet
  // (which always deletes-and-reinserts the whole set). Kept as one function so
  // the sync event carries the complete new list, matching how it's edited.
  function setContactPhonesEmails(id, phones = [], emails = []) {
    _db.run(`DELETE FROM contact_phones WHERE contact_id = ?`, [id]);
    phones.forEach(p => _db.run(`INSERT INTO contact_phones(contact_id,type,number) VALUES(?,?,?)`, [id, p.type, p.number]));
    _db.run(`DELETE FROM contact_emails WHERE contact_id = ?`, [id]);
    emails.forEach(e => _db.run(`INSERT INTO contact_emails(contact_id,email) VALUES(?,?)`, [id, e]));
    _dirty = true;
    const now = _now();
    _run(`UPDATE contacts SET updated_at = ? WHERE id = ?`, [now, id]);
    if (window.TL_EVENTLOG) {
      const globalId = _globalIdOf('contacts', id);
      if (globalId) TL_EVENTLOG.emit('contact.updated', { globalId, phones, emails }, now);
    }
  }

  function deleteContact(id) {
    const globalId = _globalIdOf('contacts', id);
    _run(`DELETE FROM contacts WHERE id = ?`, [id]);
    if (window.TL_EVENTLOG && globalId) TL_EVENTLOG.emit('contact.deleted', { globalId }, _now());
  }

  function searchContacts(q) {
    const like = `%${q}%`;
    const stmt = _db.prepare(`
      SELECT c.* FROM contacts c
      WHERE c.first_name LIKE ? OR c.last_name LIKE ? OR c.descriptor LIKE ?
      ORDER BY c.first_name ASC
    `);
    stmt.bind([like, like, like]);
    return _rows(stmt).map(c => ({ ...c, display_name: _displayName(c), initials: _initials(c) }));
  }

  // Global search (Section 9.4) — matches contact name/descriptor AND entry content
  // (subject, body, doc names — covers call notes, email subjects, WhatsApp/SMS text,
  // notes, and document names, since they all live in entries.subject/body/doc_name).
  // Returns contact rows (same shape as getContacts) with an extra `matched_entry`
  // when the hit came from entry content rather than the contact's own name, and
  // `name_match` marking whether the name itself matched. Results are grouped by
  // contact by nature of the return shape, sorted name-matches-first then by recency.
  function searchContactsAndEntries(q) {
    const query = (q || '').trim();
    if (!query) return getContacts();
    const like = `%${query}%`;

    const nameStmt = _db.prepare(`
      SELECT id FROM contacts WHERE first_name LIKE ? OR last_name LIKE ? OR descriptor LIKE ?
    `);
    nameStmt.bind([like, like, like]);
    const nameMatchIds = new Set(_rows(nameStmt).map(r => r.id));

    const entryStmt = _db.prepare(`
      SELECT * FROM entries
      WHERE subject LIKE ? OR body LIKE ? OR doc_name LIKE ?
      ORDER BY timestamp DESC LIMIT 500
    `);
    entryStmt.bind([like, like, like]);
    const matchingEntries = _rows(entryStmt);
    const bestEntryByContact = {};
    matchingEntries.forEach(e => {
      if (!bestEntryByContact[e.contact_id]) bestEntryByContact[e.contact_id] = e; // most recent, since ordered DESC
    });

    const matchIds = new Set([...nameMatchIds, ...Object.keys(bestEntryByContact).map(Number)]);
    if (!matchIds.size) return [];

    const byId = new Map(getContacts().map(c => [c.id, c]));
    const results = [...matchIds]
      .map(id => byId.get(id))
      .filter(Boolean)
      .map(c => ({
        ...c,
        matched_entry: bestEntryByContact[c.id] || null,
        name_match: nameMatchIds.has(c.id),
      }));

    results.sort((a, b) => {
      if (a.name_match !== b.name_match) return a.name_match ? -1 : 1;
      if (a.name_match) return a.first_name.localeCompare(b.first_name);
      return (b.matched_entry?.timestamp || 0) - (a.matched_entry?.timestamp || 0);
    });

    return results;
  }

  function getContactPhones(contactId) {
    const stmt = _db.prepare(`SELECT * FROM contact_phones WHERE contact_id = ?`);
    stmt.bind([contactId]);
    return _rows(stmt);
  }

  function getContactEmails(contactId) {
    const stmt = _db.prepare(`SELECT * FROM contact_emails WHERE contact_id = ?`);
    stmt.bind([contactId]);
    return _rows(stmt);
  }

  function findContactByPhone(number) {
    // Normalise — strip spaces, dashes, country code variants
    const norm = number.replace(/\D/g, '').slice(-10);
    const stmt = _db.prepare(`
      SELECT c.* FROM contacts c
      JOIN contact_phones p ON p.contact_id = c.id
      WHERE REPLACE(REPLACE(REPLACE(p.number,' ',''),'-',''),'+','') LIKE ?
    `);
    stmt.bind([`%${norm}`]);
    const c = _first(stmt);
    return c ? { ...c, display_name: _displayName(c), initials: _initials(c) } : null;
  }

  function findContactByEmail(email) {
    const stmt = _db.prepare(`
      SELECT c.* FROM contacts c
      JOIN contact_emails e ON e.contact_id = c.id
      WHERE LOWER(e.email) = LOWER(?)
    `);
    stmt.bind([email]);
    const c = _first(stmt);
    return c ? { ...c, display_name: _displayName(c), initials: _initials(c) } : null;
  }

  function _displayName(c) {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ');
    return c.descriptor ? `${name} — ${c.descriptor}` : name;
  }

  function _initials(c) {
    return ((c.first_name?.[0] || '') + (c.last_name?.[0] || '')).toUpperCase() || c.first_name?.[0]?.toUpperCase() || '?';
  }

  // ─── Topics ────────────────────────────────────────────────────────────────

  function getContactTopics(contactId) {
    const stmt = _db.prepare(`SELECT * FROM topics WHERE contact_id = ? ORDER BY name ASC`);
    stmt.bind([contactId]);
    return _rows(stmt);
  }

  function createTopic(contactId, name) {
    try {
      return _run(
        `INSERT OR IGNORE INTO topics(contact_id, name, created_at) VALUES(?,?,?)`,
        [contactId, name.trim(), _now()]
      );
    } catch (e) {
      // Already exists — fetch existing id
      const stmt = _db.prepare(`SELECT id FROM topics WHERE contact_id = ? AND name = ?`);
      stmt.bind([contactId, name.trim()]);
      return _first(stmt)?.id;
    }
  }

  // ─── Entries ───────────────────────────────────────────────────────────────

  function _getEntryTopics(entryId) {
    const stmt = _db.prepare(`
      SELECT t.* FROM topics t
      JOIN entry_topics et ON et.topic_id = t.id
      WHERE et.entry_id = ?
    `);
    stmt.bind([entryId]);
    return _rows(stmt);
  }

  function getEntries(contactId, { type = null, topicId = null, color = null, q = null, limit = 200, offset = 0 } = {}) {
    let sql = `
      SELECT e.* FROM entries e
      WHERE e.contact_id = ?
    `;
    const params = [contactId];
    if (type) { sql += ` AND e.type = ?`; params.push(type); }
    if (color) { sql += ` AND e.highlight_color = ?`; params.push(color); }
    if (q && q.trim()) {
      sql += ` AND (e.subject LIKE ? OR e.body LIKE ? OR e.doc_name LIKE ?)`;
      const like = `%${q.trim()}%`;
      params.push(like, like, like);
    }
    if (topicId) {
      sql += ` AND EXISTS (SELECT 1 FROM entry_topics et WHERE et.entry_id = e.id AND et.topic_id = ?)`;
      params.push(topicId);
    }
    sql += ` ORDER BY e.timestamp DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    const stmt = _db.prepare(sql);
    stmt.bind(params);
    const entries = _rows(stmt);
    return entries.map(e => ({
      ...e,
      topics: _getEntryTopics(e.id),
    }));
  }

  function createEntry({ contact_id, type, direction = 'none', timestamp, duration_s, subject, body, doc_name, doc_url, doc_type, location, auto_captured = 0, source_id, topic_names = [] }) {
    const now = _now();
    const globalId = _uuid();
    const ts = timestamp || now;
    const id = _run(
      `INSERT INTO entries(global_id, contact_id, type, direction, timestamp, duration_s, subject, body, doc_name, doc_url, doc_type, location, auto_captured, source_id, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [globalId, contact_id, type, direction, ts, duration_s, subject, body, doc_name, doc_url, doc_type, location, auto_captured ? 1 : 0, source_id, now, now]
    );
    topic_names.forEach(name => {
      const topicId = createTopic(contact_id, name);
      if (topicId) {
        try { _run(`INSERT OR IGNORE INTO entry_topics(entry_id, topic_id) VALUES(?,?)`, [id, topicId]); }
        catch(e) { /* duplicate */ }
      }
    });
    // Update contact's updated_at
    _run(`UPDATE contacts SET updated_at = ? WHERE id = ?`, [now, contact_id]);
    if (window.TL_EVENTLOG) {
      const contactGlobalId = _globalIdOf('contacts', contact_id);
      if (contactGlobalId) TL_EVENTLOG.emit('entry.created', {
        globalId, contactGlobalId, type, direction, timestamp: ts, duration_s, subject, body,
        doc_name, doc_url, doc_type, location, auto_captured: auto_captured ? 1 : 0, source_id, topic_names,
      }, now);
    }
    return id;
  }

  function updateEntry(id, fields) {
    const allowed = ['direction','timestamp','duration_s','subject','body','doc_name','doc_url','doc_type','location','highlight_color'];
    const sets = allowed.filter(f => fields[f] !== undefined).map(f => `${f} = ?`);
    const vals = allowed.filter(f => fields[f] !== undefined).map(f => fields[f]);
    const now = _now();
    if (sets.length) _run(`UPDATE entries SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, now, id]);
    if (fields.topic_names) {
      const _stmt = _db.prepare(`SELECT contact_id FROM entries WHERE id = ?`);
      _stmt.bind([id]);
      const entry = _first(_stmt);
      _db.run(`DELETE FROM entry_topics WHERE entry_id = ?`, [id]);
      if (entry) {
        fields.topic_names.forEach(name => {
          const topicId = createTopic(entry.contact_id, name);
          if (topicId) {
            try { _run(`INSERT OR IGNORE INTO entry_topics(entry_id, topic_id) VALUES(?,?)`, [id, topicId]); }
            catch(e) { /* duplicate */ }
          }
        });
      }
    }
    if (window.TL_EVENTLOG) {
      const globalId = _globalIdOf('entries', id);
      const changed = {};
      allowed.filter(f => fields[f] !== undefined).forEach(f => changed[f] = fields[f]);
      if (fields.topic_names) changed.topic_names = fields.topic_names;
      if (globalId && Object.keys(changed).length) TL_EVENTLOG.emit('entry.updated', { globalId, ...changed }, now);
    }
  }

  function deleteEntry(id) {
    const globalId = _globalIdOf('entries', id);
    _run(`DELETE FROM entries WHERE id = ?`, [id]);
    if (window.TL_EVENTLOG && globalId) TL_EVENTLOG.emit('entry.deleted', { globalId }, _now());
  }

  // color: one of 'red'|'amber'|'green'|'blue'|'purple', or null to clear.
  function setEntryHighlight(id, color) {
    const now = _now();
    _run(`UPDATE entries SET highlight_color = ?, updated_at = ? WHERE id = ?`, [color || null, now, id]);
    if (window.TL_EVENTLOG) {
      const globalId = _globalIdOf('entries', id);
      if (globalId) TL_EVENTLOG.emit('entry.updated', { globalId, highlight_color: color || null }, now);
    }
  }

  function entryExistsBySourceId(sourceId) {
    const stmt = _db.prepare(`SELECT id FROM entries WHERE source_id = ? LIMIT 1`);
    stmt.bind([sourceId]);
    return !!_first(stmt);
  }

  // ─── Reminders ─────────────────────────────────────────────────────────────

  function getReminders(contactId, { done = false } = {}) {
    const stmt = _db.prepare(`
      SELECT r.* FROM reminders r
      WHERE r.contact_id = ? AND r.done = ?
      ORDER BY r.due_at ASC NULLS LAST, r.priority DESC
    `);
    stmt.bind([contactId, done ? 1 : 0]);
    const reminders = _rows(stmt);
    return reminders.map(r => ({ ...r, topics: getReminderTopics(r.id) }));
  }

  function getDueReminders() {
    const now = _now();
    const stmt = _db.prepare(`
      SELECT r.*, c.first_name, c.last_name, c.descriptor FROM reminders r
      JOIN contacts c ON c.id = r.contact_id
      WHERE r.done = 0 AND r.due_at <= ?
      ORDER BY r.due_at ASC
    `);
    stmt.bind([now]);
    return _rows(stmt);
  }

  function getCallReminders(contactId) {
    const stmt = _db.prepare(`
      SELECT r.* FROM reminders r
      WHERE r.contact_id = ? AND r.done = 0 AND r.show_on_call = 1
      ORDER BY r.priority DESC, r.due_at ASC NULLS LAST
    `);
    stmt.bind([contactId]);
    return _rows(stmt).map(r => ({ ...r, topics: getReminderTopics(r.id) }));
  }

  function getReminderTopics(reminderId) {
    const stmt = _db.prepare(`
      SELECT t.* FROM topics t
      JOIN reminder_topics rt ON rt.topic_id = t.id
      WHERE rt.reminder_id = ?
    `);
    stmt.bind([reminderId]);
    return _rows(stmt);
  }

  function createReminder({ contact_id, entry_id, title, description, due_at, priority = 'medium', show_on_call = true, topic_names = [] }) {
    const now = _now();
    const id = _run(
      `INSERT INTO reminders(contact_id, entry_id, title, description, due_at, priority, show_on_call, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [contact_id, entry_id || null, title, description, due_at || null, priority, show_on_call ? 1 : 0, now, now]
    );
    topic_names.forEach(name => {
      const topicId = createTopic(contact_id, name);
      if (topicId) {
        try { _run(`INSERT OR IGNORE INTO reminder_topics(reminder_id, topic_id) VALUES(?,?)`, [id, topicId]); }
        catch(e) { /* duplicate */ }
      }
    });
    return id;
  }

  function markReminderDone(id) {
    _run(`UPDATE reminders SET done = 1, done_at = ?, updated_at = ? WHERE id = ?`, [_now(), _now(), id]);
  }

  function deleteReminder(id) {
    _run(`DELETE FROM reminders WHERE id = ?`, [id]);
  }

  // ─── Projects ──────────────────────────────────────────────────────────────

  function getProjects({ status = null } = {}) {
    let sql = `
      SELECT p.*,
        (SELECT COUNT(*) FROM project_contacts pc WHERE pc.project_id = p.id) AS contact_count,
        (SELECT MAX(e.timestamp) FROM project_contacts pc
           JOIN entries e ON e.contact_id = pc.contact_id
           WHERE pc.project_id = p.id) AS last_activity
      FROM projects p
    `;
    const params = [];
    if (status) { sql += ` WHERE p.status = ?`; params.push(status); }
    sql += ` ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'on_hold' THEN 1 ELSE 2 END, last_activity DESC NULLS LAST, p.name ASC`;
    const stmt = _db.prepare(sql);
    stmt.bind(params);
    const projects = _rows(stmt);
    return projects.map(p => ({ ...p, contacts: getProjectContacts(p.id) }));
  }

  function getProject(id) {
    const stmt = _db.prepare(`SELECT * FROM projects WHERE id = ?`);
    stmt.bind([id]);
    const p = _first(stmt);
    if (!p) return null;
    return { ...p, contacts: getProjectContacts(id) };
  }

  function getProjectContacts(projectId) {
    const stmt = _db.prepare(`
      SELECT c.* FROM contacts c
      JOIN project_contacts pc ON pc.contact_id = c.id
      WHERE pc.project_id = ?
      ORDER BY c.first_name ASC
    `);
    stmt.bind([projectId]);
    return _rows(stmt).map(c => ({ ...c, display_name: _displayName(c), initials: _initials(c) }));
  }

  // Active/on-hold projects a contact belongs to — used in contact header and call overlay (Section 8.2)
  function getContactProjects(contactId) {
    const stmt = _db.prepare(`
      SELECT p.* FROM projects p
      JOIN project_contacts pc ON pc.project_id = p.id
      WHERE pc.contact_id = ? AND p.status != 'closed'
      ORDER BY CASE p.status WHEN 'active' THEN 0 ELSE 1 END, p.name ASC
    `);
    stmt.bind([contactId]);
    return _rows(stmt);
  }

  function createProject({ name, description = '', status = 'active', contact_ids = [] }) {
    const now = _now();
    const globalId = _uuid();
    const id = _run(
      `INSERT INTO projects(global_id, name, description, status, created_at, updated_at) VALUES(?,?,?,?,?,?)`,
      [globalId, name, description, status, now, now]
    );
    if (window.TL_EVENTLOG) TL_EVENTLOG.emit('project.created', { globalId, name, description, status }, now);
    contact_ids.forEach(cid => addContactToProject(id, cid));
    return id;
  }

  function updateProject(id, fields) {
    const allowed = ['name', 'description', 'status'];
    const sets = allowed.filter(f => fields[f] !== undefined).map(f => `${f} = ?`);
    const vals = allowed.filter(f => fields[f] !== undefined).map(f => fields[f]);
    if (!sets.length) return;
    const now = _now();
    _run(`UPDATE projects SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, now, id]);
    if (window.TL_EVENTLOG) {
      const globalId = _globalIdOf('projects', id);
      const changed = {};
      allowed.filter(f => fields[f] !== undefined).forEach(f => changed[f] = fields[f]);
      if (globalId) TL_EVENTLOG.emit('project.updated', { globalId, ...changed }, now);
    }
  }

  function deleteProject(id) {
    const globalId = _globalIdOf('projects', id);
    _run(`DELETE FROM projects WHERE id = ?`, [id]);
    if (window.TL_EVENTLOG && globalId) TL_EVENTLOG.emit('project.deleted', { globalId }, _now());
  }

  function addContactToProject(projectId, contactId) {
    try {
      _run(`INSERT OR IGNORE INTO project_contacts(project_id, contact_id, added_at) VALUES(?,?,?)`, [projectId, contactId, _now()]);
    } catch (e) { /* already linked */ }
    const now = _now();
    _run(`UPDATE projects SET updated_at = ? WHERE id = ?`, [now, projectId]);
    if (window.TL_EVENTLOG) {
      const projectGlobalId = _globalIdOf('projects', projectId);
      const contactGlobalId = _globalIdOf('contacts', contactId);
      if (projectGlobalId && contactGlobalId) TL_EVENTLOG.emit('project.contact_added', { projectGlobalId, contactGlobalId }, now);
    }
  }

  function removeContactFromProject(projectId, contactId) {
    const projectGlobalId = _globalIdOf('projects', projectId);
    const contactGlobalId = _globalIdOf('contacts', contactId);
    _run(`DELETE FROM project_contacts WHERE project_id = ? AND contact_id = ?`, [projectId, contactId]);
    const now = _now();
    _run(`UPDATE projects SET updated_at = ? WHERE id = ?`, [now, projectId]);
    if (window.TL_EVENTLOG && projectGlobalId && contactGlobalId) {
      TL_EVENTLOG.emit('project.contact_removed', { projectGlobalId, contactGlobalId }, now);
    }
  }

  // Merged chronological timeline across every contact linked to a project.
  // excludeContactIds implements the per-contact toggle (Section 7.4) — toggled-off
  // contacts are simply excluded from the merged query rather than deleted from the project.
  function getProjectEntries(projectId, { type = null, topicId = null, color = null, q = null, excludeContactIds = [], limit = 300, offset = 0 } = {}) {
    let sql = `
      SELECT e.*, c.first_name AS c_first_name, c.last_name AS c_last_name,
             c.descriptor AS c_descriptor, c.avatar_color AS c_avatar_color
      FROM entries e
      JOIN project_contacts pc ON pc.contact_id = e.contact_id AND pc.project_id = ?
      JOIN contacts c ON c.id = e.contact_id
      WHERE 1=1
    `;
    const params = [projectId];
    if (excludeContactIds.length) {
      sql += ` AND e.contact_id NOT IN (${excludeContactIds.map(() => '?').join(',')})`;
      params.push(...excludeContactIds);
    }
    if (type) { sql += ` AND e.type = ?`; params.push(type); }
    if (color) { sql += ` AND e.highlight_color = ?`; params.push(color); }
    if (q && q.trim()) {
      sql += ` AND (e.subject LIKE ? OR e.body LIKE ? OR e.doc_name LIKE ?)`;
      const like = `%${q.trim()}%`;
      params.push(like, like, like);
    }
    if (topicId) {
      sql += ` AND EXISTS (SELECT 1 FROM entry_topics et WHERE et.entry_id = e.id AND et.topic_id = ?)`;
      params.push(topicId);
    }
    sql += ` ORDER BY e.timestamp DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    const stmt = _db.prepare(sql);
    stmt.bind(params);
    const entries = _rows(stmt);
    return entries.map(e => ({
      ...e,
      topics: _getEntryTopics(e.id),
      contact: {
        id: e.contact_id,
        first_name: e.c_first_name,
        last_name: e.c_last_name,
        descriptor: e.c_descriptor,
        avatar_color: e.c_avatar_color,
        display_name: _displayName({ first_name: e.c_first_name, last_name: e.c_last_name, descriptor: e.c_descriptor }),
        initials: _initials({ first_name: e.c_first_name, last_name: e.c_last_name }),
      },
    }));
  }

  // ─── Settings ──────────────────────────────────────────────────────────────

  function getSetting(key) {
    const stmt = _db.prepare(`SELECT value FROM settings WHERE key = ?`);
    stmt.bind([key]);
    return _first(stmt)?.value ?? null;
  }

  function setSetting(key, value) {
    _run(`INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)`, [key, String(value)]);
  }

  // ─── Export / Backup ───────────────────────────────────────────────────────

  function exportDatabase() {
    const data = _db.export();
    const blob = new Blob([data], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `threadlog-backup-${new Date().toISOString().slice(0,10)}.db`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importDatabase(file) {
    const buffer = await file.arrayBuffer();
    _db = new _SQL.Database(new Uint8Array(buffer));
    await _persist();
    return true;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  return {
    init,
    // Folder connection (File System Access API)
    connectFolder, reconnectFolderWithPrompt,
    isUsingFileSystem, isFileSystemSupported, getConnectedFolderName, hadPreviousFolder,
    getDirHandle: () => _dirHandle,
    // Contacts
    getContacts, getContact, createContact, updateContact, deleteContact, setContactPhonesEmails,
    searchContacts, searchContactsAndEntries, getContactPhones, getContactEmails,
    getReconnectContacts, dismissReconnect,
    findContactByPhone, findContactByEmail,
    // Topics
    getContactTopics, createTopic,
    // Entries
    getEntries, getEntryTopics: _getEntryTopics, createEntry, updateEntry, deleteEntry,
    entryExistsBySourceId, setEntryHighlight,
    // Reminders
    getReminders, getDueReminders, getCallReminders,
    createReminder, markReminderDone, deleteReminder,
    // Projects
    getProjects, getProject, getProjectContacts, getContactProjects,
    createProject, updateProject, deleteProject,
    addContactToProject, removeContactFromProject, getProjectEntries,
    // Settings
    getSetting, setSetting,
    // Backup
    exportDatabase, importDatabase,
    // Raw persist (call after bulk imports)
    persist: _persist,
    // Raw db access (for edit operations)
    _db: () => _db,
  };

}());

// Make globally available
window.TL_DB = TL_DB;
