/**
 * ThreadLog — Projects (projects.js)
 * Project list, project detail (merged multi-contact timeline with
 * per-contact toggle), and add/edit project UI.
 *
 * Spec refs: Section 7 (Projects), Section 7.3 (merged timeline),
 * Section 7.4 (contact toggle), Section 7.5 (status).
 */

const TL_PROJECTS = (() => {

  let _currentProject = null;
  let _hiddenContactIds = new Set();
  let _activeTypeFilter = 'all';
  let _activeColorFilter = 'all';
  let _activeSearchQuery = '';

  // ── Project list ──────────────────────────────────────────────────────────

  function render() {
    const list = document.getElementById('project-list');
    if (!list) return;
    const projects = TL_DB.getProjects();

    if (!projects.length) {
      list.innerHTML = `
        <div style="text-align:center;padding:48px 24px;color:var(--text-tertiary)">
          <i class="ti ti-folders" style="font-size:40px;display:block;margin-bottom:12px;opacity:0.3"></i>
          <div style="font-size:14px;font-weight:500;color:var(--text-secondary);margin-bottom:6px">No projects yet</div>
          <div style="font-size:13px;line-height:1.6">Group contacts around a shared purpose to see their combined activity in one timeline.</div>
        </div>`;
      return;
    }

    const active = projects.filter(p => p.status === 'active');
    const onHold = projects.filter(p => p.status === 'on_hold');
    const closed = projects.filter(p => p.status === 'closed');

    let html = '';
    if (active.length) {
      html += `<div class="list-section-label">Active</div>`;
      active.forEach(p => { html += _projectRowHTML(p); });
    }
    if (onHold.length) {
      html += `<div class="list-section-label">On hold</div>`;
      onHold.forEach(p => { html += _projectRowHTML(p); });
    }
    if (closed.length) {
      html += `<div class="list-section-label">Closed</div>`;
      closed.forEach(p => { html += _projectRowHTML(p); });
    }
    list.innerHTML = html;
  }

  function _projectRowHTML(p) {
    const shown = p.contacts.slice(0, 4);
    const avatars = shown.map(c =>
      `<div class="avatar av-${c.avatar_color || 'teal'} stacked-av">${TL_APP._esc(c.initials)}</div>`
    ).join('');
    const overflow = p.contacts.length > 4
      ? `<div class="avatar av-grey stacked-av">+${p.contacts.length - 4}</div>` : '';
    const lastActivity = p.last_activity ? _relTime(p.last_activity) : 'No activity yet';
    const dimmed = p.status === 'closed' ? 'opacity:0.55' : '';

    return `
      <div class="project-row" data-project-id="${p.id}" style="${dimmed}">
        <div class="stacked-avatars">${avatars}${overflow || ''}</div>
        <div class="project-info">
          <div class="project-name">${TL_APP._esc(p.name)}</div>
          <div class="project-meta">${p.contact_count} contact${p.contact_count !== 1 ? 's' : ''} · ${lastActivity}</div>
        </div>
        ${p.status === 'on_hold' ? `<span class="proj-status-badge">On hold</span>` : ''}
        <i class="ti ti-chevron-right" style="color:var(--text-tertiary);font-size:16px"></i>
      </div>`;
  }

  function _relTime(ts) {
    if (!ts || ts <= 0) return 'No activity yet';
    const diff = Date.now() - ts;
    if (diff < 0) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return 'Today';
    if (diff < 172800000) return 'Yesterday';
    if (diff < 604800000) return new Date(ts).toLocaleDateString('en-IN', { weekday: 'short' });
    return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }

  function _wireProjectList() {
    const list = document.getElementById('project-list');
    if (!list) return;
    list.addEventListener('click', e => {
      const row = e.target.closest('.project-row');
      if (row) openProject(parseInt(row.dataset.projectId));
    });
  }

  // ── Project detail (merged timeline) ────────────────────────────────────

  function openProject(projectId) {
    const project = TL_DB.getProject(projectId);
    if (!project) return;
    _currentProject = project;
    _hiddenContactIds = new Set();
    _activeTypeFilter = 'all';
    _activeColorFilter = 'all';
    _activeSearchQuery = '';

    document.getElementById('proj-name').textContent = project.name;
    document.getElementById('proj-sub').textContent =
      `${project.contacts.length} contact${project.contacts.length !== 1 ? 's' : ''}${project.status === 'on_hold' ? ' · On hold' : project.status === 'closed' ? ' · Closed' : ''}`;

    _renderContactToggles();
    _resetProjectTypeFilters();
    _resetProjectColorFilters();
    const searchInput = document.getElementById('project-timeline-search');
    const searchClear = document.getElementById('project-timeline-search-clear');
    if (searchInput) searchInput.value = '';
    if (searchClear) searchClear.classList.remove('visible');
    _renderTimeline();
    TL_APP.showView('view-project-detail');
  }

  function _renderContactToggles() {
    const bar = document.getElementById('project-contact-toggles');
    if (!bar) return;
    bar.innerHTML = _currentProject.contacts.map(c => `
      <div class="contact-toggle-chip active" data-contact-id="${c.id}">
        <span class="mini-av av-${c.avatar_color || 'teal'}">${TL_APP._esc(c.initials)}</span>
        ${TL_APP._esc(c.first_name)}
      </div>`).join('') + `
      <div class="contact-toggle-chip contact-toggle-manage" id="proj-manage-contacts">
        <i class="ti ti-users-plus"></i> Manage
      </div>`;
  }

  function _wireContactToggles() {
    const bar = document.getElementById('project-contact-toggles');
    if (!bar) return;
    bar.addEventListener('click', e => {
      const manage = e.target.closest('#proj-manage-contacts');
      if (manage) { TL_SHEETS.openProjectContactPicker(_currentProject); return; }
      const chip = e.target.closest('.contact-toggle-chip');
      if (!chip || !chip.dataset.contactId) return;
      const cid = parseInt(chip.dataset.contactId);
      chip.classList.toggle('active');
      if (chip.classList.contains('active')) _hiddenContactIds.delete(cid);
      else _hiddenContactIds.add(cid);
      _renderTimeline();
    });
  }

  function _wireProjectTypeFilters() {
    const bar = document.getElementById('project-type-filters');
    if (!bar) return;
    bar.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      _activeTypeFilter = chip.dataset.filter;
      _resetProjectTypeFilters(chip);
      _renderTimeline();
    });
  }

  function _resetProjectTypeFilters(activeChip = null) {
    const bar = document.getElementById('project-type-filters');
    if (!bar) return;
    const chips = bar.querySelectorAll('.chip');
    chips.forEach(c => {
      c.className = 'chip';
      if (activeChip ? c === activeChip : c.dataset.filter === 'all') {
        c.classList.add(`active-${c.dataset.filter}`);
      }
    });
    if (!activeChip) _activeTypeFilter = 'all';
  }

  // ── Color (Priority) Filters ────────────────────────────────────────────

  function _wireProjectColorFilters() {
    const bar = document.getElementById('project-color-filters');
    if (!bar) return;
    bar.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      _activeColorFilter = chip.dataset.color;
      _resetProjectColorFilters();
      _renderTimeline();
    });
  }

  function _resetProjectColorFilters() {
    const bar = document.getElementById('project-color-filters');
    if (!bar) return;
    bar.innerHTML = TL_TIMELINE.colorFilterChipsHTML(_activeColorFilter);
  }

  // ── Search ─────────────────────────────────────────────────────────────
  // Searches within this project's merged entries — distinct from the
  // contacts-list search. Combines with the active type/color filters.

  function _wireProjectSearch() {
    const input = document.getElementById('project-timeline-search');
    const clearBtn = document.getElementById('project-timeline-search-clear');
    if (!input) return;

    input.addEventListener('input', () => {
      _activeSearchQuery = input.value;
      clearBtn?.classList.toggle('visible', input.value.length > 0);
      _renderTimeline();
    });

    clearBtn?.addEventListener('click', () => {
      input.value = '';
      _activeSearchQuery = '';
      clearBtn.classList.remove('visible');
      _renderTimeline();
      input.focus();
    });
  }

  function _renderTimeline() {
    const tl = document.getElementById('project-timeline');
    if (!tl || !_currentProject) return;

    if (!_currentProject.contacts.length) {
      tl.innerHTML = `
        <div class="tl-empty">
          <i class="ti ti-users"></i>
          No contacts in this project yet.<br>Tap "Manage" above to add people.
        </div>`;
      return;
    }
    if (_hiddenContactIds.size === _currentProject.contacts.length) {
      tl.innerHTML = `
        <div class="tl-empty">
          <i class="ti ti-eye-off"></i>
          All contacts are hidden.<br>Toggle at least one contact on to see activity.
        </div>`;
      return;
    }

    const entries = TL_DB.getProjectEntries(_currentProject.id, {
      type: _activeTypeFilter === 'all' ? null : _activeTypeFilter,
      color: _activeColorFilter === 'all' ? null : _activeColorFilter,
      q: _activeSearchQuery || null,
      excludeContactIds: [..._hiddenContactIds],
      limit: 300,
    });

    if (!entries.length) {
      tl.innerHTML = `
        <div class="tl-empty">
          <i class="ti ti-timeline"></i>
          ${_activeSearchQuery ? `No entries match "${TL_APP._esc(_activeSearchQuery)}".<br>Try a different search or filter.` : 'No entries match this filter.<br>Try a different filter, or log activity against one of the linked contacts.'}
        </div>`;
      return;
    }

    const groups = TL_TIMELINE.groupByDate(entries);
    let html = '';
    groups.forEach(group => {
      html += `<div class="tl-date">${group.label}</div>`;
      group.entries.forEach(e => { html += TL_TIMELINE.entryCardHTML(e, _activeSearchQuery); });
    });
    tl.innerHTML = html;
  }

  function _wireProjectTimelineClicks() {
    const tl = document.getElementById('project-timeline');
    if (!tl) return;
    tl.addEventListener('click', e => {
      const link = e.target.closest('.gmail-open-link');
      if (link) return; // handled by its own inline onclick / default behaviour
      const card = e.target.closest('.tl-card');
      if (!card) return;
      const entryId = parseInt(card.dataset.entryId);
      const contactId = parseInt(card.dataset.contactId);
      if (!contactId) return;
      const entry = TL_DB.getEntries(contactId, { limit: 500 }).find(x => x.id === entryId);
      if (entry) TL_TIMELINE.openEntryDetail(entry, contactId);
    });
  }

  // ── Navigation wiring ────────────────────────────────────────────────────

  function _wireNav() {
    const backToContactsBtn = document.getElementById('btn-back-projects-to-contacts');
    if (backToContactsBtn) {
      backToContactsBtn.addEventListener('click', () => TL_APP.showView('view-contacts'));
    }
    const backBtn = document.getElementById('btn-back-projects');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        _currentProject = null;
        render();
        TL_APP.showView('view-projects');
      });
    }
    const menuBtn = document.getElementById('btn-project-menu');
    if (menuBtn) {
      menuBtn.addEventListener('click', () => {
        if (_currentProject) TL_SHEETS.openProjectMenu(_currentProject);
      });
    }
    const fab = document.getElementById('fab-add-project');
    if (fab) {
      fab.addEventListener('click', () => TL_SHEETS.openAddProject());
    }
  }

  // Called by TL_SHEETS after edits so the open project view reflects changes immediately.
  function refreshCurrentProject() {
    if (!_currentProject) return;
    const fresh = TL_DB.getProject(_currentProject.id);
    if (!fresh) { TL_APP.showView('view-projects'); render(); return; }
    // Preserve toggle state for contacts still in the project.
    const keep = new Set(fresh.contacts.map(c => c.id));
    _hiddenContactIds = new Set([..._hiddenContactIds].filter(id => keep.has(id)));
    _currentProject = fresh;
    document.getElementById('proj-name').textContent = fresh.name;
    document.getElementById('proj-sub').textContent =
      `${fresh.contacts.length} contact${fresh.contacts.length !== 1 ? 's' : ''}${fresh.status === 'on_hold' ? ' · On hold' : fresh.status === 'closed' ? ' · Closed' : ''}`;
    _renderContactToggles();
    _renderTimeline();
  }

  function deleteProject(id) {
    if (!confirm('Delete this project? Contacts and their entries are not affected.')) return;
    TL_DB.deleteProject(id);
    TL_SHEETS.close();
    _currentProject = null;
    TL_APP.showView('view-projects');
    render();
    TL_APP.toast('Project deleted');
  }

  // ── Styles ────────────────────────────────────────────────────────────────
  // All Projects CSS now lives statically in index.html's <style> block
  // (.project-row, .stacked-avatars, .contact-toggle-chip, .mini-av, .project-picker-row, etc).
  // This is kept as a no-op so existing call sites (sheets.js, init()) don't need changes.
  function injectStyles() {}

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    injectStyles();
    _wireProjectList();
    _wireNav();
    _wireContactToggles();
    _wireProjectTypeFilters();
    _wireProjectColorFilters();
    _wireProjectSearch();
    _wireProjectTimelineClicks();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  return {
    init, render, openProject, refreshCurrentProject, deleteProject,
    injectStyles,
    get currentProject() { return _currentProject; },
  };

})();
