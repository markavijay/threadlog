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
      first_name  TEXT NOT NULL,
      last_name   TEXT,
      descriptor  TEXT,
      notes       TEXT,
      avatar_color TEXT DEFAULT 'teal',
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

    CREATE INDEX IF NOT EXISTS idx_entries_contact    ON entries(contact_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_entries_type       ON entries(type);
    CREATE INDEX IF NOT EXISTS idx_reminders_contact  ON reminders(contact_id, done, due_at);
    CREATE INDEX IF NOT EXISTS idx_reminders_due      ON reminders(due_at, done);
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
    _seedDefaultSettings();
    await _persist();

    // Auto-save every 30 seconds if dirty
    setInterval(async () => {
      if (_dirty) await _persist();
    }, 30000);

    // Save before page unload
    window.addEventListener('beforeunload', () => { if (_dirty) _persistSync(); });

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
    } else {
      await _persist();
    }
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
      }
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
    const id = _run(
      `INSERT INTO contacts(first_name, last_name, descriptor, notes, avatar_color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [first_name, last_name, descriptor, notes, avatar_color, now, now]
    );
    phones.forEach(p => _run(`INSERT INTO contact_phones(contact_id, type, number) VALUES(?,?,?)`, [id, p.type, p.number]));
    emails.forEach(e => _run(`INSERT INTO contact_emails(contact_id, email) VALUES(?,?)`, [id, e]));
    topics.forEach(t => createTopic(id, t));
    return id;
  }

  function updateContact(id, fields) {
    const allowed = ['first_name','last_name','descriptor','notes','avatar_color'];
    const sets = allowed.filter(f => fields[f] !== undefined).map(f => `${f} = ?`);
    const vals = allowed.filter(f => fields[f] !== undefined).map(f => fields[f]);
    if (!sets.length) return;
    _run(`UPDATE contacts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, _now(), id]);
  }

  function deleteContact(id) {
    _run(`DELETE FROM contacts WHERE id = ?`, [id]);
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

  function getEntries(contactId, { type = null, topicId = null, limit = 200, offset = 0 } = {}) {
    let sql = `
      SELECT e.* FROM entries e
      WHERE e.contact_id = ?
    `;
    const params = [contactId];
    if (type) { sql += ` AND e.type = ?`; params.push(type); }
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
    const id = _run(
      `INSERT INTO entries(contact_id, type, direction, timestamp, duration_s, subject, body, doc_name, doc_url, doc_type, location, auto_captured, source_id, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [contact_id, type, direction, timestamp || now, duration_s, subject, body, doc_name, doc_url, doc_type, location, auto_captured ? 1 : 0, source_id, now, now]
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
    return id;
  }

  function updateEntry(id, fields) {
    const allowed = ['direction','timestamp','duration_s','subject','body','doc_name','doc_url','doc_type','location'];
    const sets = allowed.filter(f => fields[f] !== undefined).map(f => `${f} = ?`);
    const vals = allowed.filter(f => fields[f] !== undefined).map(f => fields[f]);
    if (sets.length) _run(`UPDATE entries SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, _now(), id]);
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
  }

  function deleteEntry(id) {
    _run(`DELETE FROM entries WHERE id = ?`, [id]);
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
    // Contacts
    getContacts, getContact, createContact, updateContact, deleteContact,
    searchContacts, getContactPhones, getContactEmails,
    findContactByPhone, findContactByEmail,
    // Topics
    getContactTopics, createTopic,
    // Entries
    getEntries, getEntryTopics: _getEntryTopics, createEntry, updateEntry, deleteEntry,
    entryExistsBySourceId,
    // Reminders
    getReminders, getDueReminders, getCallReminders,
    createReminder, markReminderDone, deleteReminder,
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
