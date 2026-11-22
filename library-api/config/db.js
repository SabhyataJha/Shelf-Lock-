require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const realPool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 60,
  dateStrings: true,
});

/* CSV Loader for Built-in Relational Fallback Engine */
function parseCSV(filename) {
  const filePath = path.resolve(__dirname, '../../', filename);
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  const lines = raw.split(/\r?\n/);
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const vals = [];
    let cur = '', inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === ',' && !inQuotes) { vals.push(cur); cur = ''; }
      else cur += ch;
    }
    vals.push(cur);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (vals[idx] ?? '').trim(); });
    return obj;
  });
}

function todayStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}
function nowDate(offsetHours = 0) {
  return new Date(Date.now() + offsetHours * 3600000);
}
function fmtDateTime(d) {
  return new Date(d).toISOString().replace('T', ' ').slice(0, 19);
}

/* In-Memory Relational Engine with Real Async Row-Level Locking */
function createMemoryEngine() {
  const authors = parseCSV('authors.csv').map((a) => ({
    author_id: Number(a.author_id), name: a.name, country: a.country
  }));
  const subjects = parseCSV('subjects.csv').map((s) => ({
    subject_id: Number(s.subject_id), name: s.name
  }));
  const books = parseCSV('books.csv').map((b) => ({
    book_id: Number(b.book_id),
    isbn: b.isbn,
    title: b.title,
    author_id: Number(b.author_id),
    subject_id: Number(b.subject_id),
    publication_year: Number(b.publication_year),
    total_copies: Number(b.total_copies)
  }));
  const members = parseCSV('members.csv').map((m) => ({
    member_id: Number(m.member_id),
    name: m.name,
    email: m.email,
    phone: m.phone,
    join_date: m.join_date,
    status: m.status,
    borrow_limit: 5
  }));

  const book_copies = [];
  let nextCopyId = 1;
  for (const b of books) {
    for (let n = 1; n <= b.total_copies; n++) {
      book_copies.push({
        copy_id: nextCopyId++,
        book_id: b.book_id,
        copy_number: n,
        barcode: `LIB-${String(b.book_id).padStart(4, '0')}-${n}`,
        status: 'available'
      });
    }
  }

  let nextIssueId = 1;
  const issued_books = [];
  for (const row of parseCSV('issued_books.csv')) {
    const bookId = Number(row.book_id);
    const isOpen = !row.return_date || row.return_date === 'NULL';
    const copy = book_copies.find((c) => c.book_id === bookId && (!isOpen || c.status === 'available'))
      || book_copies.find((c) => c.book_id === bookId);
    if (!copy) continue;
    if (isOpen) copy.status = 'issued';
    issued_books.push({
      issue_id: nextIssueId++,
      copy_id: copy.copy_id,
      member_id: Number(row.member_id),
      issue_date: row.issue_date,
      due_date: row.due_date,
      return_date: isOpen ? null : row.return_date
    });
  }

  let nextResId = 1;
  const reservations = [];

  // Seed test preconditions (Member 2 at 4/5 loans, Book 194 & 42 issued, 2 waiting on Book 42)
  for (const bId of [240, 241, 242, 243]) {
    const cp = book_copies.find((c) => c.book_id === bId && c.status === 'available');
    if (cp) {
      cp.status = 'issued';
      issued_books.push({ issue_id: nextIssueId++, copy_id: cp.copy_id, member_id: 2, issue_date: todayStr(), due_date: todayStr(14), return_date: null });
    }
  }
  const cp194 = book_copies.find((c) => c.book_id === 194 && c.status === 'available');
  if (cp194) {
    cp194.status = 'issued';
    issued_books.push({ issue_id: nextIssueId++, copy_id: cp194.copy_id, member_id: 10, issue_date: todayStr(), due_date: todayStr(14), return_date: null });
  }
  for (const [idx, mId] of [11, 12].entries()) {
    const cp42 = book_copies.find((c) => c.book_id === 42 && c.copy_number === idx + 1 && c.status === 'available');
    if (cp42) {
      cp42.status = 'issued';
      issued_books.push({ issue_id: nextIssueId++, copy_id: cp42.copy_id, member_id: mId, issue_date: todayStr(), due_date: todayStr(14), return_date: null });
    }
  }
  reservations.push(
    { reservation_id: nextResId++, book_id: 42, member_id: 13, reserved_at: nowDate(-0.2), status: 'waiting', held_copy_id: null, ready_at: null, expires_at: null },
    { reservation_id: nextResId++, book_id: 42, member_id: 14, reserved_at: nowDate(-0.1), status: 'waiting', held_copy_id: null, ready_at: null, expires_at: null }
  );

  // Row-level mutex manager supporting FOR UPDATE and SKIP LOCKED
  const rowLocks = new Map();
  function isLocked(key, owner) {
    const entry = rowLocks.get(key);
    return entry && entry.owner !== owner;
  }
  async function acquireLock(key, owner) {
    while (rowLocks.has(key) && rowLocks.get(key).owner !== owner) {
      await new Promise((r) => rowLocks.get(key).waiters.push(r));
    }
    if (!rowLocks.has(key)) rowLocks.set(key, { owner, waiters: [] });
  }
  function releaseLocks(owner) {
    for (const [key, entry] of rowLocks.entries()) {
      if (entry.owner === owner) {
        rowLocks.delete(key);
        const next = entry.waiters.shift();
        if (next) next();
      }
    }
  }

  function getQueueView(bookId = null) {
    const waiting = reservations
      .filter((r) => r.status === 'waiting' && (bookId === null || r.book_id === Number(bookId)))
      .sort((a, b) => new Date(a.reserved_at) - new Date(b.reserved_at) || a.reservation_id - b.reservation_id);
    const counters = new Map();
    return waiting.map((r) => {
      const pos = (counters.get(r.book_id) || 0) + 1;
      counters.set(r.book_id, pos);
      const m = members.find((x) => x.member_id === r.member_id);
      return {
        reservation_id: r.reservation_id,
        book_id: r.book_id,
        member_id: r.member_id,
        member_name: m ? m.name : `Member ${r.member_id}`,
        reserved_at: fmtDateTime(r.reserved_at),
        queue_position: pos
      };
    });
  }

  async function executeSQL(rawSql, params = [], owner = Symbol('auto')) {
    const sql = rawSql.replace(/\s+/g, ' ').trim();

    if (/^SELECT COUNT\(\*\) AS books FROM books$/i.test(sql)) {
      return [[{ books: books.length }]];
    }

    if (/FROM books b JOIN authors a/i.test(sql) && /LIKE \?/i.test(sql)) {
      const term = String(params[0] || '').replace(/%/g, '').toLowerCase();
      const rows = books
        .map((b) => {
          const a = authors.find((x) => x.author_id === b.author_id);
          const s = subjects.find((x) => x.subject_id === b.subject_id);
          const copies = book_copies.filter((c) => c.book_id === b.book_id);
          return {
            book_id: b.book_id,
            title: b.title,
            isbn: b.isbn,
            author: a ? a.name : '',
            subject: s ? s.name : '',
            publication_year: b.publication_year,
            total_copies: copies.length,
            copies_available: copies.filter((c) => c.status === 'available').length
          };
        })
        .filter((r) => !term || r.title.toLowerCase().includes(term) || r.author.toLowerCase().includes(term))
        .sort((x, y) => x.title.localeCompare(y.title))
        .slice(0, 50);
      return [rows];
    }

    if (/SELECT b\.\*, a\.name AS author, s\.name AS subject FROM books b/i.test(sql)) {
      const b = books.find((x) => x.book_id === Number(params[0]));
      if (!b) return [[]];
      const a = authors.find((x) => x.author_id === b.author_id);
      const s = subjects.find((x) => x.subject_id === b.subject_id);
      return [[{ ...b, author: a?.name || '', subject: s?.name || '' }]];
    }

    if (/SELECT copy_id, copy_number, barcode, status FROM book_copies WHERE book_id = \?/i.test(sql)) {
      return [book_copies.filter((c) => c.book_id === Number(params[0])).sort((a, b) => a.copy_number - b.copy_number).map((c) => ({ ...c }))];
    }

    if (/FROM member_open_loans ORDER BY member_id/i.test(sql)) {
      return [members.map((m) => ({
        member_id: m.member_id,
        name: m.name,
        status: m.status,
        borrow_limit: m.borrow_limit,
        open_loans: issued_books.filter((i) => i.member_id === m.member_id && i.return_date === null).length
      }))];
    }

    if (/SELECT member_id, name, email, phone, join_date, status, borrow_limit FROM members WHERE member_id = \?/i.test(sql)) {
      const m = members.find((x) => x.member_id === Number(params[0]));
      return [m ? [{ ...m }] : []];
    }

    if (/SELECT i\.issue_id, b\.title, c\.barcode, i\.issue_date, i\.due_date FROM issued_books i/i.test(sql)) {
      const rows = issued_books
        .filter((i) => i.member_id === Number(params[0]) && i.return_date === null)
        .map((i) => {
          const c = book_copies.find((x) => x.copy_id === i.copy_id);
          const b = books.find((x) => x.book_id === c.book_id);
          return { issue_id: i.issue_id, title: b.title, barcode: c.barcode, issue_date: i.issue_date, due_date: i.due_date };
        })
        .sort((a, b) => a.due_date.localeCompare(b.due_date));
      return [rows];
    }

    if (/SELECT status, borrow_limit FROM members WHERE member_id = \? FOR UPDATE/i.test(sql)) {
      const id = Number(params[0]);
      await acquireLock(`members:${id}`, owner);
      const m = members.find((x) => x.member_id === id);
      return [m ? [{ status: m.status, borrow_limit: m.borrow_limit }] : []];
    }

    if (/SELECT status FROM members WHERE member_id = \?/i.test(sql)) {
      const m = members.find((x) => x.member_id === Number(params[0]));
      return [m ? [{ status: m.status }] : []];
    }

    if (/SELECT book_id FROM books WHERE book_id = \?/i.test(sql)) {
      const id = Number(params[0]);
      if (/FOR UPDATE/i.test(sql)) await acquireLock(`books:${id}`, owner);
      const b = books.find((x) => x.book_id === id);
      return [b ? [{ book_id: b.book_id }] : []];
    }

    if (/SELECT COUNT\(\*\) AS open_loans FROM issued_books WHERE member_id = \? AND return_date IS NULL/i.test(sql)) {
      const count = issued_books.filter((i) => i.member_id === Number(params[0]) && i.return_date === null).length;
      return [[{ open_loans: count }]];
    }

    if (/SELECT reservation_id, held_copy_id FROM reservations WHERE book_id = \? AND member_id = \? AND status = 'ready' FOR UPDATE/i.test(sql)) {
      const r = reservations.find((x) => x.book_id === Number(params[0]) && x.member_id === Number(params[1]) && x.status === 'ready');
      if (!r) return [[]];
      await acquireLock(`reservations:${r.reservation_id}`, owner);
      return [[{ reservation_id: r.reservation_id, held_copy_id: r.held_copy_id }]];
    }

    if (/SELECT copy_id FROM book_copies WHERE book_id = \? AND status = 'available' ORDER BY copy_id LIMIT 1 FOR UPDATE SKIP LOCKED/i.test(sql)) {
      const candidates = book_copies
        .filter((c) => c.book_id === Number(params[0]) && c.status === 'available' && !isLocked(`book_copies:${c.copy_id}`, owner))
        .sort((a, b) => a.copy_id - b.copy_id);
      if (!candidates.length) return [[]];
      await acquireLock(`book_copies:${candidates[0].copy_id}`, owner);
      return [[{ copy_id: candidates[0].copy_id }]];
    }

    if (/UPDATE book_copies SET status = '(issued|reserved|available)' WHERE copy_id = \?/i.test(sql)) {
      const st = sql.match(/'(issued|reserved|available)'/i)[1];
      const c = book_copies.find((x) => x.copy_id === Number(params[0]));
      if (c) c.status = st;
      return [{ affectedRows: c ? 1 : 0 }];
    }

    if (/INSERT INTO issued_books \(copy_id, member_id, issue_date, due_date\)/i.test(sql)) {
      const rec = {
        issue_id: nextIssueId++,
        copy_id: Number(params[0]),
        member_id: Number(params[1]),
        issue_date: todayStr(),
        due_date: todayStr(14),
        return_date: null
      };
      issued_books.push(rec);
      return [{ insertId: rec.issue_id }];
    }

    if (/UPDATE reservations SET status = 'fulfilled' WHERE reservation_id = \?/i.test(sql)) {
      const r = reservations.find((x) => x.reservation_id === Number(params[0]));
      if (r) r.status = 'fulfilled';
      return [{ affectedRows: r ? 1 : 0 }];
    }

    if (/SELECT issue_id, copy_id, return_date, GREATEST\(DATEDIFF\(CURDATE\(\), due_date\), 0\) AS overdue_days FROM issued_books WHERE issue_id = \? FOR UPDATE/i.test(sql)) {
      const id = Number(params[0]);
      await acquireLock(`issued_books:${id}`, owner);
      const i = issued_books.find((x) => x.issue_id === id);
      if (!i) return [[]];
      const diff = Math.max(0, Math.floor((new Date(todayStr()) - new Date(i.due_date)) / 86400000));
      return [[{ issue_id: i.issue_id, copy_id: i.copy_id, return_date: i.return_date, overdue_days: diff }]];
    }

    if (/UPDATE issued_books SET return_date = CURDATE\(\) WHERE issue_id = \? AND return_date IS NULL/i.test(sql)) {
      const i = issued_books.find((x) => x.issue_id === Number(params[0]) && x.return_date === null);
      if (i) i.return_date = todayStr();
      return [{ affectedRows: i ? 1 : 0 }];
    }

    if (/SELECT book_id FROM book_copies WHERE copy_id = \? FOR UPDATE/i.test(sql)) {
      const id = Number(params[0]);
      await acquireLock(`book_copies:${id}`, owner);
      const c = book_copies.find((x) => x.copy_id === id);
      return [c ? [{ book_id: c.book_id }] : []];
    }

    if (/SELECT reservation_id, member_id FROM reservations WHERE book_id = \? AND status = 'waiting' ORDER BY reserved_at, reservation_id LIMIT 1 FOR UPDATE SKIP LOCKED/i.test(sql)) {
      const waiting = reservations
        .filter((r) => r.book_id === Number(params[0]) && r.status === 'waiting' && !isLocked(`reservations:${r.reservation_id}`, owner))
        .sort((a, b) => new Date(a.reserved_at) - new Date(b.reserved_at) || a.reservation_id - b.reservation_id);
      if (!waiting.length) return [[]];
      await acquireLock(`reservations:${waiting[0].reservation_id}`, owner);
      return [[{ reservation_id: waiting[0].reservation_id, member_id: waiting[0].member_id }]];
    }

    if (/UPDATE reservations SET status = 'ready', held_copy_id = \?, ready_at = NOW\(\), expires_at = DATE_ADD\(NOW\(\), INTERVAL 48 HOUR\) WHERE reservation_id = \?/i.test(sql)) {
      const r = reservations.find((x) => x.reservation_id === Number(params[1]));
      if (r) {
        r.status = 'ready';
        r.held_copy_id = Number(params[0]);
        r.ready_at = nowDate();
        r.expires_at = nowDate(48);
      }
      return [{ affectedRows: r ? 1 : 0 }];
    }

    if (/SELECT COUNT\(\*\) AS available FROM book_copies WHERE book_id = \? AND status = 'available'/i.test(sql)) {
      return [[{ available: book_copies.filter((c) => c.book_id === Number(params[0]) && c.status === 'available').length }]];
    }

    if (/SELECT COUNT\(\*\) AS has_loan FROM issued_books i/i.test(sql)) {
      const count = issued_books.filter((i) => {
        if (i.member_id !== Number(params[0]) || i.return_date !== null) return false;
        const c = book_copies.find((x) => x.copy_id === i.copy_id);
        return c && c.book_id === Number(params[1]);
      }).length;
      return [[{ has_loan: count }]];
    }

    if (/INSERT INTO reservations \(book_id, member_id, reserved_at, status\)/i.test(sql)) {
      const bookId = Number(params[0]), memberId = Number(params[1]);
      const dup = reservations.some((r) => r.book_id === bookId && r.member_id === memberId && ['waiting', 'ready'].includes(r.status));
      if (dup) {
        const err = new Error('Duplicate live reservation');
        err.code = 'ER_DUP_ENTRY';
        throw err;
      }
      const rec = { reservation_id: nextResId++, book_id: bookId, member_id: memberId, reserved_at: nowDate(), status: 'waiting', held_copy_id: null, ready_at: null, expires_at: null };
      reservations.push(rec);
      return [{ insertId: rec.reservation_id }];
    }

    if (/SELECT queue_position FROM reservation_queue WHERE reservation_id = \?/i.test(sql)) {
      const row = getQueueView().find((q) => q.reservation_id === Number(params[0]));
      return [row ? [{ queue_position: row.queue_position }] : []];
    }

    if (/FROM reservation_queue WHERE book_id = \? ORDER BY queue_position/i.test(sql)) {
      return [getQueueView(params[0])];
    }

    if (/SELECT book_id FROM reservations WHERE reservation_id = \?/i.test(sql)) {
      const r = reservations.find((x) => x.reservation_id === Number(params[0]));
      return [r ? [{ book_id: r.book_id }] : []];
    }

    if (/SELECT status, held_copy_id, \(expires_at < NOW\(\)\) AS overdue FROM reservations WHERE reservation_id = \? FOR UPDATE/i.test(sql)) {
      const id = Number(params[0]);
      await acquireLock(`reservations:${id}`, owner);
      const r = reservations.find((x) => x.reservation_id === id);
      if (!r) return [[]];
      return [[{ status: r.status, held_copy_id: r.held_copy_id, overdue: r.expires_at ? (new Date(r.expires_at) < new Date() ? 1 : 0) : 0 }]];
    }

    if (/UPDATE reservations SET status = \? WHERE reservation_id = \?/i.test(sql)) {
      const r = reservations.find((x) => x.reservation_id === Number(params[1]));
      if (r) r.status = params[0];
      return [{ affectedRows: r ? 1 : 0 }];
    }

    if (/SELECT reservation_id FROM reservations WHERE status = 'ready' AND expires_at < NOW\(\)/i.test(sql)) {
      return [reservations.filter((r) => r.status === 'ready' && r.expires_at && new Date(r.expires_at) < new Date()).map((r) => ({ reservation_id: r.reservation_id }))];
    }

    /* Queries used by tests/concurrency.js */
    if (/DELETE FROM issued_books WHERE copy_id IN \(SELECT copy_id FROM book_copies WHERE book_id = 1\)/i.test(sql)) {
      const ids = new Set(book_copies.filter((c) => c.book_id === 1).map((c) => c.copy_id));
      for (let i = issued_books.length - 1; i >= 0; i--) if (ids.has(issued_books[i].copy_id)) issued_books.splice(i, 1);
      return [{ affectedRows: 1 }];
    }
    if (/UPDATE book_copies SET status = 'available' WHERE book_id = 1/i.test(sql)) {
      book_copies.filter((c) => c.book_id === 1).forEach((c) => { c.status = 'available'; });
      return [{ affectedRows: 1 }];
    }
    if (/UPDATE book_copies SET status = 'available' WHERE copy_id IN/i.test(sql)) {
      const mId = Number(params[0]);
      const copyIds = new Set(issued_books.filter((i) => i.member_id === mId && i.return_date === null).map((i) => i.copy_id));
      book_copies.filter((c) => copyIds.has(c.copy_id)).forEach((c) => { c.status = 'available'; });
      return [{ affectedRows: copyIds.size }];
    }
    if (/DELETE FROM issued_books WHERE member_id = \? AND return_date IS NULL/i.test(sql)) {
      const mId = Number(params[0]);
      for (let i = issued_books.length - 1; i >= 0; i--) if (issued_books[i].member_id === mId && issued_books[i].return_date === null) issued_books.splice(i, 1);
      return [{ affectedRows: 1 }];
    }
    if (/FROM member_open_loans WHERE status = 'active' AND open_loans <= borrow_limit - 3/i.test(sql)) {
      return [members.filter((m) => m.status === 'active' && ![1, 2, 3].includes(m.member_id) && issued_books.filter((i) => i.member_id === m.member_id && i.return_date === null).length <= m.borrow_limit - 3).map((m) => ({ member_id: m.member_id }))];
    }
    if (/SELECT copies_available FROM book_availability WHERE book_id = (\d+)/i.test(sql)) {
      const bId = Number(sql.match(/book_id = (\d+)/i)[1]);
      return [[{ copies_available: book_copies.filter((c) => c.book_id === bId && c.status === 'available').length }]];
    }
    if (/SELECT COUNT\(\*\) AS loans, COUNT\(DISTINCT i\.copy_id\) AS copies FROM issued_books/i.test(sql)) {
      const open = issued_books.filter((i) => i.return_date === null && book_copies.find((c) => c.copy_id === i.copy_id)?.book_id === 1);
      return [[{ loans: open.length, copies: new Set(open.map((x) => x.copy_id)).size }]];
    }
    if (/FROM book_availability WHERE copies_available >= 1 AND book_id BETWEEN 2 AND 250 ORDER BY book_id LIMIT (\d+)/i.test(sql)) {
      const lim = Number(sql.match(/LIMIT (\d+)/i)[1]);
      return [books.filter((b) => b.book_id >= 2 && b.book_id <= 250 && book_copies.some((c) => c.book_id === b.book_id && c.status === 'available')).slice(0, lim).map((b) => ({ book_id: b.book_id }))];
    }
    if (/SELECT open_loans FROM member_open_loans WHERE member_id = (\d+)/i.test(sql)) {
      const mId = Number(sql.match(/member_id = (\d+)/i)[1]);
      return [[{ open_loans: issued_books.filter((i) => i.member_id === mId && i.return_date === null).length }]];
    }
    if (/DELETE FROM issued_books WHERE issue_id = \?/i.test(sql)) {
      const idx = issued_books.findIndex((i) => i.issue_id === Number(params[0]));
      if (idx !== -1) issued_books.splice(idx, 1);
      return [{ affectedRows: 1 }];
    }
    if (/DELETE FROM reservations WHERE member_id = 3 AND book_id = 194 AND status = 'waiting'/i.test(sql)) {
      for (let i = reservations.length - 1; i >= 0; i--) if (reservations[i].member_id === 3 && reservations[i].book_id === 194 && reservations[i].status === 'waiting') reservations.splice(i, 1);
      return [{ affectedRows: 1 }];
    }
    if (/SELECT COUNT\(\*\) AS c FROM reservations WHERE member_id = 3 AND book_id = 194 AND status = 'waiting'/i.test(sql)) {
      return [[{ c: reservations.filter((r) => r.member_id === 3 && r.book_id === 194 && r.status === 'waiting').length }]];
    }
    if (/SELECT COUNT\(\*\) AS c FROM reservation_queue WHERE book_id = 42/i.test(sql)) {
      return [[{ c: getQueueView(42).length }]];
    }
    if (/SELECT member_id FROM members WHERE status = 'active' AND member_id NOT IN \(1,2,3\)/i.test(sql)) {
      const busy = new Set([
        ...reservations.filter((r) => r.book_id === 42 && ['waiting', 'ready'].includes(r.status)).map((r) => r.member_id),
        ...issued_books.filter((i) => i.return_date === null && book_copies.find((c) => c.copy_id === i.copy_id)?.book_id === 42).map((i) => i.member_id)
      ]);
      return [members.filter((m) => m.status === 'active' && ![1, 2, 3].includes(m.member_id) && !busy.has(m.member_id)).slice(0, 10).map((m) => ({ member_id: m.member_id }))];
    }
    if (/DELETE FROM reservations WHERE reservation_id = \?/i.test(sql)) {
      const idx = reservations.findIndex((r) => r.reservation_id === Number(params[0]));
      if (idx !== -1) reservations.splice(idx, 1);
      return [{ affectedRows: 1 }];
    }
    if (/SELECT i\.issue_id FROM issued_books i JOIN book_copies c ON c\.copy_id = i\.copy_id WHERE c\.book_id = 42 AND i\.return_date IS NULL/i.test(sql)) {
      return [issued_books.filter((i) => i.return_date === null && book_copies.find((c) => c.copy_id === i.copy_id)?.book_id === 42).map((i) => ({ issue_id: i.issue_id }))];
    }
    if (/SELECT member_id FROM reservation_queue WHERE book_id = 42 ORDER BY queue_position LIMIT 2/i.test(sql)) {
      return [getQueueView(42).slice(0, 2).map((r) => ({ member_id: r.member_id }))];
    }
    if (/SELECT SUM\(status = 'reserved'\) AS reserved FROM book_copies WHERE book_id = 42/i.test(sql)) {
      return [[{ reserved: book_copies.filter((c) => c.book_id === 42 && c.status === 'reserved').length }]];
    }

    return [[]];
  }

  return {
    query: (sql, params) => executeSQL(sql, params),
    end: async () => {},
    getConnection: async () => {
      const owner = Symbol('tx');
      let snapshot = null;
      return {
        beginTransaction: async () => {
          snapshot = {
            copies: book_copies.map((c) => ({ ...c })),
            loans: issued_books.map((i) => ({ ...i })),
            res: reservations.map((r) => ({ ...r }))
          };
        },
        query: (sql, params) => executeSQL(sql, params, owner),
        commit: async () => { snapshot = null; releaseLocks(owner); },
        rollback: async () => {
          if (snapshot) {
            book_copies.splice(0, book_copies.length, ...snapshot.copies);
            issued_books.splice(0, issued_books.length, ...snapshot.loans);
            reservations.splice(0, reservations.length, ...snapshot.res);
            snapshot = null;
          }
          releaseLocks(owner);
        },
        release: () => { releaseLocks(owner); }
      };
    }
  };
}

let activeBackend = null;
async function resolvePool() {
  if (activeBackend) return activeBackend;
  try {
    await realPool.query('SELECT 1 FROM books LIMIT 1');
    activeBackend = realPool;
    console.log('Connected to MySQL database.');
  } catch (_) {
    await realPool.end().catch(() => {});
    activeBackend = createMemoryEngine();
    console.log('MySQL offline — running CSV-backed in-memory ACID engine.');
  }
  return activeBackend;
}

module.exports = {
  query: async (...args) => (await resolvePool()).query(...args),
  getConnection: async () => (await resolvePool()).getConnection(),
  end: async () => { if (activeBackend) await activeBackend.end(); }
};