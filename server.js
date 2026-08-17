const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 4000;
const COOKIE_NAME = 'ppsleads_session';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const DATA_DIR = path.join(__dirname, 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// ---------- constants ----------
const STATUSES = ['New', 'Contacted', 'Qualified', 'Test Ride', 'Financing', 'Sold', 'Lost'];
const SOURCES = ['Walk-In', 'Facebook', 'TikTok', 'Website', 'Referral', 'Phone', 'Other'];
const INTEREST_TYPES = ['ATV', 'UTV', 'Motorcycle', 'Scooter', 'Dirt Bike', 'Golf Kart', 'Other'];

// ---------- tiny JSON-file datastore ----------
function ensureFile(file, initial) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(initial, null, 2));
}

function readJSON(file, initial) {
  ensureFile(file, initial);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(`Failed to read ${file}, starting fresh:`, err.message);
    return initial;
  }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const readLeadsStore = () => readJSON(LEADS_FILE, { leads: [] });
const writeLeadsStore = (store) => writeJSON(LEADS_FILE, store);
const readUsersStore = () => readJSON(USERS_FILE, { users: [] });
const writeUsersStore = (store) => writeJSON(USERS_FILE, store);

// ---------- password hashing (scrypt, no extra deps) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------- sessions (in-memory) ----------
const sessions = new Map(); // token -> { userId, expires }

function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function destroySession(token) {
  sessions.delete(token);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

function setSessionCookie(res, token) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (COOKIE_SECURE) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  const attrs = [`${COOKIE_NAME}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (COOKIE_SECURE) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function safeUser(u) {
  return { id: u.id, username: u.username, name: u.name, role: u.role, active: u.active, createdAt: u.createdAt };
}

// ---------- auth middleware ----------
function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  const session = token ? sessions.get(token) : null;
  if (!session || session.expires < Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { users } = readUsersStore();
  const user = users.find(u => u.id === session.userId && u.active);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  req.sessionToken = token;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  next();
}

function badRequest(res, message) { return res.status(400).json({ error: message }); }
function notFound(res) { return res.status(404).json({ error: 'Not found' }); }

// ---------- app setup ----------
app.use(express.json());

// ================= AUTH ROUTES =================
app.get('/api/auth/status', (req, res) => {
  const { users } = readUsersStore();
  const needsSetup = users.length === 0;

  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  const session = token ? sessions.get(token) : null;
  let user = null;
  if (session && session.expires >= Date.now()) {
    const found = users.find(u => u.id === session.userId && u.active);
    if (found) user = safeUser(found);
  }
  res.json({ needsSetup, authenticated: !!user, user });
});

app.post('/api/auth/setup', (req, res) => {
  const store = readUsersStore();
  if (store.users.length > 0) return res.status(409).json({ error: 'Setup already completed' });

  const { username, password, name } = req.body || {};
  if (!username || !username.trim()) return badRequest(res, 'Username is required');
  if (!password || password.length < 6) return badRequest(res, 'Password must be at least 6 characters');
  if (!name || !name.trim()) return badRequest(res, 'Name is required');

  const now = new Date().toISOString();
  const admin = {
    id: crypto.randomUUID(),
    username: username.trim().toLowerCase(),
    passwordHash: hashPassword(password),
    name: name.trim(),
    role: 'admin',
    active: true,
    createdAt: now,
  };
  store.users.push(admin);
  writeUsersStore(store);

  const token = createSession(admin.id);
  setSessionCookie(res, token);
  res.status(201).json({ user: safeUser(admin) });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return badRequest(res, 'Username and password are required');

  const { users } = readUsersStore();
  const user = users.find(u => u.username === username.trim().toLowerCase());
  if (!user || !user.active || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = createSession(user.id);
  setSessionCookie(res, token);
  res.json({ user: safeUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (token) destroySession(token);
  clearSessionCookie(res);
  res.status(204).end();
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: safeUser(req.user) });
});

// From here on, everything requires a logged-in session.
app.use('/api', requireAuth);

// ================= META =================
app.get('/api/meta', (req, res) => {
  res.json({ statuses: STATUSES, sources: SOURCES, interestTypes: INTEREST_TYPES });
});

// ================= USER MANAGEMENT (admin only) =================
app.get('/api/users', requireAdmin, (req, res) => {
  const { users } = readUsersStore();
  res.json(users.map(safeUser));
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, name } = req.body || {};
  if (!username || !username.trim()) return badRequest(res, 'Username is required');
  if (!password || password.length < 6) return badRequest(res, 'Password must be at least 6 characters');
  if (!name || !name.trim()) return badRequest(res, 'Name is required');

  const store = readUsersStore();
  const uname = username.trim().toLowerCase();
  if (store.users.some(u => u.username === uname)) return badRequest(res, 'That username is already taken');

  const rep = {
    id: crypto.randomUUID(),
    username: uname,
    passwordHash: hashPassword(password),
    name: name.trim(),
    role: 'rep',
    active: true,
    createdAt: new Date().toISOString(),
  };
  store.users.push(rep);
  writeUsersStore(store);
  res.status(201).json(safeUser(rep));
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const store = readUsersStore();
  const idx = store.users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return notFound(res);

  const { name, active, password } = req.body || {};
  const user = store.users[idx];
  if (name !== undefined) user.name = name.trim();
  if (active !== undefined) user.active = !!active;
  if (password) {
    if (password.length < 6) return badRequest(res, 'Password must be at least 6 characters');
    user.passwordHash = hashPassword(password);
  }
  store.users[idx] = user;
  writeUsersStore(store);
  res.json(safeUser(user));
});

// ================= REPS (admin only) =================
app.get('/api/reps', requireAdmin, (req, res) => {
  const { users } = readUsersStore();
  res.json(users.filter(u => u.role === 'rep' && u.active).map(safeUser));
});

app.get('/api/reps/stats', requireAdmin, (req, res) => {
  const { users } = readUsersStore();
  const { leads } = readLeadsStore();
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const reps = users.filter(u => u.role === 'rep');
  const result = reps.map(rep => {
    const repLeads = leads.filter(l => l.assignedRepId === rep.id);
    const byStatus = {};
    STATUSES.forEach(s => { byStatus[s] = 0; });
    repLeads.forEach(l => { byStatus[l.status] = (byStatus[l.status] || 0) + 1; });
    const sold = byStatus['Sold'] || 0;
    const lost = byStatus['Lost'] || 0;
    const closed = sold + lost;
    return {
      id: rep.id,
      name: rep.name,
      username: rep.username,
      active: rep.active,
      total: repLeads.length,
      newLast7Days: repLeads.filter(l => new Date(l.createdAt) >= sevenDaysAgo).length,
      byStatus,
      sold,
      lost,
      conversionRate: closed > 0 ? Math.round((sold / closed) * 100) : 0,
    };
  });
  result.sort((a, b) => b.total - a.total);
  res.json(result);
});

// ================= STATS (scoped by role) =================
app.get('/api/stats', (req, res) => {
  const { leads: allLeads } = readLeadsStore();
  const leads = req.user.role === 'admin' ? allLeads : allLeads.filter(l => l.assignedRepId === req.user.id);

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const total = leads.length;
  const newLast7Days = leads.filter(l => new Date(l.createdAt) >= sevenDaysAgo).length;
  const testRideScheduled = leads.filter(l => l.status === 'Test Ride').length;
  const soldThisMonth = leads.filter(l => l.status === 'Sold' && new Date(l.updatedAt) >= monthStart).length;
  const soldTotal = leads.filter(l => l.status === 'Sold').length;
  const lostTotal = leads.filter(l => l.status === 'Lost').length;
  const closedTotal = soldTotal + lostTotal;
  const conversionRate = closedTotal > 0 ? Math.round((soldTotal / closedTotal) * 100) : 0;

  const byStatus = {};
  STATUSES.forEach(s => { byStatus[s] = 0; });
  leads.forEach(l => { byStatus[l.status] = (byStatus[l.status] || 0) + 1; });

  res.json({ total, newLast7Days, testRideScheduled, soldThisMonth, conversionRate, byStatus });
});

// ================= LEADS =================
function attachRepNames(leads) {
  const { users } = readUsersStore();
  const byId = {};
  users.forEach(u => { byId[u.id] = u.name; });
  return leads.map(l => ({ ...l, assignedRepName: l.assignedRepId ? (byId[l.assignedRepId] || 'Unknown') : null }));
}

app.get('/api/leads', (req, res) => {
  const { leads } = readLeadsStore();
  const { status, source, interestType, q, sort, assignedRepId } = req.query;

  let result = leads.slice();

  if (req.user.role !== 'admin') {
    result = result.filter(l => l.assignedRepId === req.user.id);
  } else if (assignedRepId) {
    result = assignedRepId === 'unassigned'
      ? result.filter(l => !l.assignedRepId)
      : result.filter(l => l.assignedRepId === assignedRepId);
  }

  if (status && status !== 'All') result = result.filter(l => l.status === status);
  if (source && source !== 'All') result = result.filter(l => l.source === source);
  if (interestType && interestType !== 'All') result = result.filter(l => l.interestType === interestType);

  if (q && q.trim()) {
    const needle = q.trim().toLowerCase();
    result = result.filter(l =>
      `${l.firstName} ${l.lastName}`.toLowerCase().includes(needle) ||
      (l.phone || '').toLowerCase().includes(needle) ||
      (l.email || '').toLowerCase().includes(needle) ||
      (l.interestModel || '').toLowerCase().includes(needle)
    );
  }

  const sortKey = sort || 'createdAt_desc';
  const [field, dir] = sortKey.split('_');
  result.sort((a, b) => {
    let av = a[field]; let bv = b[field];
    if (field === 'createdAt' || field === 'updatedAt') { av = new Date(av).getTime(); bv = new Date(bv).getTime(); }
    else { av = (av || '').toString().toLowerCase(); bv = (bv || '').toString().toLowerCase(); }
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });

  res.json(attachRepNames(result));
});

app.get('/api/leads/:id', (req, res) => {
  const { leads } = readLeadsStore();
  const lead = leads.find(l => l.id === req.params.id);
  if (!lead) return notFound(res);
  if (req.user.role !== 'admin' && lead.assignedRepId !== req.user.id) return notFound(res);
  res.json(attachRepNames([lead])[0]);
});

app.post('/api/leads', (req, res) => {
  const b = req.body || {};
  if (!b.firstName || !b.firstName.trim()) return badRequest(res, 'First name is required');
  if (!b.lastName || !b.lastName.trim()) return badRequest(res, 'Last name is required');
  if (!b.phone && !b.email) return badRequest(res, 'A phone number or email is required');

  let assignedRepId = null;
  if (req.user.role === 'admin') {
    if (b.assignedRepId) {
      const { users } = readUsersStore();
      const rep = users.find(u => u.id === b.assignedRepId && u.role === 'rep' && u.active);
      if (!rep) return badRequest(res, 'Selected sales rep was not found');
      assignedRepId = rep.id;
    }
  } else {
    assignedRepId = req.user.id; // reps' leads are always assigned to themselves
  }

  const now = new Date().toISOString();
  const lead = {
    id: crypto.randomUUID(),
    firstName: b.firstName.trim(),
    lastName: b.lastName.trim(),
    phone: (b.phone || '').trim(),
    email: (b.email || '').trim(),
    source: SOURCES.includes(b.source) ? b.source : 'Other',
    interestType: INTEREST_TYPES.includes(b.interestType) ? b.interestType : 'Other',
    interestModel: (b.interestModel || '').trim(),
    budget: b.budget ? Number(b.budget) : null,
    status: STATUSES.includes(b.status) ? b.status : 'New',
    assignedRepId,
    createdBy: req.user.id,
    activity: [{ id: crypto.randomUUID(), text: `Lead created${req.user.role === 'admin' ? '' : ` by ${req.user.name}`}`, createdAt: now }],
    createdAt: now,
    updatedAt: now,
  };

  const store = readLeadsStore();
  store.leads.push(lead);
  writeLeadsStore(store);
  res.status(201).json(attachRepNames([lead])[0]);
});

app.put('/api/leads/:id', (req, res) => {
  const store = readLeadsStore();
  const idx = store.leads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return notFound(res);
  const existing = store.leads[idx];
  if (req.user.role !== 'admin' && existing.assignedRepId !== req.user.id) return notFound(res);

  const b = req.body || {};
  const statusChanged = b.status && b.status !== existing.status;
  const activityAdds = [];

  let assignedRepId = existing.assignedRepId;
  if (req.user.role === 'admin' && b.assignedRepId !== undefined) {
    if (!b.assignedRepId) {
      assignedRepId = null;
    } else {
      const { users } = readUsersStore();
      const rep = users.find(u => u.id === b.assignedRepId && u.role === 'rep' && u.active);
      if (!rep) return badRequest(res, 'Selected sales rep was not found');
      if (rep.id !== existing.assignedRepId) {
        activityAdds.push({ id: crypto.randomUUID(), text: `Reassigned to ${rep.name}`, createdAt: new Date().toISOString() });
      }
      assignedRepId = rep.id;
    }
  }

  const updated = {
    ...existing,
    firstName: b.firstName !== undefined ? b.firstName.trim() : existing.firstName,
    lastName: b.lastName !== undefined ? b.lastName.trim() : existing.lastName,
    phone: b.phone !== undefined ? b.phone.trim() : existing.phone,
    email: b.email !== undefined ? b.email.trim() : existing.email,
    source: b.source && SOURCES.includes(b.source) ? b.source : existing.source,
    interestType: b.interestType && INTEREST_TYPES.includes(b.interestType) ? b.interestType : existing.interestType,
    interestModel: b.interestModel !== undefined ? b.interestModel.trim() : existing.interestModel,
    budget: b.budget !== undefined ? (b.budget === '' || b.budget === null ? null : Number(b.budget)) : existing.budget,
    status: b.status && STATUSES.includes(b.status) ? b.status : existing.status,
    assignedRepId,
    updatedAt: new Date().toISOString(),
  };

  if (statusChanged) {
    activityAdds.push({ id: crypto.randomUUID(), text: `Status changed: ${existing.status} → ${updated.status}`, createdAt: updated.updatedAt });
  }
  if (activityAdds.length) updated.activity = [...existing.activity, ...activityAdds];

  store.leads[idx] = updated;
  writeLeadsStore(store);
  res.json(attachRepNames([updated])[0]);
});

app.post('/api/leads/:id/notes', (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return badRequest(res, 'Note text is required');

  const store = readLeadsStore();
  const idx = store.leads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return notFound(res);
  const lead = store.leads[idx];
  if (req.user.role !== 'admin' && lead.assignedRepId !== req.user.id) return notFound(res);

  const note = { id: crypto.randomUUID(), text: text.trim(), createdAt: new Date().toISOString() };
  lead.activity.push(note);
  lead.updatedAt = note.createdAt;
  writeLeadsStore(store);
  res.status(201).json(attachRepNames([lead])[0]);
});

app.delete('/api/leads/:id', requireAdmin, (req, res) => {
  const store = readLeadsStore();
  const idx = store.leads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return notFound(res);
  store.leads.splice(idx, 1);
  writeLeadsStore(store);
  res.status(204).end();
});

// static frontend (after API routes so /api/* never falls through to index.html)
app.use(express.static(path.join(__dirname, 'public')));

ensureFile(LEADS_FILE, { leads: [] });
ensureFile(USERS_FILE, { users: [] });
app.listen(PORT, () => {
  console.log(`Pioneer Powersports Lead Manager running at http://localhost:${PORT}`);
});
