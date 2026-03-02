const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'sales-dashboard-2026-key';
const DATABASE_URL = process.env.DATABASE_URL;
const COMMISSION_RATE = 0.175;
const CLOSER_RATE = 0.30;
const BANK_ONCE_INCENTIVE = 1000;
const PAYMENT_METHOD_LABELS = {
  card_once: 'クレカ一括',
  card_installment: 'クレカ分割',
  card_bank_mix: 'クレカと銀行振込',
  bank_once: '銀行振込一括'
};

// --- Middleware ---
if (DATABASE_URL) app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// --- Utility ---
function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function getCurrentMonth() {
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function getPrevMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function getISOWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// ============================================================
// Database Abstraction - JSON File or PostgreSQL
// ============================================================
let db;

if (DATABASE_URL) {
  // ---- PostgreSQL Mode ----
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  function mapUser(r) { return { id: r.id, username: r.username, password: r.password, displayName: r.display_name, role: r.role }; }
  function mapDeal(r) { return { id: r.id, date: r.date, month: r.month, clientName: r.client_name, closer: r.closer, closerUserId: r.closer_user_id || null, productPrice: r.product_price, status: r.status, lossReason: r.loss_reason, hasFollowUp: r.has_follow_up, paymentMethod: r.payment_method || 'card_once', createdBy: r.created_by }; }

  db = {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'closer')`);
      await pool.query(`CREATE TABLE IF NOT EXISTS closers (name TEXT PRIMARY KEY)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS deals (id TEXT PRIMARY KEY, date TEXT NOT NULL, month TEXT NOT NULL, client_name TEXT NOT NULL, closer TEXT NOT NULL, closer_user_id TEXT, product_price INTEGER NOT NULL, status TEXT NOT NULL, loss_reason TEXT DEFAULT '', has_follow_up BOOLEAN DEFAULT FALSE, payment_method TEXT DEFAULT 'card_once', created_by TEXT)`);
      await pool.query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'card_once'`);
      await pool.query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS closer_user_id TEXT`);
      await pool.query(`CREATE TABLE IF NOT EXISTS kpi_goals (week_key TEXT PRIMARY KEY, closed_target INTEGER NOT NULL DEFAULT 0, rate_target NUMERIC NOT NULL DEFAULT 0)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS user_kpi_goals (week_key TEXT NOT NULL, user_id TEXT NOT NULL, closed_target INTEGER NOT NULL DEFAULT 0, rate_target NUMERIC NOT NULL DEFAULT 0, result_status TEXT NOT NULL DEFAULT 'auto', PRIMARY KEY (week_key, user_id))`);
      await pool.query(`ALTER TABLE user_kpi_goals ADD COLUMN IF NOT EXISTS result_status TEXT NOT NULL DEFAULT 'auto'`);
      const { rows } = await pool.query('SELECT COUNT(*) FROM users');
      if (parseInt(rows[0].count) === 0) {
        const hash = bcrypt.hashSync('admin123', 10);
        await pool.query('INSERT INTO users (id, username, password, display_name, role) VALUES ($1,$2,$3,$4,$5)', [generateId(), 'admin', hash, '管理者', 'admin']);
        console.log('初期管理者を作成 (admin / admin123)');
      }
    },
    async getUserByUsername(username) { const { rows } = await pool.query('SELECT * FROM users WHERE username=$1', [username]); return rows[0] ? mapUser(rows[0]) : null; },
    async getUserById(id) { const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [id]); return rows[0] ? mapUser(rows[0]) : null; },
    async getUsers() { const { rows } = await pool.query('SELECT * FROM users ORDER BY role, display_name'); return rows.map(mapUser); },
    async addUser(u) { await pool.query('INSERT INTO users (id,username,password,display_name,role) VALUES ($1,$2,$3,$4,$5)', [u.id, u.username, u.password, u.displayName, u.role]); return u; },
    async deleteUser(id) { await pool.query('DELETE FROM users WHERE id=$1', [id]); },
    async getClosers() { const { rows } = await pool.query('SELECT name FROM closers ORDER BY name'); return rows.map(r => r.name); },
    async addCloser(name) { await pool.query('INSERT INTO closers (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]); return db.getClosers(); },
    async deleteCloser(name) { await pool.query('DELETE FROM closers WHERE name=$1', [name]); return db.getClosers(); },
    async closerExists(name) { const { rows } = await pool.query('SELECT 1 FROM closers WHERE name=$1', [name]); return rows.length > 0; },
    async getDealsByMonth(month) { const { rows } = await pool.query('SELECT * FROM deals WHERE month=$1 ORDER BY date DESC', [month]); return rows.map(mapDeal); },
    async getDealById(id) { const { rows } = await pool.query('SELECT * FROM deals WHERE id=$1', [id]); return rows[0] ? mapDeal(rows[0]) : null; },
    async addDeal(d) { await pool.query('INSERT INTO deals (id,date,month,client_name,closer,closer_user_id,product_price,status,loss_reason,has_follow_up,payment_method,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [d.id, d.date, d.month, d.clientName, d.closer, d.closerUserId || null, d.productPrice, d.status, d.lossReason, d.hasFollowUp, d.paymentMethod || 'card_once', d.createdBy]); return d; },
    async updateDeal(id, d) { await pool.query('UPDATE deals SET date=$1,month=$2,client_name=$3,closer=$4,closer_user_id=$5,product_price=$6,status=$7,loss_reason=$8,has_follow_up=$9,payment_method=$10 WHERE id=$11', [d.date, d.month, d.clientName, d.closer, d.closerUserId || null, d.productPrice, d.status, d.lossReason, d.hasFollowUp, d.paymentMethod || 'card_once', id]); },
    async deleteDeal(id) { await pool.query('DELETE FROM deals WHERE id=$1', [id]); },
    async getKpiGoalByWeek(weekKey) {
      const { rows } = await pool.query('SELECT week_key, closed_target, rate_target FROM kpi_goals WHERE week_key=$1', [weekKey]);
      if (!rows[0]) return { weekKey, closedTarget: 0, rateTarget: 0 };
      return { weekKey: rows[0].week_key, closedTarget: parseInt(rows[0].closed_target, 10) || 0, rateTarget: parseFloat(rows[0].rate_target) || 0 };
    },
    async upsertKpiGoal(weekKey, closedTarget, rateTarget) {
      await pool.query(
        'INSERT INTO kpi_goals (week_key, closed_target, rate_target) VALUES ($1,$2,$3) ON CONFLICT (week_key) DO UPDATE SET closed_target=EXCLUDED.closed_target, rate_target=EXCLUDED.rate_target',
        [weekKey, closedTarget, rateTarget]
      );
      return { weekKey, closedTarget, rateTarget };
    },
    async getUserKpiGoalByWeek(weekKey, userId) {
      const { rows } = await pool.query('SELECT week_key, user_id, closed_target, rate_target, result_status FROM user_kpi_goals WHERE week_key=$1 AND user_id=$2', [weekKey, userId]);
      if (!rows[0]) return { weekKey, userId, closedTarget: 0, rateTarget: 0, resultStatus: 'auto' };
      return { weekKey: rows[0].week_key, userId: rows[0].user_id, closedTarget: parseInt(rows[0].closed_target, 10) || 0, rateTarget: parseFloat(rows[0].rate_target) || 0, resultStatus: rows[0].result_status || 'auto' };
    },
    async upsertUserKpiGoal(weekKey, userId, closedTarget, rateTarget, resultStatus = 'auto') {
      await pool.query(
        'INSERT INTO user_kpi_goals (week_key, user_id, closed_target, rate_target, result_status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (week_key, user_id) DO UPDATE SET closed_target=EXCLUDED.closed_target, rate_target=EXCLUDED.rate_target, result_status=EXCLUDED.result_status',
        [weekKey, userId, closedTarget, rateTarget, resultStatus]
      );
      return { weekKey, userId, closedTarget, rateTarget, resultStatus };
    }
  };
  console.log('PostgreSQLモードで起動');

} else {
  // ---- JSON File Mode (ローカル開発用) ----
  const DATA_DIR = path.join(__dirname, 'data');
  const DB_PATH = path.join(DATA_DIR, 'db.json');
  function readDB() {
    const data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!Array.isArray(data.kpiGoals)) data.kpiGoals = [];
    if (!Array.isArray(data.userKpiGoals)) data.userKpiGoals = [];
    if (Array.isArray(data.deals)) data.deals = data.deals.map(d => ({ ...d, paymentMethod: d.paymentMethod || 'card_once', closerUserId: d.closerUserId || null }));
    return data;
  }
  function writeDB(data) { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8'); }

  db = {
    async init() {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      if (!fs.existsSync(DB_PATH)) {
        const hash = bcrypt.hashSync('admin123', 10);
        writeDB({ users: [{ id: generateId(), username: 'admin', password: hash, displayName: '管理者', role: 'admin' }], closers: [], deals: [], kpiGoals: [], userKpiGoals: [] });
        console.log('初期データベースを作成 (admin / admin123)');
      }
    },
    async getUserByUsername(username) { return readDB().users.find(u => u.username === username) || null; },
    async getUserById(id) { return readDB().users.find(u => u.id === id) || null; },
    async getUsers() { return readDB().users; },
    async addUser(u) { const d = readDB(); d.users.push(u); writeDB(d); return u; },
    async deleteUser(id) { const d = readDB(); d.users = d.users.filter(u => u.id !== id); writeDB(d); },
    async getClosers() { return readDB().closers; },
    async addCloser(name) { const d = readDB(); if (!d.closers.includes(name)) { d.closers.push(name); writeDB(d); } return readDB().closers; },
    async deleteCloser(name) { const d = readDB(); d.closers = d.closers.filter(c => c !== name); writeDB(d); return d.closers; },
    async closerExists(name) { return readDB().closers.includes(name); },
    async getDealsByMonth(month) { return readDB().deals.filter(d => d.month === month); },
    async getDealById(id) { return readDB().deals.find(d => d.id === id) || null; },
    async addDeal(deal) { const d = readDB(); d.deals.push(deal); writeDB(d); return deal; },
    async updateDeal(id, updates) { const d = readDB(); const idx = d.deals.findIndex(x => x.id === id); if (idx !== -1) { d.deals[idx] = { ...d.deals[idx], ...updates, id }; writeDB(d); } },
    async deleteDeal(id) { const d = readDB(); d.deals = d.deals.filter(x => x.id !== id); writeDB(d); },
    async getKpiGoalByWeek(weekKey) {
      const g = readDB().kpiGoals.find(x => x.weekKey === weekKey);
      if (!g) return { weekKey, closedTarget: 0, rateTarget: 0 };
      return { weekKey, closedTarget: parseInt(g.closedTarget, 10) || 0, rateTarget: parseFloat(g.rateTarget) || 0 };
    },
    async upsertKpiGoal(weekKey, closedTarget, rateTarget) {
      const d = readDB();
      const idx = d.kpiGoals.findIndex(x => x.weekKey === weekKey);
      const payload = { weekKey, closedTarget, rateTarget };
      if (idx === -1) d.kpiGoals.push(payload);
      else d.kpiGoals[idx] = payload;
      writeDB(d);
      return payload;
    },
    async getUserKpiGoalByWeek(weekKey, userId) {
      const g = readDB().userKpiGoals.find(x => x.weekKey === weekKey && x.userId === userId);
      if (!g) return { weekKey, userId, closedTarget: 0, rateTarget: 0, resultStatus: 'auto' };
      return { weekKey, userId, closedTarget: parseInt(g.closedTarget, 10) || 0, rateTarget: parseFloat(g.rateTarget) || 0, resultStatus: g.resultStatus || 'auto' };
    },
    async upsertUserKpiGoal(weekKey, userId, closedTarget, rateTarget, resultStatus = 'auto') {
      const d = readDB();
      const idx = d.userKpiGoals.findIndex(x => x.weekKey === weekKey && x.userId === userId);
      const payload = { weekKey, userId, closedTarget, rateTarget, resultStatus };
      if (idx === -1) d.userKpiGoals.push(payload);
      else d.userKpiGoals[idx] = payload;
      writeDB(d);
      return payload;
    }
  };
  console.log('JSONファイルモードで起動');
}

// ============================================================
// Auth Middleware
// ============================================================
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '認証が必要です' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: '認証が必要です' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: '管理者権限が必要です' });
  next();
}

// ============================================================
// Auth Routes
// ============================================================
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'ユーザー名とパスワードを入力してください' });
    const user = await db.getUserByUsername(username);
    if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'ユーザー名またはパスワードが正しくありません' });
    req.session.userId = user.id;
    req.session.role = user.role;
    res.json({ id: user.id, username: user.username, displayName: user.displayName, role: user.role });
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const user = await db.getUserById(req.session.userId);
    if (!user) { req.session.destroy(); return res.status(401).json({ error: 'ユーザーが見つかりません' }); }
    res.json({ id: user.id, username: user.username, displayName: user.displayName, role: user.role });
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

// ============================================================
// Dashboard
// ============================================================
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const month = req.query.month || getCurrentMonth();
    const weekKey = req.query.weekKey || getISOWeekKey();
    const [deals, prevDeals, closers] = await Promise.all([
      db.getDealsByMonth(month), db.getDealsByMonth(getPrevMonth(month)), db.getClosers()
    ]);
    const kpiGoal = await db.getKpiGoalByWeek(weekKey);
    const myKpiGoal = await db.getUserKpiGoalByWeek(weekKey, req.session.userId);
    res.json({ deals, prevDeals, closers, kpiGoal, myKpiGoal });
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

// ============================================================
// Deals CRUD
// ============================================================
app.post('/api/deals', requireAuth, async (req, res) => {
  try {
    const { date, month, clientName, closer, closerUserId, productPrice, status, lossReason, hasFollowUp, paymentMethod } = req.body;
    if (!date || !clientName || !closer || !productPrice || !status) return res.status(400).json({ error: '必須項目を入力してください' });
    const deal = { id: generateId(), date, month, clientName, closer, closerUserId: closerUserId || null, productPrice, status, lossReason: lossReason || '', hasFollowUp: !!hasFollowUp, paymentMethod: paymentMethod || 'card_once', createdBy: req.session.userId };
    await db.addDeal(deal);
    res.json(deal);
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.put('/api/deals/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await db.getDealById(req.params.id);
    if (!existing) return res.status(404).json({ error: '商談が見つかりません' });
    const { date, month, clientName, closer, closerUserId, productPrice, status, lossReason, hasFollowUp, paymentMethod } = req.body;
    await db.updateDeal(req.params.id, { date, month, clientName, closer, closerUserId: closerUserId || null, productPrice, status, lossReason: lossReason || '', hasFollowUp: !!hasFollowUp, paymentMethod: paymentMethod || 'card_once' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.put('/api/kpi-goals/:weekKey', requireAdmin, async (req, res) => {
  try {
    const { closedTarget, rateTarget } = req.body;
    const normalizedClosed = Math.max(0, parseInt(closedTarget, 10) || 0);
    const normalizedRate = Math.max(0, Math.min(100, parseFloat(rateTarget) || 0));
    const goal = await db.upsertKpiGoal(req.params.weekKey, normalizedClosed, normalizedRate);
    res.json(goal);
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.get('/api/kpi-users', requireAuth, async (req, res) => {
  try {
    if (req.session.role === 'admin') {
      const users = await db.getUsers();
      const targets = users
        .filter(u => u.role === 'closer' || u.role === 'admin')
        .map(u => ({ id: u.id, displayName: u.displayName, username: u.username, role: u.role }));
      return res.json(targets);
    }
    const me = await db.getUserById(req.session.userId);
    if (!me) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    return res.json([{ id: me.id, displayName: me.displayName, username: me.username, role: me.role }]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.get('/api/closer-users', requireAuth, async (req, res) => {
  try {
    const users = await db.getUsers();
    const closers = users
      .filter(u => u.role === 'closer' || u.role === 'admin')
      .map(u => ({ id: u.id, displayName: u.displayName, username: u.username, role: u.role }));
    res.json(closers);
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.get('/api/my-kpi-goal/:weekKey', requireAuth, async (req, res) => {
  try {
    const targetUserId = (req.session.role === 'admin' && req.query.userId) ? req.query.userId : req.session.userId;
    const goal = await db.getUserKpiGoalByWeek(req.params.weekKey, targetUserId);
    res.json(goal);
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.put('/api/my-kpi-goal/:weekKey', requireAuth, async (req, res) => {
  try {
    const { closedTarget, rateTarget, resultStatus } = req.body;
    const targetUserId = (req.session.role === 'admin' && req.query.userId) ? req.query.userId : req.session.userId;
    const normalizedClosed = Math.max(0, parseInt(closedTarget, 10) || 0);
    const normalizedRate = Math.max(0, Math.min(100, parseFloat(rateTarget) || 0));
    const normalizedStatus = ['auto', 'achieved', 'not_achieved'].includes(resultStatus) ? resultStatus : 'auto';
    const goal = await db.upsertUserKpiGoal(req.params.weekKey, targetUserId, normalizedClosed, normalizedRate, normalizedStatus);
    res.json(goal);
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.delete('/api/deals/:id', requireAdmin, async (req, res) => {
  try { await db.deleteDeal(req.params.id); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

// ============================================================
// Closers
// ============================================================
app.get('/api/closers', requireAuth, async (req, res) => {
  try { res.json(await db.getClosers()); }
  catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.post('/api/closers', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: '名前を入力してください' });
    if (await db.closerExists(name.trim())) return res.status(400).json({ error: '同名のクローザーが既に存在します' });
    res.json(await db.addCloser(name.trim()));
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.delete('/api/closers/:name', requireAdmin, async (req, res) => {
  try { res.json(await db.deleteCloser(req.params.name)); }
  catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

// ============================================================
// Users
// ============================================================
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const users = await db.getUsers();
    res.json(users.map(u => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role })));
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { username, password, displayName, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'ユーザー名とパスワードを入力してください' });
    if (await db.getUserByUsername(username)) return res.status(400).json({ error: '同名のユーザーが既に存在します' });
    const user = { id: generateId(), username: username.trim(), password: bcrypt.hashSync(password, 10), displayName: (displayName || username).trim(), role: role || 'closer' };
    await db.addUser(user);
    res.json({ id: user.id, username: user.username, displayName: user.displayName, role: user.role });
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.session.userId) return res.status(400).json({ error: '自分自身は削除できません' });
    await db.deleteUser(req.params.id);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

// ============================================================
// CSV Export
// ============================================================
app.get('/api/export/csv', requireAdmin, async (req, res) => {
  try {
    const month = req.query.month || getCurrentMonth();
    const deals = await db.getDealsByMonth(month);
    const headers = ['日付', '商談相手', 'クローザー', '商材単価', '支払い手段', '状況', '失注理由', '再面談', '成約単価', 'クローザー報酬'];
    const rows = deals.map(d => {
      const sl = d.status === 'closed' ? '成約' : d.status === 'lost' ? '失注' : '検討';
      const payment = d.paymentMethod || 'card_once';
      const incentive = d.status === 'closed' && payment === 'bank_once' ? BANK_ONCE_INCENTIVE : 0;
      const comm = d.status === 'closed' ? d.productPrice * COMMISSION_RATE : 0;
      const comp = d.status === 'closed' ? Math.round(comm * CLOSER_RATE) + incentive : 0;
      return [d.date, d.clientName, d.closer, d.productPrice, PAYMENT_METHOD_LABELS[payment] || payment, sl, d.lossReason || '', d.hasFollowUp ? 'あり' : 'なし', comm, comp];
    });
    const csv = '\uFEFF' + [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sales_${month}.csv"`);
    res.send(csv);
  } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
});

// ============================================================
// Start
// ============================================================
(async () => {
  await db.init();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n営業管理ダッシュボード起動中`);
    console.log(`ローカル:  http://localhost:${PORT}`);
    if (!DATABASE_URL) {
      const nets = require('os').networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal) console.log(`ネットワーク: http://${net.address}:${PORT}`);
        }
      }
    }
    console.log(`\n初回ログイン: admin / admin123\n`);
  });
})();
