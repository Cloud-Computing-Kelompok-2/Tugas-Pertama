require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: +(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'cbt_portal',
  connectionLimit: 10,
});

// Session disimpan di MySQL (bukan memori), jadi tetap hidup saat backend restart.
const store = new MySQLStore({ clearExpired: true, expiration: 8 * 3600 * 1000 }, pool);

const app = express();
app.use(express.json());
app.use(session({
  name: 'cbt.sid',
  secret: process.env.SESSION_SECRET || 'dev-secret',
  store,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 3600 * 1000, httpOnly: true, sameSite: 'lax' },
}));
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e.message);
  res.status(500).json({ error: 'server_error' });
});
const auth = (req, res, next) => (req.session.studentId ? next() : res.status(401).json({ error: 'unauthorized' }));

// Sisa waktu dihitung di database (server), bukan di browser.
async function ownSession(id, studentId) {
  const [r] = await pool.query(
    `SELECT s.id, s.exam_id, s.status,
            e.durasi_menit * 60 - TIMESTAMPDIFF(SECOND, s.started_at, NOW()) AS sisa
       FROM exam_sessions s JOIN exams e ON e.id = s.exam_id
      WHERE s.id = ? AND s.student_id = ?`, [id, studentId]);
  return r[0];
}

app.get('/health', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', database: 'up' });
}));

app.post('/api/login', wrap(async (req, res) => {
  const { nim, password } = req.body || {};
  const [r] = await pool.query('SELECT * FROM students WHERE nim = ?', [nim]);
  if (!r[0] || !(await bcrypt.compare(String(password || ''), r[0].password_hash))) {
    return res.status(401).json({ error: 'NIM atau password salah' });
  }
  req.session.studentId = r[0].id;
  res.json({ id: r[0].id, nim: r[0].nim, nama: r[0].nama });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  const [r] = await pool.query('SELECT id, nim, nama FROM students WHERE id = ?', [req.session.studentId]);
  res.json(r[0]);
}));

app.post('/api/logout', wrap(async (req, res) => {
  req.session.destroy(() => res.json({ status: 'bye' }));
}));

app.get('/api/exams', auth, wrap(async (req, res) => {
  const [r] = await pool.query('SELECT id, judul, durasi_menit FROM exams');
  res.json(r);
}));

app.get('/api/exams/:id/questions', auth, wrap(async (req, res) => {
  const [r] = await pool.query(
    'SELECT id, teks, opsi_a, opsi_b, opsi_c, opsi_d FROM questions WHERE exam_id = ? ORDER BY id', [req.params.id]);
  res.json(r);
}));

app.post('/api/sessions/start', auth, wrap(async (req, res) => {
  const examId = +(req.body || {}).exam_id;
  await pool.query('INSERT IGNORE INTO exam_sessions (student_id, exam_id) VALUES (?, ?)', [req.session.studentId, examId]);
  const [r] = await pool.query('SELECT id FROM exam_sessions WHERE student_id = ? AND exam_id = ?', [req.session.studentId, examId]);
  if (!r[0]) return res.status(404).json({ error: 'ujian tidak ditemukan' });
  res.json({ session_id: r[0].id });
}));

app.get('/api/sessions/:id', auth, wrap(async (req, res) => {
  const s = await ownSession(req.params.id, req.session.studentId);
  if (!s) return res.status(404).json({ error: 'sesi tidak ditemukan' });
  const [a] = await pool.query('SELECT question_id, pilihan FROM answers WHERE session_id = ?', [s.id]);
  const answers = {};
  a.forEach((x) => { answers[x.question_id] = x.pilihan; });
  res.json({
    session: { id: s.id, exam_id: s.exam_id, status: s.status, sisa_detik: Math.max(0, s.sisa) },
    answers,
  });
}));

// Autosave: satu jawaban per request, UPSERT (aman untuk retry), langsung commit ke MySQL.
app.put('/api/sessions/:id/answers', auth, wrap(async (req, res) => {
  const s = await ownSession(req.params.id, req.session.studentId);
  if (!s) return res.status(404).json({ error: 'sesi tidak ditemukan' });
  if (s.status !== 'ongoing' || s.sisa <= 0) return res.status(403).json({ error: 'ujian sudah berakhir' });
  const { question_id, pilihan } = req.body || {};
  if (!/^[A-D]$/.test(pilihan)) return res.status(400).json({ error: 'pilihan tidak valid' });
  const [q] = await pool.query('SELECT id FROM questions WHERE id = ? AND exam_id = ?', [question_id, s.exam_id]);
  if (!q[0]) return res.status(404).json({ error: 'soal tidak ditemukan' });
  await pool.query(
    `INSERT INTO answers (session_id, question_id, pilihan) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE pilihan = VALUES(pilihan), saved_at = CURRENT_TIMESTAMP(3)`,
    [s.id, q[0].id, pilihan]);
  res.json({ status: 'saved', question_id: q[0].id, saved_at: new Date().toISOString() });
}));

app.post('/api/sessions/:id/finish', auth, wrap(async (req, res) => {
  const s = await ownSession(req.params.id, req.session.studentId);
  if (!s) return res.status(404).json({ error: 'sesi tidak ditemukan' });
  await pool.query("UPDATE exam_sessions SET status = 'finished', finished_at = NOW() WHERE id = ? AND status = 'ongoing'", [s.id]);
  const [[b]] = await pool.query(
    'SELECT COUNT(*) AS benar FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.session_id = ? AND a.pilihan = q.kunci', [s.id]);
  const [[t]] = await pool.query('SELECT COUNT(*) AS total FROM questions WHERE exam_id = ?', [s.exam_id]);
  res.json({ status: 'finished', benar: b.benar, total: t.total });
}));

const PORT = +(process.env.PORT || 3000);
pool.query('SELECT 1')
  .then(() => app.listen(PORT, () => console.log(`CBT Portal berjalan di http://localhost:${PORT}`)))
  .catch((e) => { console.error('Tidak bisa terhubung ke MySQL:', e.message); process.exit(1); });
