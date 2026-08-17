const API = '/api';

const STATUS_COLORS = {
  'New': '#ff6a13',
  'Contacted': '#f2c94c',
  'Qualified': '#56b6ff',
  'Test Ride': '#a78bfa',
  'Financing': '#f2994a',
  'Sold': '#3ddc84',
  'Lost': '#e5484d',
};

const PIPELINE_ORDER = ['New', 'Contacted', 'Qualified', 'Test Ride', 'Financing', 'Sold'];

const state = {
  user: null,
  meta: { statuses: [], sources: [], interestTypes: [] },
  reps: [],
  repsAll: [],
  leads: [],
  filters: { status: 'All', interestType: 'All', source: 'All', assignedRepId: '', q: '', sort: 'createdAt_desc' },
  editingId: null,
  editingRepId: null,
};

const el = (id) => document.getElementById(id);

// ---------- init ----------
async function init() {
  bindAuthEvents();
  bindEvents();
  bindRepModalEvents();
  bindNavEvents();
  await checkAuth();
}

async function checkAuth() {
  const res = await fetch(`${API}/auth/status`);
  const data = await res.json();
  if (data.needsSetup) {
    showAuthScreen('setup');
  } else if (!data.authenticated) {
    showAuthScreen('login');
  } else {
    await startApp(data.user);
  }
}

function showAuthScreen(mode) {
  el('authScreen').hidden = false;
  el('appScreen').hidden = true;
  el('setupForm').hidden = mode !== 'setup';
  el('loginForm').hidden = mode !== 'login';
}

function showAuthError(id, msg) {
  const box = el(id);
  box.textContent = msg;
  box.hidden = false;
}

function bindAuthEvents() {
  el('setupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('setupError').hidden = true;
    const form = e.target;
    const payload = { name: form.name.value, username: form.username.value, password: form.password.value };
    const res = await fetch(`${API}/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) return showAuthError('setupError', data.error || 'Could not create admin account');
    await startApp(data.user);
  });

  el('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    el('loginError').hidden = true;
    const form = e.target;
    const payload = { username: form.username.value, password: form.password.value };
    const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) return showAuthError('loginError', data.error || 'Could not sign in');
    await startApp(data.user);
  });

  el('logoutBtn').addEventListener('click', async () => {
    await fetch(`${API}/auth/logout`, { method: 'POST' });
    location.reload();
  });
}

// ---------- start app after auth ----------
async function startApp(user) {
  state.user = user;
  el('authScreen').hidden = true;
  el('appScreen').hidden = false;
  el('userName').textContent = user.name;
  el('userRole').textContent = user.role;

  const isAdmin = user.role === 'admin';
  el('navRepsDashboard').hidden = !isAdmin;
  el('navManageReps').hidden = !isAdmin;
  el('filterRep').hidden = !isAdmin;
  el('assignedRepField').hidden = !isAdmin;

  await loadMeta();
  populateFilterSelects();
  populateModalSelects();
  if (isAdmin) await loadReps();

  switchView('leads');
  await Promise.all([loadStats(), loadLeads()]);
}

function startClock() {} // kept for compatibility, no longer used

// ---------- nav ----------
function bindNavEvents() {
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
}

function switchView(view) {
  ['leads', 'repsDashboard', 'manageReps'].forEach(v => {
    el(`view-${v}`).hidden = v !== view;
  });
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  if (view === 'repsDashboard') loadRepsDashboard();
  if (view === 'manageReps') loadManageReps();
}

// ---------- meta ----------
async function loadMeta() {
  const res = await fetch(`${API}/meta`);
  state.meta = await res.json();
}

function populateFilterSelects() {
  el('filterStatus').innerHTML = optionHtml(['All', ...state.meta.statuses]);
  el('filterInterest').innerHTML = optionHtml(['All', ...state.meta.interestTypes], 'All interests');
  el('filterSource').innerHTML = optionHtml(['All', ...state.meta.sources], 'All sources');
}

function optionHtml(values, allLabel) {
  return values.map(v => `<option value="${v}">${v === 'All' ? (allLabel || 'All statuses') : v}</option>`).join('');
}

function populateModalSelects() {
  const form = el('leadForm');
  form.interestType.innerHTML = state.meta.interestTypes.map(v => `<option value="${v}">${v}</option>`).join('');
  form.source.innerHTML = state.meta.sources.map(v => `<option value="${v}">${v}</option>`).join('');
  form.status.innerHTML = state.meta.statuses.map(v => `<option value="${v}">${v}</option>`).join('');
}

// ---------- reps (admin) ----------
async function loadReps() {
  const res = await fetch(`${API}/reps`);
  state.reps = await res.json();

  const select = el('leadForm').assignedRepId;
  select.innerHTML = '<option value="">Unassigned</option>' + state.reps.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');

  el('filterRep').innerHTML = '<option value="">All reps</option><option value="unassigned">Unassigned</option>' +
    state.reps.map(r => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
}

// ---------- events ----------
function bindEvents() {
  el('openNewLead').addEventListener('click', () => openModal('new'));
  el('emptyNewLead').addEventListener('click', () => openModal('new'));
  el('closeModal').addEventListener('click', closeModal);
  el('cancelModal').addEventListener('click', closeModal);
  el('modalOverlay').addEventListener('click', (e) => { if (e.target === el('modalOverlay')) closeModal(); });
  el('saveLeadBtn').addEventListener('click', saveLead);
  el('deleteLeadBtn').addEventListener('click', deleteLead);
  el('addNoteBtn').addEventListener('click', addNote);
  el('noteInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addNote(); } });

  let searchTimer;
  el('searchInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.filters.q = e.target.value; loadLeads(); }, 220);
  });
  el('filterStatus').addEventListener('change', (e) => { state.filters.status = e.target.value; loadLeads(); });
  el('filterInterest').addEventListener('change', (e) => { state.filters.interestType = e.target.value; loadLeads(); });
  el('filterSource').addEventListener('change', (e) => { state.filters.source = e.target.value; loadLeads(); });
  el('filterRep').addEventListener('change', (e) => { state.filters.assignedRepId = e.target.value; loadLeads(); });
  el('sortSelect').addEventListener('change', (e) => { state.filters.sort = e.target.value; loadLeads(); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el('modalOverlay').hidden) closeModal();
    if (!el('repModalOverlay').hidden) closeRepModal();
  });
}

function bindRepModalEvents() {
  el('openNewRep').addEventListener('click', () => openRepModal('new'));
  el('closeRepModal').addEventListener('click', closeRepModal);
  el('cancelRepModal').addEventListener('click', closeRepModal);
  el('repModalOverlay').addEventListener('click', (e) => { if (e.target === el('repModalOverlay')) closeRepModal(); });
  el('saveRepBtn').addEventListener('click', saveRep);
}

// ---------- stats ----------
async function loadStats() {
  const res = await fetch(`${API}/stats`);
  const stats = await res.json();
  renderStats(stats);
  renderPipelineStrip(stats);
}

function renderStats(stats) {
  const cards = [
    { label: 'Total Leads', value: stats.total, color: 'var(--accent)' },
    { label: 'New — Last 7 Days', value: stats.newLast7Days, color: '#56b6ff' },
    { label: 'Test Rides Scheduled', value: stats.testRideScheduled, color: '#a78bfa' },
    { label: 'Sold This Month', value: stats.soldThisMonth, color: 'var(--success)' },
    { label: 'Conversion Rate', value: `${stats.conversionRate}%`, color: 'var(--warn)' },
  ];
  el('stats').innerHTML = cards.map(c => `
    <div class="stat-card" style="--stat-color:${c.color}">
      <div class="stat-value">${c.value}</div>
      <div class="stat-label">${c.label}</div>
    </div>
  `).join('');
}

function renderPipelineStrip(stats) {
  const total = stats.total || 0;
  el('pipelineStrip').innerHTML = PIPELINE_ORDER.map(stage => {
    const count = stats.byStatus[stage] || 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return `
      <div class="pipeline-stage">
        <div class="pipeline-stage-top"><span class="pipeline-stage-name">${stage}</span></div>
        <span class="pipeline-stage-count">${count}</span>
        <div class="pipeline-bar"><div class="pipeline-bar-fill" style="--stage-color:${STATUS_COLORS[stage]}; --stage-pct:${pct}%"></div></div>
      </div>
    `;
  }).join('');
}

// ---------- leads list ----------
async function loadLeads() {
  const params = new URLSearchParams();
  if (state.filters.status !== 'All') params.set('status', state.filters.status);
  if (state.filters.interestType !== 'All') params.set('interestType', state.filters.interestType);
  if (state.filters.source !== 'All') params.set('source', state.filters.source);
  if (state.user.role === 'admin' && state.filters.assignedRepId) params.set('assignedRepId', state.filters.assignedRepId);
  if (state.filters.q) params.set('q', state.filters.q);
  params.set('sort', state.filters.sort);

  const res = await fetch(`${API}/leads?${params.toString()}`);
  state.leads = await res.json();
  renderTable();
}

function renderTable() {
  const body = el('leadsBody');
  const empty = el('emptyState');
  el('resultCount').textContent = `${state.leads.length} lead${state.leads.length === 1 ? '' : 's'}`;

  if (state.leads.length === 0) {
    body.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  body.innerHTML = state.leads.map(lead => `
    <tr data-id="${lead.id}" tabindex="0">
      <td>
        <div class="lead-name">${escapeHtml(lead.firstName)} ${escapeHtml(lead.lastName)}</div>
        <div class="lead-contact">${escapeHtml(lead.phone || lead.email || '—')}</div>
      </td>
      <td>
        <div class="interest-type">${escapeHtml(lead.interestType)}</div>
        <div class="interest-model">${escapeHtml(lead.interestModel || '—')}</div>
      </td>
      <td><span class="tag">${escapeHtml(lead.source)}</span></td>
      <td>${statusPill(lead.status)}</td>
      <td class="assigned-cell">${escapeHtml(lead.assignedRepName || 'Unassigned')}</td>
      <td class="updated-cell">${formatRelative(lead.updatedAt)}</td>
      <td class="row-arrow">›</td>
    </tr>
  `).join('');

  body.querySelectorAll('tr').forEach(row => {
    row.addEventListener('click', () => openModal('edit', row.dataset.id));
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') openModal('edit', row.dataset.id); });
  });
}

function statusPill(status) {
  const color = STATUS_COLORS[status] || '#999';
  return `<span class="status-pill" style="color:${color}; background:${hexToRgba(color, 0.14)}; border-color:${hexToRgba(color, 0.35)}"><span class="dot"></span>${status}</span>`;
}

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function formatRelative(iso) {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  return (str ?? '').toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- lead modal ----------
function openModal(mode, leadId) {
  const form = el('leadForm');
  form.reset();
  state.editingId = mode === 'edit' ? leadId : null;

  el('statusField').hidden = mode !== 'edit';
  el('pipelineControl').hidden = mode !== 'edit';
  el('activitySection').hidden = mode !== 'edit';
  el('deleteLeadBtn').hidden = mode !== 'edit' || state.user.role !== 'admin';

  if (mode === 'new') {
    el('modalEyebrow').textContent = 'New Lead';
    el('modalTitle').textContent = 'Log a lead';
    el('saveLeadBtn').textContent = 'Save lead';
    form.interestType.value = state.meta.interestTypes[0];
    form.source.value = state.meta.sources[0];
    if (form.assignedRepId) form.assignedRepId.value = '';
  } else {
    const lead = state.leads.find(l => l.id === leadId);
    if (!lead) return;
    el('modalEyebrow').textContent = lead.status;
    el('modalTitle').textContent = `${lead.firstName} ${lead.lastName}`;
    el('saveLeadBtn').textContent = 'Save changes';
    form.firstName.value = lead.firstName;
    form.lastName.value = lead.lastName;
    form.phone.value = lead.phone || '';
    form.email.value = lead.email || '';
    form.interestType.value = lead.interestType;
    form.interestModel.value = lead.interestModel || '';
    form.source.value = lead.source;
    form.budget.value = lead.budget ?? '';
    if (form.assignedRepId) form.assignedRepId.value = lead.assignedRepId || '';
    form.status.value = lead.status;
    renderPipelineControl(lead.status);
    renderActivityLog(lead.activity || []);
  }

  el('modalOverlay').hidden = false;
  form.firstName.focus();
}

function closeModal() {
  el('modalOverlay').hidden = true;
  state.editingId = null;
}

function renderPipelineControl(currentStatus) {
  const container = el('pipelineControl');
  const mainStages = PIPELINE_ORDER.map(stage => stageButton(stage, currentStatus));
  const lostBtn = stageButton('Lost', currentStatus, true);
  container.innerHTML = mainStages.join('') + lostBtn;
  container.querySelectorAll('.stage-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el('leadForm').status.value = btn.dataset.stage;
      renderPipelineControl(btn.dataset.stage);
    });
  });
}

function stageButton(stage, currentStatus, isLost) {
  const active = stage === currentStatus;
  const color = STATUS_COLORS[stage];
  const style = active ? `background:${color}; border-color:${color};` : '';
  return `<button type="button" class="stage-btn${active ? ' active' : ''}${isLost ? ' lost-btn' : ''}" data-stage="${stage}" style="${style}">${stage}</button>`;
}

function renderActivityLog(activity) {
  const log = el('activityLog');
  const sorted = [...activity].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  log.innerHTML = sorted.map(item => `
    <div class="activity-item">
      ${escapeHtml(item.text)}
      <span class="activity-time">${new Date(item.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
    </div>
  `).join('');
}

async function saveLead() {
  const form = el('leadForm');
  if (!form.checkValidity()) { form.reportValidity(); return; }

  const payload = {
    firstName: form.firstName.value,
    lastName: form.lastName.value,
    phone: form.phone.value,
    email: form.email.value,
    interestType: form.interestType.value,
    interestModel: form.interestModel.value,
    source: form.source.value,
    budget: form.budget.value,
  };
  if (form.assignedRepId) payload.assignedRepId = form.assignedRepId.value;

  if (!payload.phone.trim() && !payload.email.trim()) {
    showToast('Add a phone number or email so the lead can be reached');
    return;
  }

  try {
    let res;
    if (state.editingId) {
      payload.status = form.status.value;
      res = await fetch(`${API}/leads/${state.editingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } else {
      res = await fetch(`${API}/leads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    }
    if (!res.ok) {
      const err = await res.json();
      showToast(err.error || 'Could not save lead');
      return;
    }
    closeModal();
    showToast(state.editingId ? 'Lead updated' : 'Lead added to the board');
    await Promise.all([loadStats(), loadLeads()]);
  } catch (err) {
    showToast('Network error — is the server running?');
  }
}

async function deleteLead() {
  if (!state.editingId) return;
  if (!confirm('Delete this lead? This cannot be undone.')) return;
  await fetch(`${API}/leads/${state.editingId}`, { method: 'DELETE' });
  closeModal();
  showToast('Lead deleted');
  await Promise.all([loadStats(), loadLeads()]);
}

async function addNote() {
  const input = el('noteInput');
  if (!input.value.trim() || !state.editingId) return;
  const res = await fetch(`${API}/leads/${state.editingId}/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: input.value }) });
  const lead = await res.json();
  input.value = '';
  renderActivityLog(lead.activity);
  const idx = state.leads.findIndex(l => l.id === lead.id);
  if (idx !== -1) state.leads[idx] = lead;
}

// ---------- reps dashboard (admin) ----------
async function loadRepsDashboard() {
  const res = await fetch(`${API}/reps/stats`);
  const reps = await res.json();
  renderRepCards(reps);
}

function renderRepCards(reps) {
  const container = el('repCards');
  if (reps.length === 0) {
    container.innerHTML = `<p style="color:var(--text-faint);">No sales reps yet — create one from Manage Reps.</p>`;
    return;
  }
  container.innerHTML = reps.map(rep => `
    <div class="rep-card ${rep.active ? '' : 'inactive'}">
      <div class="rep-card-top">
        <span class="rep-card-name">${escapeHtml(rep.name)}</span>
        ${rep.active ? `<span class="rep-card-rate">${rep.conversionRate}% close</span>` : '<span class="inactive-tag">Inactive</span>'}
      </div>
      <div class="rep-card-grid">
        <div class="rep-card-metric"><div class="val">${rep.total}</div><div class="lbl">Total</div></div>
        <div class="rep-card-metric"><div class="val">${rep.newLast7Days}</div><div class="lbl">New 7d</div></div>
        <div class="rep-card-metric"><div class="val">${rep.sold}</div><div class="lbl">Sold</div></div>
      </div>
      <div class="rep-card-bars">
        ${PIPELINE_ORDER.map(stage => {
          const count = rep.byStatus[stage] || 0;
          const pct = rep.total > 0 ? Math.round((count / rep.total) * 100) : 0;
          return `<div class="rep-card-bar-row">
            <span class="rep-card-bar-label">${stage}</span>
            <div class="rep-card-bar-track"><div class="rep-card-bar-fill" style="width:${pct}%; background:${STATUS_COLORS[stage]}"></div></div>
            <span class="rep-card-bar-count">${count}</span>
          </div>`;
        }).join('')}
      </div>
    </div>
  `).join('');
}

// ---------- manage reps (admin) ----------
async function loadManageReps() {
  const res = await fetch(`${API}/users`);
  const users = await res.json();
  state.repsAll = users.filter(u => u.role === 'rep');
  renderRepsTable();
}

function renderRepsTable() {
  const body = el('repsBody');
  if (state.repsAll.length === 0) {
    body.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-faint);padding:30px;">No sales rep accounts yet.</td></tr>`;
    return;
  }
  body.innerHTML = state.repsAll.map(u => `
    <tr>
      <td class="lead-name">${escapeHtml(u.name)}</td>
      <td class="assigned-cell" style="font-family:var(--font-mono);">${escapeHtml(u.username)}</td>
      <td>${u.active ? '<span class="status-pill role-active"><span class="dot"></span>Active</span>' : '<span class="status-pill role-inactive"><span class="dot"></span>Inactive</span>'}</td>
      <td class="updated-cell">${new Date(u.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
      <td style="text-align:right;"><button class="link-btn" data-id="${u.id}">Manage</button></td>
    </tr>
  `).join('');
  body.querySelectorAll('.link-btn').forEach(btn => {
    btn.addEventListener('click', () => openRepModal('edit', btn.dataset.id));
  });
}

function openRepModal(mode, id) {
  const form = el('repForm');
  form.reset();
  state.editingRepId = mode === 'edit' ? id : null;

  el('repActiveField').hidden = mode !== 'edit';
  form.password.required = mode === 'new';
  form.username.disabled = mode === 'edit';
  el('repPasswordHint').textContent = mode === 'new'
    ? 'At least 6 characters. Share it with the rep — they can sign in right away.'
    : 'Leave blank to keep their current password.';

  if (mode === 'new') {
    el('repModalEyebrow').textContent = 'New Rep';
    el('repModalTitle').textContent = 'Create rep account';
  } else {
    const rep = state.repsAll.find(r => r.id === id);
    if (!rep) return;
    el('repModalEyebrow').textContent = rep.active ? 'Active' : 'Inactive';
    el('repModalTitle').textContent = rep.name;
    form.name.value = rep.name;
    form.username.value = rep.username;
    form.active.checked = rep.active;
  }

  el('repModalOverlay').hidden = false;
  form.name.focus();
}

function closeRepModal() {
  el('repModalOverlay').hidden = true;
  state.editingRepId = null;
  el('leadForm'); // no-op, keeps linter happy
  el('repForm').username.disabled = false;
}

async function saveRep() {
  const form = el('repForm');
  if (!form.checkValidity()) { form.reportValidity(); return; }

  const payload = { name: form.name.value };
  if (form.password.value) payload.password = form.password.value;

  try {
    let res;
    if (state.editingRepId) {
      payload.active = form.active.checked;
      res = await fetch(`${API}/users/${state.editingRepId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    } else {
      payload.username = form.username.value;
      res = await fetch(`${API}/users`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    }
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Could not save rep account'); return; }
    closeRepModal();
    showToast(state.editingRepId ? 'Rep account updated' : 'Rep account created');
    await loadManageReps();
    await loadReps();
  } catch (err) {
    showToast('Network error — is the server running?');
  }
}

// ---------- toast ----------
let toastTimer;
function showToast(msg) {
  const toast = el('toast');
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

init();
