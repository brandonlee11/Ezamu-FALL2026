(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const view = $('#view');
  let me = null;
  let tab = 'sessions';

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmt = (ms) => {
    if (ms == null) return '–';
    const t = Math.max(0, Math.round(ms / 1000));
    return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  };
  const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || 'Something went wrong');
      e.status = res.status;
      throw e;
    }
    return data;
  }

  function showError(el, err) {
    el.innerHTML = `<div class="error">${esc(err.message || err)}</div>`;
  }

  /* ---------- nav + router ---------- */

  function renderNav() {
    $('#nav').innerHTML = me
      ? `<a href="#/">Tests</a><a href="#/new">New test</a><span class="muted small">${esc(me.name)}</span><a href="#" id="logout">Sign out</a>`
      : '';
    const lo = $('#logout');
    if (lo)
      lo.onclick = async (e) => {
        e.preventDefault();
        await api('/logout', { method: 'POST', body: {} });
        me = null;
        location.hash = '#login';
        route();
      };
  }

  async function route() {
    const h = location.hash.replace(/^#/, '') || '/';
    if (!me) {
      try {
        me = await api('/me');
      } catch {
        me = null;
      }
    }
    renderNav();
    if (!me) return renderAuth(h === 'signup' ? 'signup' : 'login');
    try {
      let m;
      if (h === '/' || h === 'login' || h === 'signup') return await renderTests();
      if (h === '/new') return renderNew();
      if ((m = /^\/test\/(\d+)$/.exec(h))) return await renderTest(m[1]);
      if ((m = /^\/session\/(\d+)$/.exec(h))) return await renderSession(m[1]);
      location.hash = '#/';
    } catch (err) {
      if (err.status === 401) {
        me = null;
        return renderAuth('login');
      }
      showError(view, err);
    }
  }
  window.addEventListener('hashchange', route);

  /* ---------- auth ---------- */

  function renderAuth(mode) {
    const signup = mode === 'signup';
    view.innerHTML = `
      <div class="narrow" style="margin:30px auto">
        <h1 style="font-size:2.4rem">${signup ? 'Create your account' : 'Welcome back'}</h1>
        <p class="muted">${signup ? 'Run your first test in a few minutes.' : 'Sign in to see your tests and recordings.'}</p>
        <form id="f" class="card">
          <div id="err"></div>
          ${signup ? `<div class="field"><label for="name">Your name</label><input id="name" type="text" autocomplete="name"></div>` : ''}
          <div class="field"><label for="email">Email</label><input id="email" type="email" autocomplete="email" required></div>
          <div class="field"><label for="pw">Password</label><input id="pw" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required>
            ${signup ? '<div class="hint">At least 8 characters.</div>' : ''}</div>
          <button class="btn coral" style="width:100%;justify-content:center">${signup ? 'Create account' : 'Sign in'}</button>
        </form>
        <p class="muted small" style="margin-top:16px">${
          signup
            ? 'Already have an account? <a href="#login">Sign in</a>'
            : 'New here? <a href="#signup">Create an account</a>'
        }</p>
      </div>`;
    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      try {
        me = await api(signup ? '/signup' : '/login', {
          method: 'POST',
          body: { email: $('#email').value, password: $('#pw').value, name: signup ? $('#name').value : undefined },
        });
        location.hash = '#/';
        route();
      } catch (err) {
        showError($('#err'), err);
      }
    };
  }

  /* ---------- tests list ---------- */

  async function renderTests() {
    const tests = await api('/tests');
    const totalDone = tests.reduce((n, t) => n + t.completed, 0);
    view.innerHTML = `
      <div class="row between" style="margin-bottom:22px">
        <h1 style="font-size:2.4rem;margin:0">Your tests</h1>
        <a class="btn coral" href="#/new">+ New test</a>
      </div>
      ${
        tests.length
          ? `<div class="grid three" style="margin-bottom:22px">
              <div class="card stat"><div class="num">${tests.length}</div><div class="lbl">Tests</div></div>
              <div class="card stat"><div class="num">${totalDone}</div><div class="lbl">Completed sessions</div></div>
              <div class="card stat"><div class="num">${tests.reduce((n, t) => n + t.started - t.completed, 0)}</div><div class="lbl">In progress or abandoned</div></div>
            </div>
            <div class="card"><ul class="list">${tests
              .map(
                (t) => `<li class="row between">
                  <div><a href="#/test/${t.id}" style="font-family:var(--serif);font-size:1.2rem;font-weight:600;color:var(--ink);text-decoration:none">${esc(t.title)}</a>
                    <div class="muted small">${esc(t.url)} · created ${when(t.created_at)}</div></div>
                  <div><span class="pill ${t.completed ? 'complete' : ''}">${t.completed} completed</span></div>
                </li>`
              )
              .join('')}</ul></div>`
          : `<div class="empty"><h3>No tests yet</h3><p>Set up your first test, share the link, and the recordings will appear here.</p><a class="btn coral" href="#/new">Create a test</a></div>`
      }`;
  }

  /* ---------- new test ---------- */

  function renderNew() {
    view.innerHTML = `
      <a href="#/" class="muted small">← All tests</a>
      <h1 style="font-size:2.4rem;margin-top:8px">New test</h1>
      <form id="f" class="grid" style="max-width:760px">
        <div id="err"></div>
        <div class="card">
          <div class="field"><label for="title">Test title</label><input id="title" type="text" placeholder="Checkout flow, round 1" required></div>
          <div class="field"><label for="url">Website or prototype address</label><input id="url" type="text" placeholder="https://example.com" required>
            <div class="hint">Testers will be asked to open this in a new tab and keep sharing their screen.</div></div>
          <div class="field" style="margin:0"><label for="intro">Welcome message <span class="muted">(optional)</span></label>
            <textarea id="intro" placeholder="Thanks for helping us out. There are no wrong answers — we're testing the site, not you."></textarea></div>
        </div>
        <div class="card">
          <h3>Tasks</h3>
          <p class="muted small">What should people try to do? Phrase these as goals, not instructions.</p>
          <div id="tasks"></div>
          <button type="button" class="btn ghost small" id="addTask">+ Add task</button>
        </div>
        <div class="card">
          <h3>Questions after the tasks</h3>
          <p class="muted small">Shown once they finish. Ratings run from 1 to 5.</p>
          <div id="qs"></div>
          <button type="button" class="btn ghost small" id="addQ">+ Add question</button>
        </div>
        <div><button class="btn coral big">Create test</button></div>
      </form>`;

    const addTask = (v = '') => {
      const d = document.createElement('div');
      d.className = 'row';
      d.style.cssText = 'margin-bottom:8px;flex-wrap:nowrap';
      d.innerHTML = `<input type="text" class="task-in" placeholder="e.g. Find the pricing page and choose a plan" value="${esc(v)}">
        <button type="button" class="btn ghost small rm">Remove</button>`;
      d.querySelector('.rm').onclick = () => d.remove();
      $('#tasks').appendChild(d);
    };
    const addQ = (v = '', kind = 'text') => {
      const d = document.createElement('div');
      d.className = 'row';
      d.style.cssText = 'margin-bottom:8px;flex-wrap:nowrap';
      d.innerHTML = `<input type="text" class="q-in" placeholder="Ask something" value="${esc(v)}">
        <select class="q-kind" style="width:130px"><option value="text"${kind === 'text' ? ' selected' : ''}>Open answer</option><option value="rating"${kind === 'rating' ? ' selected' : ''}>Rating 1–5</option></select>
        <button type="button" class="btn ghost small rm">Remove</button>`;
      d.querySelector('.rm').onclick = () => d.remove();
      $('#qs').appendChild(d);
    };
    addTask();
    addTask();
    addQ('How easy was it to complete these tasks?', 'rating');
    addQ('What was the most confusing or frustrating part?', 'text');
    $('#addTask').onclick = () => addTask();
    $('#addQ').onclick = () => addQ();

    $('#f').onsubmit = async (e) => {
      e.preventDefault();
      const tasks = $$('.task-in').map((i) => i.value.trim()).filter(Boolean);
      if (!tasks.length) return showError($('#err'), new Error('Add at least one task for testers to try.'));
      const questions = $$('#qs .row')
        .map((r) => ({ prompt: $('.q-in', r).value.trim(), kind: $('.q-kind', r).value }))
        .filter((q) => q.prompt);
      try {
        const t = await api('/tests', {
          method: 'POST',
          body: { title: $('#title').value, url: $('#url').value, intro: $('#intro').value, tasks, questions },
        });
        tab = 'sessions';
        location.hash = '#/test/' + t.id;
      } catch (err) {
        showError($('#err'), err);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    };
  }

  /* ---------- test detail ---------- */

  async function renderTest(id) {
    const t = await api('/tests/' + id);
    const link = `${location.origin}/t/${t.slug}`;
    view.innerHTML = `
      <a href="#/" class="muted small">← All tests</a>
      <div class="row between" style="margin:8px 0 22px">
        <div><h1 style="font-size:2.3rem;margin:0">${esc(t.title)}</h1><div class="muted">${esc(t.url)}</div></div>
        ${
          t.sessions.length
            ? `<div class="row" style="gap:8px">
                <a class="btn small" href="/api/tests/${t.id}/export.xlsx?tz=${new Date().getTimezoneOffset()}" download title="Summary, sessions, task results, answers and notes, one tab each">⬇ Excel report</a>
                <a class="btn ghost small" href="/api/tests/${t.id}/export.csv?tz=${new Date().getTimezoneOffset()}" download title="One row per tester">⬇ CSV</a>
              </div>`
            : ''
        }
      </div>
      <div class="card" style="margin-bottom:24px">
        <label>Share this link with your testers</label>
        <div class="link-row"><input type="text" readonly value="${esc(link)}" id="link"><button class="btn" id="copy">Copy link</button></div>
        <div class="hint">Anyone with the link can take the test. They don't need an account.</div>
      </div>
      <div class="tabs">
        <button data-t="sessions">Sessions (${t.sessions.length})</button>
        <button data-t="summary">Summary</button>
        <button data-t="setup">Setup</button>
      </div>
      <div id="pane"></div>`;
    $('#copy').onclick = async () => {
      try {
        await navigator.clipboard.writeText(link);
      } catch {
        $('#link').select();
        document.execCommand('copy');
      }
      $('#copy').textContent = 'Copied ✓';
      setTimeout(() => ($('#copy').textContent = 'Copy link'), 1600);
    };
    const show = async (name) => {
      tab = name;
      $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === name));
      const pane = $('#pane');
      try {
        if (name === 'sessions') paneSessions(pane, t);
        else if (name === 'summary') await paneSummary(pane, t);
        else paneSetup(pane, t);
      } catch (err) {
        showError(pane, err);
      }
    };
    $$('.tabs button').forEach((b) => (b.onclick = () => show(b.dataset.t)));
    show(tab);
  }

  function paneSessions(pane, t) {
    if (!t.sessions.length) {
      pane.innerHTML = `<div class="empty"><h3>Waiting for your first tester</h3><p>Share the link above. Recordings show up here as soon as someone starts.</p></div>`;
      return;
    }
    pane.innerHTML = `<div class="card"><ul class="list">${t.sessions
      .map(
        (s) => `<li class="row between">
          <div><a href="#/session/${s.id}" style="font-weight:700;color:var(--ink)">${esc(s.tester_name || 'Anonymous tester')}</a>
            <div class="muted small">${when(s.started_at)}${s.duration_ms ? ' · ' + fmt(s.duration_ms) : ''}</div></div>
          <div class="row"><span class="pill ${s.status}">${s.status === 'complete' ? 'Complete' : 'Not finished'}</span>
            ${s.has_video ? `<a class="btn small" href="#/session/${s.id}">Watch</a>` : ''}</div>
        </li>`
      )
      .join('')}</ul></div>`;
  }

  async function paneSummary(pane, t) {
    const s = await api(`/tests/${t.id}/summary`);
    if (!s.completed_sessions) {
      pane.innerHTML = `<div class="empty"><h3>Nothing to summarise yet</h3><p>The summary appears once at least one tester has finished.</p></div>`;
      return;
    }
    const tagLabel = { problem: 'Problems', insight: 'Insights', positive: 'Positives', note: 'Notes' };
    pane.innerHTML = `
      <div class="grid three" style="margin-bottom:20px">
        <div class="card stat"><div class="num">${s.completed_sessions}</div><div class="lbl">Completed sessions</div></div>
        <div class="card stat"><div class="num">${fmt(s.avg_duration_ms)}</div><div class="lbl">Average session length</div></div>
        <div class="card stat"><div class="num">${s.tags.reduce((n, x) => n + x.n, 0)}</div><div class="lbl">Notes across sessions
          ${s.tags.length ? '<br>' + s.tags.map((x) => `${tagLabel[x.tag] || x.tag}: ${x.n}`).join(' · ') : ''}</div></div>
      </div>
      <div class="card"><h3>Task results</h3>
        ${s.tasks
          .map((k) => {
            const pct = k.attempts ? Math.round((k.completed / k.attempts) * 100) : 0;
            return `<div style="margin:16px 0"><div class="row between"><strong>${esc(k.prompt)}</strong><span class="muted small">${k.completed} of ${k.attempts} completed${k.avg_ms ? ' · avg ' + fmt(k.avg_ms) : ''}</span></div>
              <div class="bar" style="margin-top:8px"><i style="width:${pct}%"></i></div></div>`;
          })
          .join('')}
      </div>
      ${s.questions
        .map(
          (q) => `<div class="card"><h3>${esc(q.prompt)}</h3>${
            q.kind === 'rating'
              ? q.average != null
                ? `<div class="stat" style="padding:0"><span class="num">${q.average}</span> <span class="muted">/ 5 from ${q.count} ${q.count === 1 ? 'tester' : 'testers'}</span></div>`
                : '<p class="muted">No ratings yet.</p>'
              : q.answers.length
              ? `<ul class="list">${q.answers.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`
              : '<p class="muted">No answers yet.</p>'
          }</div>`
        )
        .join('')}`;
  }

  function paneSetup(pane, t) {
    pane.innerHTML = `
      <div class="card"><h3>Welcome message</h3><p class="muted" style="margin:0">${esc(t.intro) || 'None'}</p></div>
      <div class="card"><h3>Tasks</h3><ol>${t.tasks.map((k) => `<li>${esc(k.prompt)}</li>`).join('')}</ol></div>
      <div class="card"><h3>Follow-up questions</h3>${
        t.questions.length
          ? `<ul>${t.questions.map((q) => `<li>${esc(q.prompt)} <span class="pill">${q.kind === 'rating' ? 'rating' : 'open'}</span></li>`).join('')}</ul>`
          : '<p class="muted" style="margin:0">None</p>'
      }</div>
      <div style="margin-top:22px"><button class="btn danger" id="del">Delete this test and its recordings</button></div>`;
    $('#del').onclick = async () => {
      if (!confirm('Delete this test, all its sessions and all recordings? This cannot be undone.')) return;
      await api('/tests/' + t.id, { method: 'DELETE' });
      location.hash = '#/';
    };
  }

  /* ---------- session review ---------- */

  async function renderSession(id) {
    const s = await api('/sessions/' + id);
    let tag = 'note';
    const tagLabel = { note: 'Note', problem: 'Problem', insight: 'Insight', positive: 'Positive' };

    view.innerHTML = `
      <a href="#/test/${s.test.id}" class="muted small">← ${esc(s.test.title)}</a>
      <div class="row between" style="margin:8px 0 20px">
        <div><h1 style="font-size:2rem;margin:0">${esc(s.tester_name || 'Anonymous tester')}</h1>
          <div class="muted small">${when(s.started_at)}${s.duration_ms ? ' · ' + fmt(s.duration_ms) : ''} · <span class="pill ${s.status}">${s.status === 'complete' ? 'Complete' : 'Not finished'}</span></div></div>
        <button class="btn danger small" id="delSession">Delete session</button>
      </div>
      <div class="review">
        <div>
          ${
            s.has_video
              ? `<div class="player"><video id="vid" controls preload="metadata" src="/api/sessions/${s.id}/video"></video></div>
                 <div class="markers" id="markers" title="Click a marker to jump there"></div>
                 <div class="card" style="margin-top:18px">
                   <h3>Recording</h3>
                   <div class="row" style="gap:12px">
                     <a class="btn small" href="/api/sessions/${s.id}/video?download=1" download="${esc(s.video_filename)}">⬇ Download video</a>
                     <span class="muted small">${esc(s.video_filename)} · ${(s.video_bytes / 1048576).toFixed(1)} MB</span>
                   </div>
                   <div class="field" style="margin:18px 0 0">
                     <label for="vurl">Shared drive link <span class="label-optional">(optional)</span></label>
                     <div class="link-row"><input id="vurl" type="url" placeholder="https://drive.google.com/…" value="${esc(s.video_url)}"><button class="btn" id="saveUrl" type="button">Save link</button></div>
                     <div class="hint">Upload the downloaded video to your team's shared drive, then paste its link here. It appears as a clickable link in this session's row of the Excel report and CSV.</div>
                     <div class="hint" id="urlMsg" aria-live="polite"></div>
                   </div>
                 </div>`
              : '<div class="empty">No recording was saved for this session.</div>'
          }
          <div class="card" style="margin-top:18px"><h3>Tasks</h3>
            ${
              s.results.length
                ? `<ul class="list">${s.results
                    .map(
                      (r) => `<li class="task-row">
                        <div class="task-info">
                          <div>${esc(r.prompt)}</div>
                          <div class="muted small">Started at ${fmt(r.started_ms)} · ended at ${fmt(r.ended_ms)} · took ${fmt(r.ended_ms - r.started_ms)}</div>
                        </div>
                        <div class="task-actions">
                          <span class="pill ${r.outcome}">${r.outcome === 'done' ? 'Completed' : 'Skipped'}</span>
                          <button class="btn ghost small seek" data-ms="${r.started_ms}" title="Jump to the moment the tester began this task">▶ Task start (${fmt(r.started_ms)})</button>
                          <button class="btn ghost small seek" data-ms="${r.ended_ms}" title="Jump to the moment the tester finished this task">Task end (${fmt(r.ended_ms)})</button>
                        </div></li>`
                    )
                    .join('')}</ul>`
                : '<p class="muted" style="margin:0">No task results were recorded.</p>'
            }
          </div>
          ${
            s.answers.length
              ? `<div class="card"><h3>Answers</h3><ul class="list">${s.answers
                  .map(
                    (a) => `<li><div class="muted small">${esc(a.prompt)}</div><div>${a.kind === 'rating' ? `<strong>${esc(a.answer)}</strong> / 5` : esc(a.answer)}</div></li>`
                  )
                  .join('')}</ul></div>`
              : ''
          }
        </div>
        <div class="card">
          <h3>Notes</h3>
          <form id="nf">
            <textarea id="nbody" placeholder="What happened here?" style="min-height:70px"></textarea>
            <div class="tagpick">${Object.keys(tagLabel)
              .map((k) => `<button type="button" data-tag="${k}" class="${k === 'note' ? 'on' : ''}">${tagLabel[k]}</button>`)
              .join('')}</div>
            <button class="btn small coral" id="addNote">Add note at <span id="nowTs">0:00</span></button>
          </form>
          <div id="notes" style="margin-top:14px"></div>
        </div>
      </div>`;

    const vid = $('#vid');
    let notes = s.notes.slice();
    const total = () => s.duration_ms || (vid && isFinite(vid.duration) ? vid.duration * 1000 : 0) || Math.max(1, ...notes.map((n) => n.ms), ...s.results.map((r) => r.ended_ms));
    const seek = (ms) => {
      if (!vid) return;
      vid.currentTime = ms / 1000;
      vid.play().catch(() => {});
      vid.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    function drawMarkers() {
      const box = $('#markers');
      if (!box) return;
      const T = total();
      const pts = [
        ...s.results.map((r) => ({ ms: r.started_ms, cls: 'task', title: 'Task started: ' + r.prompt })),
        ...notes.map((n) => ({ ms: n.ms, cls: n.tag, title: fmt(n.ms) + ' ' + n.body })),
      ];
      box.innerHTML = pts
        .map((p) => `<span class="m ${p.cls}" style="left:${Math.min(100, (p.ms / T) * 100)}%" data-ms="${p.ms}" title="${esc(p.title)}"></span>`)
        .join('');
    }

    function drawNotes() {
      $('#notes').innerHTML = notes.length
        ? notes
            .map(
              (n) => `<div class="note"><button class="ts" data-ms="${n.ms}">${fmt(n.ms)}</button>
                <div class="body"><span class="pill ${n.tag}">${esc(n.tag)}</span> ${esc(n.body)}</div>
                <button class="x" data-del="${n.id}" title="Delete note">×</button></div>`
            )
            .join('')
        : '<p class="muted small" style="margin:0">No notes yet. Pause the video and add one.</p>';
      drawMarkers();
    }
    drawNotes();

    if (vid) {
      // MediaRecorder files often report an infinite duration until the end is reached.
      vid.addEventListener('loadedmetadata', () => {
        if (vid.duration === Infinity) {
          vid.currentTime = 1e101;
          vid.addEventListener('timeupdate', function fix() {
            vid.removeEventListener('timeupdate', fix);
            vid.currentTime = 0;
            drawMarkers();
          });
        } else drawMarkers();
      });
      vid.addEventListener('timeupdate', () => ($('#nowTs').textContent = fmt(vid.currentTime * 1000)));
    }

    view.onclick = async (e) => {
      const t = e.target;
      if (t.dataset && t.dataset.ms != null && (t.classList.contains('ts') || t.classList.contains('m') || t.classList.contains('seek')))
        return seek(Number(t.dataset.ms));
      if (t.dataset && t.dataset.tag) {
        tag = t.dataset.tag;
        $$('.tagpick button').forEach((b) => b.classList.toggle('on', b === t));
      }
      if (t.dataset && t.dataset.del) {
        await api('/notes/' + t.dataset.del, { method: 'DELETE' });
        notes = notes.filter((n) => n.id !== Number(t.dataset.del));
        drawNotes();
      }
    };

    $('#nf').onsubmit = async (e) => {
      e.preventDefault();
      const body = $('#nbody').value.trim();
      if (!body) return;
      const ms = vid ? Math.round(vid.currentTime * 1000) : 0;
      const n = await api(`/sessions/${s.id}/notes`, { method: 'POST', body: { body, tag, ms } });
      notes.push(n);
      notes.sort((a, b) => a.ms - b.ms || a.id - b.id);
      $('#nbody').value = '';
      drawNotes();
    };

    const saveUrl = $('#saveUrl');
    if (saveUrl)
      saveUrl.onclick = async () => {
        const msg = $('#urlMsg');
        try {
          const r = await api(`/sessions/${s.id}/link`, { method: 'PUT', body: { url: $('#vurl').value } });
          $('#vurl').value = r.video_url;
          msg.style.color = 'var(--green)';
          msg.textContent = r.video_url ? 'Saved ✓' : 'Link removed.';
        } catch (err) {
          msg.style.color = '#a3261a';
          msg.textContent = err.message;
        }
      };

    $('#delSession').onclick = async () => {
      if (!confirm('Delete this session and its recording?')) return;
      await api('/sessions/' + s.id, { method: 'DELETE' });
      location.hash = '#/test/' + s.test.id;
    };
  }

  route();
})();
