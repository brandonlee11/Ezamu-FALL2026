// Report export: builds an .xlsx workbook or a .csv from a test's results.
// No dependencies: a minimal ZIP writer + SpreadsheetML generator on top of Node's zlib.

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ---------- ZIP (deflate) ---------- */

function zip(files) {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(8, 8); // deflate
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);

    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/* ---------- XLSX ---------- */

// A cell is a plain string/number/null, or { v, s } where s is a style name.
const STYLE = { plain: 0, header: 1, text: 2, num: 3, pct: 4, title: 5, bold: 6, numl: 7, pctl: 8, link: 9 };

const xmlEsc = (s) =>
  String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function sheetXml(rows, { table, widths: fixedWidths }) {
  const norm = (c) => (c !== null && typeof c === 'object' ? c : { v: c });
  const widths = [];
  let maxCols = 0;

  const rowXml = rows
    .map((row, r) => {
      maxCols = Math.max(maxCols, row.length);
      const cells = row
        .map((raw, c) => {
          const cell = norm(raw);
          const v = cell.v;
          if (v === null || v === undefined || v === '') return '';
          const ref = colName(c) + (r + 1);
          let style = cell.s ? STYLE[cell.s] : undefined;
          if (table && r === 0) style = STYLE.header;
          const len = typeof v === 'number' ? String(v).length : Math.max(...String(v).split('\n').map((l) => l.length));
          if (r < 300 && !(cell.s === 'title')) widths[c] = Math.max(widths[c] || 8, Math.min(60, len + 2));
          if (cell.link && !(table && r === 0)) {
            // A clickable link. HYPERLINK() keeps the sheet simple and works in Excel, Sheets and LibreOffice.
            const label = xmlEsc(v);
            return `<c r="${ref}" s="${STYLE.link}" t="str"><f>HYPERLINK("${xmlEsc(cell.link.replace(/"/g, '""'))}","${label}")</f><v>${label}</v></c>`;
          }
          if (typeof v === 'number' && Number.isFinite(v))
            return `<c r="${ref}" s="${style ?? STYLE.num}"><v>${v}</v></c>`;
          return `<c r="${ref}" s="${style ?? STYLE.text}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');

  (fixedWidths || []).forEach((w, i) => (widths[i] = w));
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w || 8}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const pane = table
    ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>'
    : '';
  const filter = table && rows.length > 1 ? `<autoFilter ref="A1:${colName(maxCols - 1)}${rows.length}"/>` : '';

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    cols +
    `<sheetData>${rowXml}</sheetData>` +
    filter +
    '</worksheet>'
  );
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="4">' +
  '<font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="16"/><name val="Calibri"/></font>' +
  '<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/></font>' +
  '</fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFF1E9D6"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="10">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" horizontal="right"/></xf>' +
  '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" horizontal="right"/></xf>' +
  '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top"/></xf>' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" horizontal="left"/></xf>' +
  '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" horizontal="left"/></xf>' +
  '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top"/></xf>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

// sheets: [{ name, rows, table }]
function buildXlsx(sheets) {
  const NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const names = sheets.map((s) => s.name.replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Sheet');
  const files = [
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
          )
          .join('') +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<Relationships xmlns="${NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<Relationships xmlns="${NS}">` +
        sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
          )
          .join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    },
    { name: 'xl/styles.xml', data: STYLES_XML },
    ...sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: sheetXml(s.rows, { table: !!s.table, widths: s.widths }),
    })),
  ];
  return zip(files);
}

/* ---------- CSV ---------- */

function csvCell(c) {
  let v = c !== null && typeof c === 'object' ? c.link || c.v : c;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  v = String(v);
  // Stop spreadsheet apps treating tester-typed text as a formula.
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function buildCsv(rows) {
  // BOM so Excel reads non-English characters correctly.
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/* ---------- report data ---------- */

const mmss = (ms) => {
  if (ms == null) return '';
  const t = Math.max(0, Math.round(ms / 1000));
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
};
const secs = (ms) => (ms == null ? null : Math.round(ms / 100) / 10);
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const slugify = (s, n = 40) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // é → e, so names stay readable
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, n)
    .replace(/-+$/, '');

// The name a recording gets when downloaded, e.g. checkout-round-1-session-2-rita.webm.
// The Sessions tab lists the same name, so a row and its video file are easy to match up.
function videoFilename(db, test, session) {
  const n =
    db
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE test_id = ? AND (started_at < ? OR (started_at = ? AND id < ?))')
      .get(test.id, session.started_at, session.started_at, session.id).n + 1;
  const ext = path.extname(session.video_file || '').slice(1) || 'webm';
  return `${slugify(test.title, 30) || 'test'}-session-${n}-${slugify(session.tester_name, 20) || 'anonymous'}.${ext}`;
}

// tzOffsetMin is the browser's Date#getTimezoneOffset(), so dates match what the researcher sees.
// videoDir lets the report tell which sessions actually have a recording saved.
function buildReport(db, test, tzOffsetMin = 0, videoDir = null) {
  const hasVideo = (s) => {
    try {
      return !!s.video_file && !!videoDir && fs.statSync(path.join(videoDir, s.video_file)).size > 0;
    } catch {
      return false;
    }
  };
  const when = (ms) => (ms ? new Date(ms - tzOffsetMin * 60000).toISOString().slice(0, 16).replace('T', ' ') : '');

  const tasks = db.prepare('SELECT id, prompt FROM tasks WHERE test_id = ? ORDER BY position').all(test.id);
  const questions = db.prepare('SELECT id, prompt, kind FROM questions WHERE test_id = ? ORDER BY position').all(test.id);
  const sessions = db.prepare('SELECT * FROM sessions WHERE test_id = ? ORDER BY started_at, id').all(test.id);
  const results = db
    .prepare(
      `SELECT r.* FROM task_results r JOIN sessions s ON s.id = r.session_id WHERE s.test_id = ?`
    )
    .all(test.id);
  const answers = db
    .prepare(`SELECT a.* FROM answers a JOIN sessions s ON s.id = a.session_id WHERE s.test_id = ?`)
    .all(test.id);
  const notes = db
    .prepare(`SELECT n.* FROM notes n JOIN sessions s ON s.id = n.session_id WHERE s.test_id = ? ORDER BY n.session_id, n.ms`)
    .all(test.id);

  const num = new Map(sessions.map((s, i) => [s.id, i + 1]));
  const who = new Map(sessions.map((s) => [s.id, s.tester_name || 'Anonymous']));
  const done = sessions.filter((s) => s.status === 'complete');
  const doneIds = new Set(done.map((s) => s.id));
  const rByKey = new Map(results.map((r) => [r.session_id + ':' + r.task_id, r]));
  const aByKey = new Map(answers.map((a) => [a.session_id + ':' + a.question_id, a]));

  /* Sessions: one row per tester (this is also the CSV) */
  const head = ['Session #', 'Tester', 'Date', 'Status', 'Duration (sec)', 'Video link', 'Video file name', 'Tasks completed', 'Tasks skipped'];
  tasks.forEach((_, i) => head.push(`Task ${i + 1} outcome`, `Task ${i + 1} time (sec)`));
  questions.forEach((q, i) => head.push(`Q${i + 1}: ${short(q.prompt, 70)}`));
  const sessionRows = [head];
  for (const s of sessions) {
    const mine = results.filter((r) => r.session_id === s.id);
    const row = [
      num.get(s.id),
      who.get(s.id),
      when(s.started_at),
      s.status === 'complete' ? 'Complete' : 'Not finished',
      secs(s.duration_ms),
      // Excel's HYPERLINK() accepts addresses up to 255 characters; anything longer stays plain text.
      s.video_url ? (s.video_url.length <= 255 ? { v: 'Watch recording', link: s.video_url } : s.video_url) : null,
      hasVideo(s) ? videoFilename(db, test, s) : null,
      mine.filter((r) => r.outcome === 'done').length,
      mine.filter((r) => r.outcome !== 'done').length,
    ];
    for (const t of tasks) {
      const r = rByKey.get(s.id + ':' + t.id);
      row.push(r ? (r.outcome === 'done' ? 'Completed' : 'Skipped') : null, r ? secs(r.ended_ms - r.started_ms) : null);
    }
    for (const q of questions) {
      const a = aByKey.get(s.id + ':' + q.id);
      row.push(a ? (q.kind === 'rating' && Number.isFinite(Number(a.answer)) ? Number(a.answer) : a.answer) : null);
    }
    sessionRows.push(row);
  }

  /* Task results: one row per tester per task */
  const taskRows = [['Session #', 'Tester', 'Task #', 'Task', 'Outcome', 'Started (sec into recording)', 'Ended (sec into recording)', 'Time on task (sec)']];
  for (const r of results) {
    const idx = tasks.findIndex((t) => t.id === r.task_id);
    taskRows.push([num.get(r.session_id), who.get(r.session_id), idx + 1, tasks[idx]?.prompt ?? '', r.outcome === 'done' ? 'Completed' : 'Skipped', secs(r.started_ms), secs(r.ended_ms), secs(r.ended_ms - r.started_ms)]);
  }
  taskRows.splice(1, taskRows.length, ...taskRows.slice(1).sort((a, b) => a[0] - b[0] || a[2] - b[2]));

  /* Answers: one row per answer */
  const answerRows = [['Session #', 'Tester', 'Question #', 'Question', 'Type', 'Answer']];
  for (const a of answers) {
    const idx = questions.findIndex((q) => q.id === a.question_id);
    const q = questions[idx];
    answerRows.push([num.get(a.session_id), who.get(a.session_id), idx + 1, q?.prompt ?? '', q?.kind === 'rating' ? 'Rating (1-5)' : 'Open answer', q?.kind === 'rating' && Number.isFinite(Number(a.answer)) ? Number(a.answer) : a.answer]);
  }
  answerRows.splice(1, answerRows.length, ...answerRows.slice(1).sort((a, b) => a[0] - b[0] || a[2] - b[2]));

  /* Notes */
  const tagName = { note: 'Note', problem: 'Problem', insight: 'Insight', positive: 'Positive' };
  const noteRows = [['Session #', 'Tester', 'Timestamp (m:ss)', 'Seconds into recording', 'Tag', 'Note']];
  for (const n of notes) noteRows.push([num.get(n.session_id), who.get(n.session_id), mmss(n.ms), secs(n.ms), tagName[n.tag] || n.tag, n.body]);
  noteRows.splice(1, noteRows.length, ...noteRows.slice(1).sort((a, b) => a[0] - b[0] || a[3] - b[3]));

  /* Summary: the page a project sponsor reads first */
  const durations = done.map((s) => s.duration_ms).filter(Boolean);
  const avgDur = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  const B = (v) => ({ v, s: 'bold' });
  const H = (v) => ({ v, s: 'header' });
  // The Summary is read like a report, so its numbers are left-aligned under their headings.
  const L = (v) => (v === null || v === undefined ? null : { v, s: 'numl' });
  const P = (v) => ({ v, s: 'pctl' });
  const summary = [
    [{ v: test.title, s: 'title' }],
    [],
    [B('Website tested'), test.url],
    [B('Test created'), when(test.created_at)],
    [B('Report generated'), when(Date.now())],
    [B('Sessions started'), L(sessions.length)],
    [B('Sessions completed'), L(done.length)],
    [B('Average session length'), avgDur == null ? '' : mmss(avgDur)],
    [],
    [{ v: 'Task results (completed sessions only)', s: 'title' }],
    [H('Task #'), H('Task'), H('Attempts'), H('Completed'), H('Skipped'), H('Completion rate'), H('Avg time to complete (sec)')],
  ];
  tasks.forEach((t, i) => {
    const rs = results.filter((r) => r.task_id === t.id && doneIds.has(r.session_id));
    const ok = rs.filter((r) => r.outcome === 'done');
    const avg = ok.length ? secs(ok.reduce((a, r) => a + (r.ended_ms - r.started_ms), 0) / ok.length) : null;
    summary.push([L(i + 1), t.prompt, L(rs.length), L(ok.length), L(rs.length - ok.length), rs.length ? P(ok.length / rs.length) : null, L(avg)]);
  });
  if (questions.length) {
    summary.push([], [{ v: 'Follow-up questions (completed sessions only)', s: 'title' }], [H('Q #'), H('Question'), H('Type'), H('Responses'), H('Average rating (1-5)')]);
    questions.forEach((q, i) => {
      const as = answers.filter((a) => a.question_id === q.id && doneIds.has(a.session_id));
      const nums = q.kind === 'rating' ? as.map((a) => Number(a.answer)).filter((n) => n >= 1 && n <= 5) : [];
      summary.push([L(i + 1), q.prompt, q.kind === 'rating' ? 'Rating' : 'Open answer', L(q.kind === 'rating' ? nums.length : as.length), L(nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null)]);
    });
  }
  const tagCount = {};
  notes.forEach((n) => (tagCount[n.tag] = (tagCount[n.tag] || 0) + 1));
  if (notes.length) {
    summary.push([], [{ v: 'Researcher notes by tag', s: 'title' }], [H('Tag'), H('Count')]);
    Object.keys(tagCount).forEach((k) => summary.push([tagName[k] || k, L(tagCount[k])]));
  }
  summary.push([], [{ v: 'Videos are not included in this file. Watch them in Aloud under Sessions.', s: 'plain' }]);

  return { summary, sessionRows, taskRows, answerRows, noteRows };
}

module.exports = { buildXlsx, buildCsv, buildReport, videoFilename };
