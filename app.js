// 업무 비서 — 통화 녹음·메일·메신저 내용을 Claude로 분석해 할 일, 일정, 정리 노트를 만든다.
// 모든 데이터는 이 브라우저의 localStorage에만 저장된다.

const STORE_KEY = 'work-assistant:data';
const SETTINGS_KEY = 'work-assistant:settings';
const SOURCE_LABELS = { call: '통화 녹음', email: '메일', messenger: '메신저', meeting: '회의록', other: '기타' };
const PRIO_LABELS = { high: '높음', medium: '보통', low: '낮음' };
// 서버측 거절 대체(fallback)를 지원하는 모델
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

// ---------- 저장소 ----------
function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { setStatus('저장 실패: ' + e.message, true); }
}

let data = load(STORE_KEY, { sources: [], tasks: [], events: [] });
let settings = load(SETTINGS_KEY, { apiKey: '', model: 'claude-opus-5-5' });
const persist = () => save(STORE_KEY, data);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- Claude API ----------
const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'key_points', 'tasks', 'events', 'people'],
  properties: {
    summary: { type: 'string', description: '자료 전체를 3~5문장으로 요약' },
    key_points: { type: 'array', items: { type: 'string' }, description: '업무에 필요한 핵심 정보(숫자, 결정 사항, 조건, 연락처 등)' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail', 'due_date', 'priority', 'requester'],
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD, 없으면 null' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          requester: { type: ['string', 'null'] },
        },
      },
    },
    events: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'date', 'start_time', 'end_time', 'location', 'attendees'],
        properties: {
          title: { type: 'string' },
          date: { type: 'string', description: 'YYYY-MM-DD' },
          start_time: { type: ['string', 'null'], description: 'HH:MM (24시간), 없으면 null' },
          end_time: { type: ['string', 'null'] },
          location: { type: ['string', 'null'] },
          attendees: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    people: { type: 'array', items: { type: 'string' }, description: '등장한 사람/회사' },
  },
};

const SYSTEM_PROMPT = `당신은 사용자의 업무 비서입니다. 사용자가 받은 통화 녹음 받아쓰기, 메일, 메신저 대화, 회의록을 읽고 사용자가 해야 할 일과 일정을 정리합니다.
- 사용자 본인이 해야 하거나 챙겨야 하는 일만 tasks에 넣으세요. 상대방이 하겠다고 한 일은 key_points에 "(상대) ..." 형태로 적으세요.
- "내일", "다음 주 금요일" 같은 상대 날짜는 기준일을 바탕으로 YYYY-MM-DD로 바꾸세요. 날짜를 알 수 없으면 null로 두세요.
- 확정된 약속·회의·마감 시각은 events에 넣으세요. 마감일만 있는 작업은 tasks의 due_date로 충분합니다.
- 자료에 없는 내용을 지어내지 마세요. 모든 텍스트는 한국어로 쓰세요.`;

async function analyze(text, type, title) {
  if (!settings.apiKey) throw new Error('설정 탭에서 Anthropic API 키를 먼저 입력하세요.');
  const model = settings.model || 'claude-opus-5-5';
  const headers = {
    'content-type': 'application/json',
    'x-api-key': settings.apiKey,
    'anthropic-version': '2026-10-21',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const body = {
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: EXTRACT_SCHEMA } },
    messages: [{
      role: 'user',
      content: `기준일(오늘): ${todayStr()}\n자료 종류: ${SOURCE_LABELS[type]}\n제목: ${title || '(없음)'}\n\n<자료>\n${text}\n</자료>`,
    }],
  };
  if (FALLBACK_MODELS.has(model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    if (res.status === 401) throw new Error('API 키가 올바르지 않습니다. 설정을 확인하세요.');
    if (res.status === 429) throw new Error('요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
    throw new Error(`API 오류(${res.status}): ${msg}`);
  }
  if (json.stop_reason === 'refusal') throw new Error('모델이 이 자료의 처리를 거절했습니다.');
  if (json.stop_reason === 'max_tokens') throw new Error('자료가 너무 길어 결과가 잘렸습니다. 나눠서 넣어 주세요.');
  const textBlock = (json.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('응답에 결과가 없습니다.');
  return JSON.parse(textBlock.text);
}

// ---------- 화면 공통 ----------
function setStatus(msg, isError = false) {
  const el = $('#status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function switchView(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  render();
}

function render() {
  renderSources();
  renderTasks();
  renderSchedule();
  renderNotes();
  $('#taskCount').textContent = data.tasks.filter((t) => !t.done).length;
}

function sourceName(id) {
  const s = data.sources.find((x) => x.id === id);
  return s ? `${SOURCE_LABELS[s.type]} · ${s.title}` : '직접 추가';
}

// ---------- 자료 입력 ----------
function renderSources() {
  const ul = $('#sourceList');
  if (!data.sources.length) { ul.innerHTML = '<li class="empty">아직 분석한 자료가 없습니다.</li>'; return; }
  ul.innerHTML = data.sources.slice(0, 20).map((s) => `
    <li class="row between">
      <div>
        <div class="title">${esc(s.title)}</div>
        <div class="meta"><span>${SOURCE_LABELS[s.type]}</span><span>${new Date(s.createdAt).toLocaleString('ko-KR')}</span>
        <span>할 일 ${data.tasks.filter((t) => t.sourceId === s.id).length} · 일정 ${data.events.filter((e) => e.sourceId === s.id).length}</span></div>
      </div>
      <button class="icon-btn" data-del-source="${s.id}" title="자료와 관련 항목 삭제">삭제</button>
    </li>`).join('');
}

async function onAnalyze() {
  const text = $('#sourceText').value.trim();
  const type = $('#sourceType').value;
  const title = $('#sourceTitle').value.trim() || `${SOURCE_LABELS[type]} ${new Date().toLocaleDateString('ko-KR')}`;
  if (!text) { setStatus('분석할 내용을 넣어 주세요.', true); return; }

  const btn = $('#analyzeBtn');
  btn.disabled = true;
  setStatus('분석 중입니다… 자료 길이에 따라 수십 초 걸릴 수 있습니다.');
  try {
    const r = await analyze(text, type, title);
    const sourceId = uid();
    data.sources.unshift({
      id: sourceId, type, title, text, createdAt: Date.now(),
      summary: r.summary, keyPoints: r.key_points, people: r.people,
    });
    r.tasks.forEach((t) => data.tasks.push({
      id: uid(), sourceId, title: t.title, detail: t.detail, due: t.due_date,
      priority: t.priority, requester: t.requester, done: false, createdAt: Date.now(),
    }));
    r.events.forEach((e) => data.events.push({
      id: uid(), sourceId, title: e.title, date: e.date, start: e.start_time, end: e.end_time,
      location: e.location, attendees: e.attendees,
    }));
    persist();
    $('#sourceText').value = '';
    $('#sourceTitle').value = '';
    setStatus(`완료: 할 일 ${r.tasks.length}개, 일정 ${r.events.length}개를 찾았습니다.`);
    render();
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function onFiles(e) {
  const files = [...e.target.files];
  const texts = await Promise.all(files.map(async (f) => `--- ${f.name} ---\n${await f.text()}`));
  const box = $('#sourceText');
  box.value = (box.value ? box.value + '\n\n' : '') + texts.join('\n\n');
  if (!$('#sourceTitle').value && files.length === 1) $('#sourceTitle').value = files[0].name;
  e.target.value = '';
}

// ---------- 할 일 ----------
const PRIO_ORDER = { high: 0, medium: 1, low: 2 };
function renderTasks() {
  const filter = $('#taskFilter').value;
  const list = data.tasks
    .filter((t) => filter === 'all' || (filter === 'done' ? t.done : !t.done))
    .sort((a, b) => (a.done - b.done) || ((a.due || '9999') .localeCompare(b.due || '9999')) || (PRIO_ORDER[a.priority] - PRIO_ORDER[b.priority]));
  const ul = $('#taskList');
  if (!list.length) { ul.innerHTML = '<li class="empty">표시할 할 일이 없습니다.</li>'; return; }
  const today = todayStr();
  ul.innerHTML = list.map((t) => `
    <li class="task ${t.done ? 'done' : ''}">
      <input type="checkbox" data-toggle="${t.id}" ${t.done ? 'checked' : ''} aria-label="완료">
      <div class="body">
        <div class="title">${esc(t.title)}</div>
        ${t.detail ? `<div>${esc(t.detail)}</div>` : ''}
        <div class="meta">
          <span class="prio ${t.priority}">${PRIO_LABELS[t.priority] || ''}</span>
          ${t.due ? `<span>${t.due < today && !t.done ? '⚠ 기한 지남 · ' : ''}마감 ${t.due}</span>` : ''}
          ${t.requester ? `<span>요청: ${esc(t.requester)}</span>` : ''}
          <span>${esc(sourceName(t.sourceId))}</span>
        </div>
      </div>
      <button class="icon-btn" data-edit-task="${t.id}">수정</button>
      <button class="icon-btn" data-del-task="${t.id}">삭제</button>
    </li>`).join('');
}

function editTask(task) {
  const title = prompt('할 일', task?.title || '');
  if (!title) return;
  const due = prompt('마감일 (YYYY-MM-DD, 없으면 비워두기)', task?.due || '') || null;
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) { alert('날짜는 YYYY-MM-DD 형식으로 입력하세요.'); return; }
  const prio = prompt('우선순위 (high / medium / low)', task?.priority || 'medium');
  const priority = ['high', 'medium', 'low'].includes(prio) ? prio : 'medium';
  if (task) Object.assign(task, { title, due, priority });
  else data.tasks.push({ id: uid(), sourceId: null, title, detail: '', due, priority, requester: null, done: false, createdAt: Date.now() });
  persist(); render();
}

// ---------- 일정 ----------
function renderSchedule() {
  const byDate = {};
  data.events.forEach((e) => (byDate[e.date] ||= []).push({ kind: 'event', ...e }));
  data.tasks.filter((t) => t.due && !t.done).forEach((t) => (byDate[t.due] ||= []).push({ kind: 'task', ...t }));
  const dates = Object.keys(byDate).sort();
  const box = $('#scheduleList');
  if (!dates.length) { box.innerHTML = '<p class="empty">아직 일정이 없습니다.</p>'; return; }
  const today = todayStr();
  box.innerHTML = dates.map((d) => {
    const items = byDate[d].sort((a, b) => (a.start || '99').localeCompare(b.start || '99'));
    const weekday = new Date(d + 'T00:00').toLocaleDateString('ko-KR', { weekday: 'short' });
    return `<div class="day ${d < today ? 'past' : ''} ${d === today ? 'today' : ''}">
      <h3>${d} (${weekday})${d === today ? ' · 오늘' : ''}</h3>
      <ul class="list">${items.map((i) => i.kind === 'event' ? `
        <li><div class="title">📅 ${i.start ? i.start + (i.end ? '–' + i.end : '') + ' ' : ''}${esc(i.title)}</div>
          <div class="meta">${i.location ? `<span>장소: ${esc(i.location)}</span>` : ''}
          ${i.attendees?.length ? `<span>참석: ${esc(i.attendees.join(', '))}</span>` : ''}
          <span>${esc(sourceName(i.sourceId))}</span>
          <button class="icon-btn" data-del-event="${i.id}">삭제</button></div></li>` : `
        <li><div class="title">✅ 마감: ${esc(i.title)}</div>
          <div class="meta"><span class="prio ${i.priority}">${PRIO_LABELS[i.priority] || ''}</span><span>${esc(sourceName(i.sourceId))}</span></div></li>`).join('')}
      </ul></div>`;
  }).join('');
}

function exportIcs() {
  const icsDate = (d) => d.replace(/-/g, '');
  const icsTime = (d, t) => `${icsDate(d)}T${t.replace(':', '')}00`;
  const escIcs = (s) => String(s || '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const nextDay = (d) => { const x = new Date(d + 'T00:00'); x.setDate(x.getDate() + 1); return x.toISOString().slice(0, 10); };
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//work-assistant//KO', 'CALSCALE:GREGORIAN'];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const push = (id, summary, date, start, end, location, desc) => {
    lines.push('BEGIN:VEVENT', `UID:${id}@work-assistant`, `DTSTAMP:${stamp}`);
    if (start) {
      lines.push(`DTSTART:${icsTime(date, start)}`);
      if (end) lines.push(`DTEND:${icsTime(date, end)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(date)}`, `DTEND;VALUE=DATE:${icsDate(nextDay(date))}`);
    }
    lines.push(`SUMMARY:${escIcs(summary)}`);
    if (location) lines.push(`LOCATION:${escIcs(location)}`);
    if (desc) lines.push(`DESCRIPTION:${escIcs(desc)}`);
    lines.push('END:VEVENT');
  };
  data.events.forEach((e) => push(e.id, e.title, e.date, e.start, e.end, e.location, (e.attendees || []).join(', ')));
  data.tasks.filter((t) => t.due && !t.done).forEach((t) => push(t.id, '[마감] ' + t.title, t.due, null, null, null, t.detail));
  lines.push('END:VCALENDAR');
  download('업무일정.ics', lines.join('\r\n'), 'text/calendar');
}

// ---------- 정리 노트 ----------
function renderNotes() {
  const box = $('#notesList');
  if (!data.sources.length) { box.innerHTML = '<p class="empty">자료를 분석하면 요약과 핵심 내용이 여기에 정리됩니다.</p>'; return; }
  box.innerHTML = data.sources.map((s) => `
    <div class="note">
      <div class="title">${esc(s.title)}</div>
      <div class="meta"><span>${SOURCE_LABELS[s.type]}</span><span>${new Date(s.createdAt).toLocaleString('ko-KR')}</span>
        ${s.people?.length ? `<span>관련: ${esc(s.people.join(', '))}</span>` : ''}</div>
      <p>${esc(s.summary)}</p>
      ${s.keyPoints?.length ? `<ul>${s.keyPoints.map((k) => `<li>${esc(k)}</li>`).join('')}</ul>` : ''}
      <details><summary>원문 보기</summary><pre style="white-space:pre-wrap">${esc(s.text)}</pre></details>
    </div>`).join('');
}

// ---------- 설정 / 백업 ----------
function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 이벤트 연결 ----------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));
$('#analyzeBtn').addEventListener('click', onAnalyze);
$('#fileInput').addEventListener('change', onFiles);
$('#taskFilter').addEventListener('change', renderTasks);
$('#addTaskBtn').addEventListener('click', () => editTask(null));
$('#exportIcsBtn').addEventListener('click', exportIcs);

document.addEventListener('click', (e) => {
  const d = e.target.dataset;
  if (d.toggle) { const t = data.tasks.find((x) => x.id === d.toggle); t.done = e.target.checked; persist(); render(); }
  else if (d.editTask) editTask(data.tasks.find((x) => x.id === d.editTask));
  else if (d.delTask && confirm('이 할 일을 삭제할까요?')) { data.tasks = data.tasks.filter((x) => x.id !== d.delTask); persist(); render(); }
  else if (d.delEvent && confirm('이 일정을 삭제할까요?')) { data.events = data.events.filter((x) => x.id !== d.delEvent); persist(); render(); }
  else if (d.delSource && confirm('이 자료와 여기서 나온 할 일·일정을 모두 삭제할까요?')) {
    data.sources = data.sources.filter((x) => x.id !== d.delSource);
    data.tasks = data.tasks.filter((x) => x.sourceId !== d.delSource);
    data.events = data.events.filter((x) => x.sourceId !== d.delSource);
    persist(); render();
  }
});

$('#apiKey').value = settings.apiKey;
$('#model').value = settings.model;
$('#saveSettings').addEventListener('click', () => {
  settings = { apiKey: $('#apiKey').value.trim(), model: $('#model').value };
  save(SETTINGS_KEY, settings);
  alert('저장했습니다.');
});
$('#exportJson').addEventListener('click', () => download(`업무비서-백업-${todayStr()}.json`, JSON.stringify(data, null, 2), 'application/json'));
$('#importJson').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.sources) || !Array.isArray(d.tasks) || !Array.isArray(d.events)) throw new Error('형식이 맞지 않습니다.');
    if (confirm('현재 데이터를 백업 파일 내용으로 바꿀까요?')) { data = d; persist(); render(); }
  } catch (err) { alert('불러오기 실패: ' + err.message); }
  e.target.value = '';
});
$('#clearAll').addEventListener('click', () => {
  if (confirm('모든 자료, 할 일, 일정을 삭제할까요? 되돌릴 수 없습니다.')) { data = { sources: [], tasks: [], events: [] }; persist(); render(); }
});

render();
