const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = {
  memberId: null,
  members: [],
  books: [],
  subject: 'All',
  onlyFree: false,
  layout: 'table',
  queueBook: null,
  modalBook: null,
  logs: []
};

/* API Wrapper with Live Latency & Status Logging */
async function api(path, opts = {}) {
  const method = opts.method || 'GET';
  const t0 = performance.now();
  try {
    const res = await fetch(path, opts);
    const ms = Math.round(performance.now() - t0);
    let body = null;
    try { body = await res.json(); } catch (_) {}

    if (path !== '/health') {
      state.logs.unshift({
        time: new Date().toLocaleTimeString(),
        endpoint: `${method} ${path}`,
        status: res.status,
        ok: res.ok,
        ms,
        summary: JSON.stringify(body).slice(0, 110)
      });
      if (state.logs.length > 40) state.logs.pop();
      renderLogs();
    }
    return { ok: res.ok, status: res.status, body, ms };
  } catch (err) {
    return { ok: false, status: 0, body: { error: 'Cannot reach server. Ensure npm run dev is running.' }, ms: 0 };
  }
}

const post = (path, payload) => api(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload || {})
});

function toast(message, ok = true) {
  const el = document.createElement('div');
  el.className = `toast ${ok ? '' : 'bad'}`;
  el.textContent = message;
  $('#toast-stack').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/* Tab Navigation */
function switchTab(tab) {
  for (const name of ['books', 'loans', 'queue', 'logs']) {
    $(`#p-${name}`).hidden = name !== tab;
    $(`#t-${name}`).classList.toggle('active', name === tab);
  }
  if (tab === 'loans') loadMemberDetail();
  if (tab === 'queue') loadQueue();
}

/* Health Check */
async function loadHealth() {
  const { ok, body } = await api('/health');
  $('#srv-dot').className = `dot ${ok ? '' : 'off'}`;
  $('#srv-status').textContent = ok ? 'Connected' : 'Offline';
  $('#kpi-db-books').textContent = ok ? `${body.books} Books` : 'DB Error';
}

/* Members & Detailed Profile */
async function loadMembers() {
  const { ok, body } = await api('/api/members');
  if (!ok) return toast(body?.error || 'Failed to load members', false);
  state.members = body;

  const sel = $('#who');
  const prev = state.memberId || sel.value;
  sel.innerHTML = body.map((m) =>
    `<option value="${m.member_id}">${esc(m.name)} (${m.open_loans}/${m.borrow_limit}${m.status !== 'active' ? ' • SUSPENDED' : ''})</option>`
  ).join('');

  if (prev) sel.value = prev;
  state.memberId = sel.value;
  await loadMemberDetail();
}

async function loadMemberDetail() {
  if (!state.memberId) return;
  const { ok, body } = await api(`/api/members/${state.memberId}`);
  if (!ok) return toast(body?.error || 'Failed to load member profile', false);

  const pct = Math.min(100, Math.round((body.open_loans / body.borrow_limit) * 100));
  $('#kpi-member-name').textContent = body.name;
  $('#kpi-member-meta').textContent = `${body.email} • Joined ${body.join_date}`;
  $('#member-badge').className = `badge ${body.status === 'active' ? 'ok' : 'bad'}`;
  $('#member-badge').textContent = body.status === 'active' ? 'Active' : 'Suspended';

  $('#kpi-quota').textContent = `${body.open_loans} / ${body.borrow_limit} Loans`;
  $('#kpi-quota-pct').textContent = `${pct}%`;
  $('#kpi-bar').style.width = `${pct}%`;
  $('#kpi-bar').style.background = pct >= 100 ? 'var(--bad)' : 'var(--primary)';
  $('#c-loans').textContent = body.open_loans;

  $('#loans-h').textContent = `Open Loans for ${body.name} (${body.open_loans} of ${body.borrow_limit})`;
  const today = new Date().toLocaleDateString('en-CA');
  $('#loans-tbody').innerHTML = body.loans.length
    ? body.loans.map((l) => {
        const overdue = l.due_date < today;
        return `<tr>
          <td><strong>${esc(l.title)}</strong></td>
          <td><code>${esc(l.barcode)}</code></td>
          <td>${esc(l.issue_date)}</td>
          <td><span class="badge ${overdue ? 'bad' : 'ok'}">${esc(l.due_date)}${overdue ? ' • OVERDUE' : ''}</span></td>
          <td><button class="btn primary small" data-a="return" data-id="${l.issue_id}">Return Copy</button></td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="5" class="empty">No active loans. Issue a book from the Catalogue tab!</td></tr>';
}

/* Books Catalogue */
async function loadBooks() {
  const query = encodeURIComponent($('#q').value.trim());
  const { ok, body } = await api(`/api/books?search=${query}`);
  if (!ok) return toast(body?.error || 'Failed to load books', false);
  state.books = body;

  const subjects = ['All', ...new Set(body.map((b) => b.subject))];
  if (!subjects.includes(state.subject)) state.subject = 'All';
  $('#subject-chips').innerHTML = subjects.map((s) =>
    `<button class="chip ${s === state.subject ? 'active' : ''}" data-subj="${esc(s)}">${esc(s)}</button>`
  ).join('');

  renderBooks();
}

function renderBooks() {
  let list = state.books;
  if (state.subject !== 'All') list = list.filter((b) => b.subject === state.subject);
  if (state.onlyFree) list = list.filter((b) => Number(b.copies_available) > 0);

  const freeCopies = list.reduce((sum, b) => sum + Number(b.copies_available), 0);
  $('#kpi-books').textContent = `${list.length} Titles`;
  $('#kpi-avail-copies').textContent = `${freeCopies} free`;
  $('#c-books').textContent = list.length;

  $('#books-table-wrap').hidden = state.layout !== 'table';
  $('#books-grid').hidden = state.layout !== 'grid';

  if (state.layout === 'table') {
    $('#books-tbody').innerHTML = list.length
      ? list.map((b) => {
          const free = Number(b.copies_available);
          return `<tr>
            <td>
              <button class="book-title-btn" data-a="inspect" data-id="${b.book_id}">${esc(b.title)}</button>
              <div class="muted">${esc(b.author)} • ${esc(b.publication_year)} • ISBN ${esc(b.isbn)}</div>
            </td>
            <td><span class="badge neutral">${esc(b.subject)}</span></td>
            <td><span class="badge ${free > 0 ? 'ok' : 'bad'}">${free} of ${b.total_copies} free</span></td>
            <td>
              <div class="actions">
                <button class="btn primary small" data-a="issue" data-id="${b.book_id}">Issue</button>
                ${free === 0 ? `<button class="btn warn small" data-a="reserve" data-id="${b.book_id}">Reserve</button>` : ''}
                <button class="btn small" data-a="queue" data-id="${b.book_id}" data-t="${esc(b.title)}">Queue</button>
                <button class="btn small" data-a="inspect" data-id="${b.book_id}">Copies</button>
              </div>
            </td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="4" class="empty">No books match your filters.</td></tr>';
  } else {
    $('#books-grid').innerHTML = list.length
      ? list.map((b) => {
          const free = Number(b.copies_available);
          return `<article class="book-card">
            <div>
              <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:8px">
                <span class="badge neutral">${esc(b.subject)}</span>
                <span class="badge ${free > 0 ? 'ok' : 'bad'}">${free}/${b.total_copies} free</span>
              </div>
              <button class="book-title-btn" data-a="inspect" data-id="${b.book_id}">${esc(b.title)}</button>
              <p class="muted">${esc(b.author)} (${esc(b.publication_year)})</p>
            </div>
            <div class="actions">
              <button class="btn primary small" data-a="issue" data-id="${b.book_id}">Issue</button>
              ${free === 0 ? `<button class="btn warn small" data-a="reserve" data-id="${b.book_id}">Reserve</button>` : ''}
              <button class="btn small" data-a="queue" data-id="${b.book_id}" data-t="${esc(b.title)}">Queue</button>
              <button class="btn small" data-a="inspect" data-id="${b.book_id}">Barcodes</button>
            </div>
          </article>`;
        }).join('')
      : '<div class="empty surface">No books match your filters.</div>';
  }
}

/* Reservation Queue */
async function loadQueue() {
  if (!state.queueBook) {
    $('#queue-h').textContent = 'Reservation Queue';
    $('#c-queue').textContent = '0';
    $('#queue-tbody').innerHTML = '<tr><td colspan="4" class="empty">Click "Queue" on any book to inspect its FIFO waitlist.</td></tr>';
    return;
  }
  const { ok, body } = await api(`/api/reservations/book/${state.queueBook.id}`);
  if (!ok) return toast(body?.error || 'Could not load queue', false);

  $('#queue-h').textContent = `FIFO Queue — ${state.queueBook.title}`;
  $('#c-queue').textContent = body.length;
  $('#queue-tbody').innerHTML = body.length
    ? body.map((r) => `<tr>
        <td><span class="badge warn">#${r.queue_position}</span></td>
        <td><strong>${esc(r.member_name)}</strong></td>
        <td>${esc(String(r.reserved_at).replace('T', ' ').slice(0, 16))}</td>
        <td>${String(r.member_id) === String(state.memberId)
          ? `<button class="btn danger small" data-a="cancel" data-id="${r.reservation_id}">Cancel Hold</button>`
          : '<span class="muted">Waiting</span>'}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="empty">Queue is empty for this book.</td></tr>';
}

/* Physical Copy Inspector Modal */
async function openInspector(bookId) {
  const { ok, body } = await api(`/api/books/${bookId}`);
  if (!ok) return toast(body?.error || 'Could not load copy details', false);
  state.modalBook = body;

  $('#m-title').textContent = body.title;
  $('#m-meta').textContent = `${body.author} • ${body.subject} • ISBN ${body.isbn}`;
  $('#m-race-out').hidden = true;
  $('#m-copies').innerHTML = body.copies.map((c) => {
    const tone = c.status === 'available' ? 'ok' : (c.status === 'reserved' ? 'warn' : 'bad');
    return `<div class="copy-tile">
      <strong>Physical Copy #${c.copy_number}</strong>
      <code>${esc(c.barcode)}</code>
      <span class="badge ${tone}">${esc(c.status.toUpperCase())}</span>
    </div>`;
  }).join('');
  $('#modal-bg').hidden = false;
}

/* Live API Logs */
function renderLogs() {
  $('#c-logs').textContent = state.logs.length;
  $('#logs-tbody').innerHTML = state.logs.length
    ? state.logs.map((l) => `<tr>
        <td>${esc(l.time)}</td>
        <td><code>${esc(l.endpoint)}</code></td>
        <td><span class="badge ${l.ok ? 'ok' : 'bad'}">${l.status}</span></td>
        <td>${l.ms} ms</td>
        <td><code>${esc(l.summary)}</code></td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty">No API calls logged yet.</td></tr>';
}

async function refreshAll() {
  await loadHealth();
  await loadMembers();
  await loadBooks();
  if (!$('#p-queue').hidden) await loadQueue();
}

/* Delegated Click Handler */
document.addEventListener('click', async (e) => {
  const chip = e.target.closest('[data-subj]');
  if (chip) {
    state.subject = chip.dataset.subj;
    $('#subject-chips').querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    return renderBooks();
  }

  const btn = e.target.closest('[data-a]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const action = btn.dataset.a;

  if (action === 'inspect') return openInspector(id);
  if (action === 'queue') {
    state.queueBook = { id, title: btn.dataset.t };
    return switchTab('queue');
  }

  let res;
  if (action === 'issue') {
    res = await post('/api/loans/issue', { member_id: Number(state.memberId), book_id: id });
    toast(res.ok ? `Issued! Copy #${res.body.copy_id} due in ${res.body.due_in_days} days.` : res.body.error, res.ok);
  } else if (action === 'reserve') {
    res = await post('/api/reservations', { member_id: Number(state.memberId), book_id: id });
    toast(res.ok ? `Reserved! You are #${res.body.queue_position} in the FIFO queue.` : res.body.error, res.ok);
    if (res.ok) {
      const b = state.books.find((x) => x.book_id === id);
      state.queueBook = { id, title: b ? b.title : `Book #${id}` };
    }
  } else if (action === 'return') {
    res = await post('/api/loans/return', { issue_id: id });
    if (res.ok) {
      const hold = res.body.held_for_reservation;
      toast('Returned!' + (res.body.overdue_days ? ` (${res.body.overdue_days}d overdue)` : '') +
        (hold ? ` Auto-assigned to Member #${hold.member_id} (48h hold).` : ' Copy returned to shelf.'), true);
    } else toast(res.body.error, false);
  } else if (action === 'cancel') {
    res = await post(`/api/reservations/${id}/cancel`);
    toast(res.ok ? 'Hold cancelled.' + (res.body.copy_passed_to ? ` Passed to Member #${res.body.copy_passed_to.member_id}.` : '') : res.body.error, res.ok);
  }
  await refreshAll();
});

/* Concurrent Burst Simulator inside Modal */
$('#m-race').addEventListener('click', async () => {
  if (!state.modalBook) return;
  const n = Number($('#burst-count').value);
  const eligible = state.members.filter((m) => m.status === 'active' && Number(m.open_loans) < Number(m.borrow_limit));
  if (!eligible.length) return toast('No active members with available loan quota.', false);

  $('#m-race').disabled = true;
  const t0 = performance.now();
  const responses = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      post('/api/loans/issue', { member_id: eligible[i % eligible.length].member_id, book_id: state.modalBook.book_id })
    )
  );
  const elapsed = Math.round(performance.now() - t0);
  $('#m-race').disabled = false;

  const won = responses.filter((r) => r.status === 201);
  const blocked = responses.filter((r) => r.status !== 201);
  const out = $('#m-race-out');
  out.hidden = false;
  out.innerHTML = `<strong>${n} Simultaneous Requests Resolved in ${elapsed} ms:</strong><br>
    ✅ <span style="color:var(--ok);font-weight:700">${won.length} Succeeded (201)</span> — Claimed Copy IDs: <code>${won.map((w) => w.body.copy_id).join(', ') || 'None'}</code><br>
    🛡️ <span style="color:var(--bad);font-weight:700">${blocked.length} Rejected by Row Lock (409 Conflict)</span>`;

  await openInspector(state.modalBook.book_id);
  await refreshAll();
});

/* Sweep Expired 48h Holds */
$('#btn-expire').addEventListener('click', async () => {
  const res = await post('/api/reservations/expire-overdue');
  toast(res.ok ? `Swept ${res.body.expired} expired 48h reservation(s).` : res.body.error, res.ok);
  await refreshAll();
});

/* Search, Filters, Layout & Theme Controls */
let searchTimer;
$('#q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadBooks, 180); });
$('#only-free').addEventListener('change', (e) => { state.onlyFree = e.target.checked; renderBooks(); });
$('#view-table').addEventListener('click', () => {
  state.layout = 'table';
  $('#view-table').classList.add('active');
  $('#view-grid').classList.remove('active');
  renderBooks();
});
$('#view-grid').addEventListener('click', () => {
  state.layout = 'grid';
  $('#view-grid').classList.add('active');
  $('#view-table').classList.remove('active');
  renderBooks();
});
$('#clear-filters').addEventListener('click', () => {
  $('#q').value = '';
  state.subject = 'All';
  state.onlyFree = false;
  $('#only-free').checked = false;
  loadBooks();
});
$('#clear-logs').addEventListener('click', () => { state.logs = []; renderLogs(); });
$('#who').addEventListener('change', (e) => { state.memberId = e.target.value; refreshAll(); });
$('#m-close').addEventListener('click', () => { $('#modal-bg').hidden = true; });
$('#modal-bg').addEventListener('click', (e) => { if (e.target === $('#modal-bg')) $('#modal-bg').hidden = true; });
for (const t of ['books', 'loans', 'queue', 'logs']) $(`#t-${t}`).addEventListener('click', () => switchTab(t));

/* Dark/Light Theme Persistence */
const savedTheme = localStorage.getItem('lc-theme');
if (savedTheme) document.documentElement.setAttribute('data-theme', savedTheme);
$('#theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('lc-theme', next);
});

refreshAll();

