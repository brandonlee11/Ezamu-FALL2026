const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, VIDEO_DIR } = require('./db');
const { buildXlsx, buildCsv, buildReport, videoFilename } = require('./export');

const PORT = process.env.PORT || 3000;
// Set ALOUD_ALLOW_SIGNUP=false on a public server: after the first account exists, nobody else can register.
const SIGNUP_OPEN = process.env.ALOUD_ALLOW_SIGNUP !== 'false';
const PUBLIC_DIR = path.join(__dirname, 'public');
const COOKIE = 'aloud_auth';
const NOW = () => Date.now();

/* ---------- tiny router (no dependencies) ---------- */

const routes = [];

function route(method, pattern, ...handlers) {
  let opts = {};
  if (handlers[0] && typeof handlers[0] === 'object') opts = handlers.shift();
  const keys = [];
  const re = new RegExp(
    '^' +
      pattern.replace(/:([A-Za-z]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '/?$'
  );
  routes.push({ method, re, keys, handlers, opts });
}
const get = (p, ...h) => route('GET', p, ...h);
const post = (p, ...h) => route('POST', p, ...h);
const put = (p, ...h) => route('PUT', p, ...h);
const del = (p, ...h) => route('DELETE', p, ...h);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function decorate(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.set = (k, v) => {
    if (typeof k === 'object') for (const name in k) res.setHeader(name, k[name]);
    else res.setHeader(k, v);
    return res;
  };
  res.json = (obj) => {
    const body = JSON.stringify(obj);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
  };
  res.sendFile = (file) => {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return res.status(404).json({ error: 'Not found' });
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
      });
      fs.createReadStream(file).pipe(res);
    });
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const e = new Error('Too large');
        e.status = 413;
        req.destroy();
        return reject(e);
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function runChain(handlers, req, res) {
  let i = 0;
  const next = async () => {
    const h = handlers[i++];
    if (h) await h(req, res, next);
  };
  await next();
}

const server = http.createServer(async (req, res) => {
  decorate(res);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    // API routes
    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        req.params = {};
        r.keys.forEach((k, i) => (req.params[k] = m[i + 1]));
        if (r.opts.raw) {
          req.body = await readBody(req, r.opts.raw);
        } else if (req.method === 'GET' || req.method === 'DELETE') {
          req.body = {};
        } else {
          const buf = await readBody(req, 1024 * 1024);
          try {
            req.body = buf.length ? JSON.parse(buf.toString('utf8')) : {};
          } catch {
            return res.status(400).json({ error: 'Invalid JSON' });
          }
        }
        return await runChain(r.handlers, req, res);
      }
      return res.status(404).json({ error: 'Not found' });
    }

    // Pages
    if (req.method === 'GET') {
      if (/^\/t\/[^/]+\/?$/.test(pathname)) return res.sendFile(path.join(PUBLIC_DIR, 'run.html'));
      if (pathname === '/app' || pathname.startsWith('/app/')) return res.sendFile(path.join(PUBLIC_DIR, 'app.html'));
      const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
      const file = path.normalize(path.join(PUBLIC_DIR, rel));
      if (!file.startsWith(PUBLIC_DIR + path.sep)) return res.status(403).end();
      return res.sendFile(file);
    }
    res.status(404).json({ error: 'Not found' });
  } catch (err) {
    if (err.status === 413) return res.status(413).json({ error: 'Upload too large' });
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong' });
    else res.end();
  }
});

/* ---------- helpers ---------- */

const rand = (n = 24) => crypto.randomBytes(n).toString('base64url');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function checkPassword(pw, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function setAuthCookie(req, res, token) {
  // Mark the cookie Secure when the visitor is on HTTPS (directly, or via a proxy that says so).
  const https = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${https ? '; Secure' : ''}`
  );
}

function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function auth(req, res, next) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.name FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    )
    .get(token);
  if (!row) return res.status(401).json({ error: 'Not signed in' });
  req.user = row;
  return next();
}

const clean = (s, max = 500) => String(s ?? '').trim().slice(0, max);

function normalizeUrl(u) {
  let s = clean(u, 500);
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    return new URL(s).toString();
  } catch {
    return '';
  }
}

function ownedTest(req, res) {
  const t = db.prepare('SELECT * FROM tests WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!t) res.status(404).json({ error: 'Test not found' });
  return t;
}

function ownedSession(req, res) {
  const s = db
    .prepare(
      `SELECT s.* FROM sessions s JOIN tests t ON t.id = s.test_id WHERE s.id = ? AND t.user_id = ?`
    )
    .get(Number(req.params.id), req.user.id);
  if (!s) res.status(404).json({ error: 'Session not found' });
  return s;
}

function testDetail(t) {
  const tasks = db.prepare('SELECT id, position, prompt FROM tasks WHERE test_id = ? ORDER BY position').all(t.id);
  const questions = db
    .prepare('SELECT id, position, prompt, kind FROM questions WHERE test_id = ? ORDER BY position')
    .all(t.id);
  return { ...t, tasks, questions };
}

function replaceTasksAndQuestions(testId, tasks, questions) {
  db.prepare('DELETE FROM tasks WHERE test_id = ?').run(testId);
  db.prepare('DELETE FROM questions WHERE test_id = ?').run(testId);
  const addTask = db.prepare('INSERT INTO tasks (test_id, position, prompt) VALUES (?, ?, ?)');
  const addQ = db.prepare('INSERT INTO questions (test_id, position, prompt, kind) VALUES (?, ?, ?, ?)');
  (tasks || [])
    .map((x) => clean(x, 400))
    .filter(Boolean)
    .slice(0, 20)
    .forEach((p, i) => addTask.run(testId, i, p));
  (questions || [])
    .map((q) => (typeof q === 'string' ? { prompt: q, kind: 'text' } : q))
    .filter((q) => clean(q.prompt))
    .slice(0, 20)
    .forEach((q, i) => addQ.run(testId, i, clean(q.prompt, 400), q.kind === 'rating' ? 'rating' : 'text'));
}

/* ---------- auth ---------- */

post('/api/signup', (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const name = clean(req.body.name, 100) || email.split('@')[0];
  const pw = String(req.body.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (pw.length < 8) return res.status(400).json({ error: 'Password needs at least 8 characters' });
  if (!SIGNUP_OPEN && db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0)
    return res.status(403).json({ error: 'Sign-ups are closed on this server.' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'That email already has an account' });
  const info = db
    .prepare('INSERT INTO users (email, name, pw_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(email, name, hashPassword(pw), NOW());
  const token = rand(32);
  db.prepare('INSERT INTO auth_sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(
    token,
    Number(info.lastInsertRowid),
    NOW()
  );
  setAuthCookie(req, res, token);
  res.json({ id: Number(info.lastInsertRowid), email, name });
});

post('/api/login', (req, res) => {
  const email = clean(req.body.email, 200).toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !checkPassword(String(req.body.password || ''), user.pw_hash))
    return res.status(401).json({ error: 'Wrong email or password' });
  const token = rand(32);
  db.prepare('INSERT INTO auth_sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, user.id, NOW());
  setAuthCookie(req, res, token);
  res.json({ id: user.id, email: user.email, name: user.name });
});

post('/api/logout', (req, res) => {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare('DELETE FROM auth_sessions WHERE token = ?').run(token);
  clearAuthCookie(res);
  res.json({ ok: true });
});

get('/api/me', auth, (req, res) => res.json(req.user));

/* ---------- tests (researcher) ---------- */

get('/api/tests', auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT t.id, t.slug, t.title, t.url, t.created_at,
        (SELECT COUNT(*) FROM sessions s WHERE s.test_id = t.id AND s.status = 'complete') AS completed,
        (SELECT COUNT(*) FROM sessions s WHERE s.test_id = t.id) AS started
       FROM tests t WHERE t.user_id = ? ORDER BY t.created_at DESC`
    )
    .all(req.user.id);
  res.json(rows);
});

post('/api/tests', auth, (req, res) => {
  const title = clean(req.body.title, 120);
  const url = normalizeUrl(req.body.url);
  if (!title) return res.status(400).json({ error: 'Give your test a title' });
  if (!url) return res.status(400).json({ error: 'Enter the website address to test' });
  const info = db
    .prepare('INSERT INTO tests (user_id, slug, title, url, intro, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, rand(9), title, url, clean(req.body.intro, 1000), NOW());
  const id = Number(info.lastInsertRowid);
  replaceTasksAndQuestions(id, req.body.tasks, req.body.questions);
  res.json(testDetail(db.prepare('SELECT * FROM tests WHERE id = ?').get(id)));
});

get('/api/tests/:id', auth, (req, res) => {
  const t = ownedTest(req, res);
  if (!t) return;
  const sessions = db
    .prepare(
      `SELECT id, tester_name, status, started_at, finished_at, duration_ms, (video_file IS NOT NULL) AS has_video
       FROM sessions WHERE test_id = ? ORDER BY started_at DESC`
    )
    .all(t.id);
  res.json({ ...testDetail(t), sessions });
});

/* ---------- exports (researcher) ---------- */

function sendDownload(res, filename, type, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function exportName(t, ext) {
  const slug = t.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'test';
  return `aloud-${slug}-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

function exportTz(req) {
  const tz = Number(new URL(req.url, 'http://x').searchParams.get('tz'));
  return Number.isFinite(tz) && Math.abs(tz) <= 900 ? tz : 0;
}

get('/api/tests/:id/export.xlsx', auth, (req, res) => {
  const t = ownedTest(req, res);
  if (!t) return;
  const r = buildReport(db, t, exportTz(req), VIDEO_DIR);
  const book = buildXlsx([
    { name: 'Summary', rows: r.summary, widths: [24, 48, 14, 14, 22, 18, 28] },
    { name: 'Sessions', rows: r.sessionRows, table: true },
    { name: 'Task results', rows: r.taskRows, table: true },
    { name: 'Answers', rows: r.answerRows, table: true },
    { name: 'Notes', rows: r.noteRows, table: true },
  ]);
  sendDownload(res, exportName(t, 'xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', book);
});

get('/api/tests/:id/export.csv', auth, (req, res) => {
  const t = ownedTest(req, res);
  if (!t) return;
  sendDownload(res, exportName(t, 'csv'), 'text/csv; charset=utf-8', buildCsv(buildReport(db, t, exportTz(req), VIDEO_DIR).sessionRows));
});

put('/api/tests/:id', auth, (req, res) => {
  const t = ownedTest(req, res);
  if (!t) return;
  const title = clean(req.body.title, 120) || t.title;
  const url = normalizeUrl(req.body.url) || t.url;
  db.prepare('UPDATE tests SET title = ?, url = ?, intro = ? WHERE id = ?').run(
    title,
    url,
    clean(req.body.intro ?? t.intro, 1000),
    t.id
  );
  if (req.body.tasks || req.body.questions) {
    const hasSessions = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE test_id = ?').get(t.id).n;
    if (hasSessions)
      return res.status(409).json({ error: 'This test already has sessions, so its tasks and questions are locked.' });
    replaceTasksAndQuestions(t.id, req.body.tasks, req.body.questions);
  }
  res.json(testDetail(db.prepare('SELECT * FROM tests WHERE id = ?').get(t.id)));
});

del('/api/tests/:id', auth, (req, res) => {
  const t = ownedTest(req, res);
  if (!t) return;
  const files = db.prepare('SELECT video_file FROM sessions WHERE test_id = ? AND video_file IS NOT NULL').all(t.id);
  db.prepare('DELETE FROM tests WHERE id = ?').run(t.id);
  files.forEach((f) => fs.rm(path.join(VIDEO_DIR, f.video_file), { force: true }, () => {}));
  res.json({ ok: true });
});

/* ---------- review (researcher) ---------- */

get('/api/sessions/:id', auth, (req, res) => {
  const s = ownedSession(req, res);
  if (!s) return;
  const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(s.test_id);
  const results = db
    .prepare(
      `SELECT r.task_id, r.outcome, r.started_ms, r.ended_ms, t.prompt, t.position
       FROM task_results r JOIN tasks t ON t.id = r.task_id WHERE r.session_id = ? ORDER BY t.position`
    )
    .all(s.id);
  const answers = db
    .prepare(
      `SELECT a.question_id, a.answer, q.prompt, q.kind, q.position
       FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.session_id = ? ORDER BY q.position`
    )
    .all(s.id);
  const notes = db.prepare('SELECT * FROM notes WHERE session_id = ? ORDER BY ms, id').all(s.id);
  let videoBytes = 0;
  try {
    if (s.video_file) videoBytes = fs.statSync(path.join(VIDEO_DIR, s.video_file)).size;
  } catch {
    /* file missing: treated as no recording */
  }
  res.json({
    id: s.id,
    test: { id: test.id, title: test.title, url: test.url },
    tester_name: s.tester_name,
    status: s.status,
    started_at: s.started_at,
    duration_ms: s.duration_ms,
    has_video: videoBytes > 0,
    video_bytes: videoBytes,
    video_filename: videoFilename(db, test, s),
    video_url: s.video_url || '',
    results,
    answers,
    notes,
  });
});

get('/api/sessions/:id/video', auth, (req, res) => {
  const s = ownedSession(req, res);
  if (!s) return;
  if (!s.video_file) return res.status(404).end();
  const file = path.join(VIDEO_DIR, s.video_file);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return res.status(404).end();
  }
  if (!stat.size) return res.status(404).end();
  const type = s.mime || 'video/webm';
  if (new URL(req.url, 'http://x').searchParams.has('download')) {
    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(s.test_id);
    const name = videoFilename(db, test, s);
    // A download is always the whole file, so the browser can show real progress.
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    return fs.createReadStream(file).pipe(res);
  }
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (end >= stat.size) end = stat.size - 1;
    if (start > end || start >= stat.size) return res.status(416).set('Content-Range', `bytes */${stat.size}`).end();
    res.status(206).set({
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type,
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.set({ 'Content-Length': stat.size, 'Content-Type': type, 'Accept-Ranges': 'bytes' });
  fs.createReadStream(file).pipe(res);
});

// Where the team keeps this recording (a shared-drive link). It appears in the Excel report and CSV.
put('/api/sessions/:id/link', auth, (req, res) => {
  const s = ownedSession(req, res);
  if (!s) return;
  const raw = String(req.body.url ?? '').trim();
  let url = '';
  if (raw) {
    try {
      const p = new URL(raw);
      if (!/^https?:$/.test(p.protocol) || raw.length > 600) throw new Error('bad');
      url = p.toString();
    } catch {
      return res.status(400).json({ error: 'Enter a full web address starting with http:// or https://' });
    }
  }
  db.prepare('UPDATE sessions SET video_url = ? WHERE id = ?').run(url || null, s.id);
  res.json({ video_url: url });
});

post('/api/sessions/:id/notes', auth, (req, res) => {
  const s = ownedSession(req, res);
  if (!s) return;
  const body = clean(req.body.body, 1000);
  if (!body) return res.status(400).json({ error: 'Write something first' });
  const tag = ['note', 'problem', 'insight', 'positive'].includes(req.body.tag) ? req.body.tag : 'note';
  const ms = Math.max(0, Math.round(Number(req.body.ms) || 0));
  const info = db
    .prepare('INSERT INTO notes (session_id, ms, body, tag, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(s.id, ms, body, tag, NOW());
  res.json(db.prepare('SELECT * FROM notes WHERE id = ?').get(Number(info.lastInsertRowid)));
});

del('/api/notes/:id', auth, (req, res) => {
  const n = db
    .prepare(
      `SELECT n.id FROM notes n JOIN sessions s ON s.id = n.session_id JOIN tests t ON t.id = s.test_id
       WHERE n.id = ? AND t.user_id = ?`
    )
    .get(Number(req.params.id), req.user.id);
  if (!n) return res.status(404).json({ error: 'Note not found' });
  db.prepare('DELETE FROM notes WHERE id = ?').run(n.id);
  res.json({ ok: true });
});

del('/api/sessions/:id', auth, (req, res) => {
  const s = ownedSession(req, res);
  if (!s) return;
  db.prepare('DELETE FROM sessions WHERE id = ?').run(s.id);
  if (s.video_file) fs.rm(path.join(VIDEO_DIR, s.video_file), { force: true }, () => {});
  res.json({ ok: true });
});

get('/api/tests/:id/summary', auth, (req, res) => {
  const t = ownedTest(req, res);
  if (!t) return;
  const done = db.prepare(`SELECT id, duration_ms FROM sessions WHERE test_id = ? AND status = 'complete'`).all(t.id);
  const tasks = db.prepare('SELECT id, prompt, position FROM tasks WHERE test_id = ? ORDER BY position').all(t.id);
  const perTask = tasks.map((task) => {
    const rows = db
      .prepare(
        `SELECT r.outcome, r.started_ms, r.ended_ms FROM task_results r
         JOIN sessions s ON s.id = r.session_id WHERE r.task_id = ? AND s.status = 'complete'`
      )
      .all(task.id);
    const ok = rows.filter((r) => r.outcome === 'done');
    const times = ok.map((r) => r.ended_ms - r.started_ms);
    return {
      id: task.id,
      prompt: task.prompt,
      attempts: rows.length,
      completed: ok.length,
      gave_up: rows.filter((r) => r.outcome === 'skipped').length,
      avg_ms: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    };
  });
  const questions = db.prepare('SELECT id, prompt, kind FROM questions WHERE test_id = ? ORDER BY position').all(t.id);
  const perQuestion = questions.map((q) => {
    const rows = db
      .prepare(
        `SELECT a.answer FROM answers a JOIN sessions s ON s.id = a.session_id
         WHERE a.question_id = ? AND s.status = 'complete'`
      )
      .all(q.id)
      .map((r) => r.answer);
    if (q.kind === 'rating') {
      const nums = rows.map(Number).filter((n) => n >= 1 && n <= 5);
      return {
        ...q,
        average: nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null,
        count: nums.length,
      };
    }
    return { ...q, answers: rows };
  });
  const tagCounts = db
    .prepare(
      `SELECT n.tag, COUNT(*) AS n FROM notes n JOIN sessions s ON s.id = n.session_id
       WHERE s.test_id = ? GROUP BY n.tag`
    )
    .all(t.id);
  const durations = done.map((d) => d.duration_ms).filter(Boolean);
  res.json({
    completed_sessions: done.length,
    avg_duration_ms: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    tasks: perTask,
    questions: perQuestion,
    tags: tagCounts,
  });
});

/* ---------- tester (public, no account) ---------- */

get('/api/public/:slug', (req, res) => {
  const t = db.prepare('SELECT * FROM tests WHERE slug = ?').get(req.params.slug);
  if (!t) return res.status(404).json({ error: 'This test link is not valid' });
  const d = testDetail(t);
  res.json({ slug: d.slug, title: d.title, url: d.url, intro: d.intro, tasks: d.tasks, questions: d.questions });
});

post('/api/public/:slug/sessions', (req, res) => {
  const t = db.prepare('SELECT * FROM tests WHERE slug = ?').get(req.params.slug);
  if (!t) return res.status(404).json({ error: 'This test link is not valid' });
  const token = rand(24);
  const mime = clean(req.body.mime, 80).split(';')[0] || 'video/webm';
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  const file = `${rand(12)}.${ext}`;
  fs.writeFileSync(path.join(VIDEO_DIR, file), Buffer.alloc(0));
  db.prepare(
    `INSERT INTO sessions (test_id, token, tester_name, started_at, video_file, mime, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(t.id, token, clean(req.body.name, 80), NOW(), file, mime, clean(req.headers['user-agent'], 300));
  res.json({ token });
});

function liveSession(req, res) {
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(req.params.token);
  if (!s) {
    res.status(404).json({ error: 'Session not found' });
    return null;
  }
  return s;
}

route('POST', '/api/public/sessions/:token/chunk', { raw: 60 * 1024 * 1024 }, (req, res) => {
  const s = liveSession(req, res);
  if (!s) return;
  if (s.status === 'complete') return res.status(409).json({ error: 'Session already finished' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty chunk' });
  // Chunks carry a sequence number so a retried upload can never be appended twice.
  const rawIdx = new URL(req.url, 'http://x').searchParams.get('i');
  const idx = rawIdx === null || rawIdx === '' ? NaN : Number(rawIdx);
  if (!Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: 'Missing chunk index' });
  if (idx < s.chunks) return res.json({ ok: true, duplicate: true });
  if (idx > s.chunks) return res.status(409).json({ error: 'Out of order', expected: s.chunks });
  fs.appendFile(path.join(VIDEO_DIR, s.video_file), req.body, (err) => {
    if (err) return res.status(500).json({ error: 'Could not save chunk' });
    db.prepare('UPDATE sessions SET chunks = chunks + 1 WHERE id = ?').run(s.id);
    res.json({ ok: true });
  });
});

post('/api/public/sessions/:token/finish', (req, res) => {
  const s = liveSession(req, res);
  if (!s) return;
  if (s.status === 'complete') return res.json({ ok: true });
  const taskIds = new Set(db.prepare('SELECT id FROM tasks WHERE test_id = ?').all(s.test_id).map((r) => r.id));
  const questionIds = new Set(db.prepare('SELECT id FROM questions WHERE test_id = ?').all(s.test_id).map((r) => r.id));
  const addResult = db.prepare(
    'INSERT INTO task_results (session_id, task_id, outcome, started_ms, ended_ms) VALUES (?, ?, ?, ?, ?)'
  );
  const addAnswer = db.prepare('INSERT INTO answers (session_id, question_id, answer) VALUES (?, ?, ?)');
  (Array.isArray(req.body.results) ? req.body.results : []).forEach((r) => {
    if (taskIds.has(Number(r.task_id)))
      addResult.run(
        s.id,
        Number(r.task_id),
        r.outcome === 'done' ? 'done' : 'skipped',
        Math.max(0, Math.round(Number(r.started_ms) || 0)),
        Math.max(0, Math.round(Number(r.ended_ms) || 0))
      );
  });
  (Array.isArray(req.body.answers) ? req.body.answers : []).forEach((a) => {
    if (questionIds.has(Number(a.question_id)) && clean(a.answer))
      addAnswer.run(s.id, Number(a.question_id), clean(a.answer, 2000));
  });
  db.prepare(`UPDATE sessions SET status = 'complete', finished_at = ?, duration_ms = ? WHERE id = ?`).run(
    NOW(),
    Math.max(0, Math.round(Number(req.body.duration_ms) || 0)),
    s.id
  );
  res.json({ ok: true });
});

server.listen(PORT, () => console.log(`Aloud is running on http://localhost:${PORT}`));
