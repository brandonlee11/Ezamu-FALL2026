(() => {
  const slug = location.pathname.split('/').filter(Boolean)[1];
  const stage = document.getElementById('stage');
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmt = (ms) => {
    const t = Math.max(0, Math.round(ms / 1000));
    return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  };

  let test = null;
  let token = null;
  let recorder = null;
  let displayStream = null;
  let micStream = null;
  let t0 = 0;
  let idx = 0;
  let taskStart = 0;
  let results = [];
  let chunkNo = 0;
  let queue = Promise.resolve();
  let uploadFailed = false;
  let finishing = false;
  let durationMs = 0;
  let dock = null;
  let pipWin = null;
  let clockTimer = null;

  const elapsed = () => Math.round(performance.now() - t0);

  /* ---------- load ---------- */

  async function load() {
    try {
      const res = await fetch(`/api/public/${encodeURIComponent(slug)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'This test link is not valid');
      test = data;
      document.title = `${test.title} — Aloud`;
      renderWelcome();
    } catch (err) {
      stage.innerHTML = `<h1>Link not found</h1><p class="muted">${esc(err.message)}. Please check with whoever sent it to you.</p>`;
    }
  }

  /* ---------- welcome ---------- */

  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.MediaRecorder);
  }

  function renderWelcome(errorMsg) {
    const n = test.tasks.length;
    stage.innerHTML = `
      <h1 style="font-size:2.4rem">${esc(test.title)}</h1>
      <p class="muted" style="font-size:1.1rem">${esc(test.intro) || "Thanks for helping out. We're testing a website, not you, so there are no wrong answers."}</p>
      ${
        supported()
          ? ''
          : `<div class="error">This browser can't record your screen. Please open this link on a desktop or laptop using Chrome, Edge, Firefox or Safari.</div>`
      }
      ${errorMsg ? `<div class="error">${esc(errorMsg)}</div>` : ''}
      <div class="card" style="margin:22px 0">
        <h3>What to expect</h3>
        <ul class="checks" style="margin:0">
          <li>You'll share your screen and your microphone. We record both.</li>
          <li>You'll try ${n} short ${n === 1 ? 'task' : 'tasks'}. <strong>Please talk out loud</strong> about what you're looking at, what you expect and anything that confuses you.</li>
          <li>It takes roughly ${Math.max(5, n * 3 + 2)} minutes.</li>
          <li>When sharing, choose <strong>Entire screen</strong> so we can follow you between tabs.</li>
        </ul>
      </div>
      <div class="field"><label for="nm">Your first name <span class="label-optional">(optional)</span></label><input id="nm" type="text" maxlength="60" autocomplete="given-name"></div>
      <label class="consent">
        <input type="checkbox" id="consent">
        <span>I agree to my screen and voice being recorded for this research, and that the people running it can watch the recording.</span>
      </label>
      <button class="btn coral big" id="start" disabled>Start recording</button>`;
    const cb = document.getElementById('consent');
    const btn = document.getElementById('start');
    cb.onchange = () => (btn.disabled = !cb.checked || !supported());
    btn.onclick = start;
  }

  /* ---------- recording ---------- */

  function pickMime() {
    const options = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    return options.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  }

  function stopTracks(...streams) {
    streams.forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
  }

  async function start() {
    const name = document.getElementById('nm').value.trim();
    const btn = document.getElementById('start');
    btn.disabled = true;
    btn.textContent = 'Starting…';

    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    } catch {
      return renderWelcome('Screen sharing was cancelled. Press Start again and choose a screen to share.');
    }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      stopTracks(displayStream);
      return renderWelcome("We couldn't reach your microphone. Allow microphone access in your browser, then press Start again.");
    }

    const mime = pickMime();
    try {
      const res = await fetch(`/api/public/${encodeURIComponent(slug)}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mime }),
      });
      if (!res.ok) throw new Error();
      token = (await res.json()).token;
    } catch {
      stopTracks(displayStream, micStream);
      return renderWelcome("We couldn't start your session. Please check your connection and try again.");
    }

    const stream = new MediaStream([...displayStream.getVideoTracks(), ...micStream.getAudioTracks()]);
    const opts = { videoBitsPerSecond: 1500000 };
    if (mime) opts.mimeType = mime;
    recorder = new MediaRecorder(stream, opts);
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) enqueue(e.data);
    };
    t0 = performance.now();
    recorder.onstart = () => (t0 = performance.now());
    recorder.start(4000);

    displayStream.getVideoTracks()[0].addEventListener('ended', () => {
      if (!finishing) endTasks(true);
    });
    window.addEventListener('beforeunload', warnBeforeLeaving);

    idx = 0;
    taskStart = 0;
    results = [];
    renderStage();
  }

  function warnBeforeLeaving(e) {
    e.preventDefault();
    e.returnValue = '';
  }

  /* chunks are uploaded one at a time, in order, and retried if the network blips */

  function enqueue(blob) {
    const n = chunkNo++;
    queue = queue.then(() => uploadChunk(blob, n));
  }

  async function uploadChunk(blob, n) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(`/api/public/sessions/${token}/chunk?i=${n}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: blob,
        });
        if (res.ok) return;
        if (res.status === 409 || res.status === 404) break;
      } catch {
        /* retry below */
      }
      await sleep(900 * (attempt + 1));
    }
    uploadFailed = true;
  }

  /* ---------- tasks ---------- */

  function renderStage() {
    stage.innerHTML = `
      <h1 style="font-size:2.2rem">You're being recorded</h1>
      <p class="muted" style="font-size:1.05rem">Your task panel is at the bottom of this window. Open the website, work through the tasks, and keep talking out loud.</p>
      <div class="card" style="margin:20px 0">
        <ol style="margin:0;padding-left:20px">
          <li style="margin-bottom:10px"><a class="btn coral" href="${esc(test.url)}" target="_blank" rel="noopener">Open the website ↗</a></li>
          <li style="margin-bottom:10px">Come back to this tab to read your next task, or pop the panel out so it floats above the site.
            ${'documentPictureInPicture' in window ? '<div style="margin-top:8px"><button class="btn ghost small" id="pop">Pop out task panel</button></div>' : '<div class="hint">Tip: place this window and the website side by side.</div>'}</li>
          <li>Press <strong>I've finished this</strong> when you're done with a task, or <strong>I can't do this</strong> if you're stuck.</li>
        </ol>
      </div>`;
    const pop = document.getElementById('pop');
    if (pop) pop.onclick = popOut;
    buildDock();
    clockTimer = setInterval(() => {
      const c = dock && dock.querySelector('[data-clock]');
      if (c) c.textContent = fmt(elapsed());
    }, 500);
  }

  function buildDock() {
    dock = document.createElement('div');
    dock.className = 'dock';
    dock.innerHTML = `
      <div class="meta"><span class="rec"><i></i>Recording</span><span data-clock>0:00</span></div>
      <div class="task" data-task></div>
      <div class="row" style="justify-content:space-between;flex-wrap:nowrap">
        <span class="meta" data-count></span>
        <div class="row" style="gap:8px;flex-wrap:nowrap">
          <button class="btn ghost small" data-skip>I can't do this</button>
          <button class="btn coral small" data-done>I've finished this</button>
        </div>
      </div>`;
    dock.querySelector('[data-done]').onclick = () => completeTask('done');
    dock.querySelector('[data-skip]').onclick = () => completeTask('skipped');
    document.body.appendChild(dock);
    paintDock();
  }

  function paintDock() {
    if (!dock) return;
    const t = test.tasks[idx];
    dock.querySelector('[data-task]').textContent = t ? t.prompt : '';
    dock.querySelector('[data-count]').textContent = `Task ${Math.min(idx + 1, test.tasks.length)} of ${test.tasks.length}`;
  }

  function completeTask(outcome) {
    const t = test.tasks[idx];
    if (!t) return;
    results.push({ task_id: t.id, outcome, started_ms: taskStart, ended_ms: elapsed() });
    idx++;
    taskStart = elapsed();
    if (idx >= test.tasks.length) endTasks(false);
    else paintDock();
  }

  async function popOut() {
    try {
      pipWin = await window.documentPictureInPicture.requestWindow({ width: 440, height: 230 });
      [...document.styleSheets].forEach((ss) => {
        try {
          const st = document.createElement('style');
          st.textContent = [...ss.cssRules].map((r) => r.cssText).join('\n');
          pipWin.document.head.appendChild(st);
        } catch {
          if (ss.href) {
            const l = document.createElement('link');
            l.rel = 'stylesheet';
            l.href = ss.href;
            pipWin.document.head.appendChild(l);
          }
        }
      });
      pipWin.document.body.style.cssText = 'margin:0;background:#1b1a17';
      dock.classList.add('pip');
      pipWin.document.body.appendChild(dock);
      pipWin.addEventListener('pagehide', () => {
        if (finishing || !dock) return;
        dock.classList.remove('pip');
        document.body.appendChild(dock);
        pipWin = null;
      });
    } catch {
      /* pop-out is a nicety; the docked panel still works */
    }
  }

  async function endTasks(early) {
    if (finishing) return;
    finishing = true;
    if (early) {
      const now = elapsed();
      for (let i = idx; i < test.tasks.length; i++)
        results.push({ task_id: test.tasks[i].id, outcome: 'skipped', started_ms: i === idx ? taskStart : now, ended_ms: now });
      idx = test.tasks.length;
    }
    durationMs = elapsed();
    clearInterval(clockTimer);
    if (dock) dock.remove();
    dock = null;
    if (pipWin) {
      try {
        pipWin.close();
      } catch {
        /* already closed */
      }
      pipWin = null;
    }

    stage.innerHTML = `<h1 style="font-size:2.2rem">Saving your recording…</h1><p class="muted">Please keep this tab open for a moment.</p>`;
    await new Promise((resolve) => {
      if (!recorder || recorder.state === 'inactive') return resolve();
      recorder.addEventListener('stop', resolve, { once: true });
      recorder.stop();
    });
    stopTracks(displayStream, micStream);
    await queue;
    window.removeEventListener('beforeunload', warnBeforeLeaving);

    if (test.questions.length) renderQuestions();
    else submit([]);
  }

  /* ---------- questions + finish ---------- */

  function renderQuestions() {
    stage.innerHTML = `
      <h1 style="font-size:2.2rem">A few quick questions</h1>
      <p class="muted">Screen sharing has stopped. Just answer in your own words.</p>
      ${uploadFailed ? '<div class="error">Part of your recording may not have uploaded because of a connection problem. Your answers will still be sent.</div>' : ''}
      <form id="qf" style="margin-top:20px">
        ${test.questions
          .map((q) => {
            const input =
              q.kind === 'rating'
                ? `<div class="rating" data-q="${q.id}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-v="${n}">${n}</button>`).join('')}</div>
                   <div class="hint">1 = very hard, 5 = very easy</div>`
                : `<textarea data-q="${q.id}" placeholder="Type your answer"></textarea>`;
            return `<div class="card" style="margin-bottom:14px"><label>${esc(q.prompt)}</label>${input}</div>`;
          })
          .join('')}
        <button class="btn coral big">Send my answers</button>
      </form>`;
    stage.querySelectorAll('.rating').forEach((box) => {
      box.onclick = (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        box.dataset.value = b.dataset.v;
      };
    });
    document.getElementById('qf').onsubmit = (e) => {
      e.preventDefault();
      const answers = [];
      stage.querySelectorAll('[data-q]').forEach((el) => {
        const v = el.tagName === 'TEXTAREA' ? el.value.trim() : el.dataset.value || '';
        if (v) answers.push({ question_id: Number(el.dataset.q), answer: v });
      });
      submit(answers);
    };
  }

  async function submit(answers) {
    stage.innerHTML = `<h1 style="font-size:2.2rem">Sending…</h1>`;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(`/api/public/sessions/${token}/finish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ results, answers, duration_ms: durationMs }),
        });
        if (res.ok) return renderDone();
      } catch {
        /* retry */
      }
      await sleep(1000 * (attempt + 1));
    }
    stage.innerHTML = `<h1 style="font-size:2.2rem">We couldn't send that</h1>
      <p class="muted">Please check your connection and try again.</p>
      <button class="btn coral" id="retry">Try again</button>`;
    document.getElementById('retry').onclick = () => submit(answers);
  }

  function renderDone() {
    stage.innerHTML = `
      <div class="big-check">✓</div>
      <h1 style="font-size:2.4rem">Thank you</h1>
      <p class="muted" style="font-size:1.1rem">Your session was sent. You can close this tab now.</p>`;
  }

  load();
})();
