// Runs the review page against the local server (local/server.py): loads the PR data, stands in for the
// claude.ai capabilities the page uses (db, comments), then loads the page code. The GitHub connector is
// absent here: everything the page would ask it is done by the server, which runs git and gh on this machine.
(async function () {
  const status = document.getElementById('loadstatus');
  const say = t => { if (status) status.textContent = t; };
  const api = async (path, body) => {
    const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-review': '1' }, body: JSON.stringify(body) });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
    if (!r.ok) throw Object.assign(new Error((j && j.error) || t || String(r.status)), { code: (j && j.code) || 'upstream_error' });
    return j;
  };
  let review;
  try { review = await api('api/review'); } catch (e) { say('Could not load the review: ' + e.message); return; }

  // ---- db: the page's three collections, kept by the server; long-polled so Claude's writes show up at once.
  const COLS = ['comments', 'threads', 'changes'];
  let state = { version: -1, docs: {}, reviewVersion: review.reviewVersion };
  const subs = Object.fromEntries(COLS.map(c => [c, new Set()]));
  const snap = col => ({ docs: Object.entries(state.docs[col] || {}).map(([id, d]) => ({ id, exists: true, data: () => d })) });
  function apply(next) {
    if (!next || next.version <= state.version) return;
    if (next.reviewVersion !== review.reviewVersion) { location.reload(); return; } // a new PR head: reload its data
    const prev = state.docs; state = next;
    COLS.forEach(c => { if (JSON.stringify(prev[c] || {}) !== JSON.stringify(next.docs[c] || {})) subs[c].forEach(fn => fn(snap(c))); });
  }
  async function poll() {
    for (;;) {
      try { apply(await api('api/db?since=' + state.version)); }
      catch (e) { say('Lost the local review server: ' + e.message); if (status) status.hidden = false; await new Promise(r => setTimeout(r, 3000)); }
    }
  }
  const write = (op, col, id, data) => api('api/db', { op, col, id, data }).then(apply);
  const db = Object.freeze({
    collection: col => Object.freeze({
      doc: id => Object.freeze({ set: d => write('set', col, id, d), update: d => write('update', col, id, d), delete: () => write('delete', col, id) }),
      onSnapshot(fn, err) { subs[col].add(fn); if (state.version >= 0) setTimeout(() => fn(snap(col)), 0); return () => subs[col].delete(fn); },
    }),
  });
  try { apply(await api('api/db?since=-1')); } catch (e) { say('Could not load the review store: ' + e.message); return; }
  poll();

  // ---- comments: only used to notify Claude. The server runs mechanical requests itself and queues the rest for Claude.
  const comments = Object.freeze({
    anchorFor: el => ({ element: el && el.id || null }),
    sendToClaude: ({ threadId, text }) => api('api/claude', { threadId: threadId || null, text }),
  });

  const caps = { db, comments };
  window.claude = Object.freeze({ use: name => new Promise(res => setTimeout(() => res(caps[name] || null), 0)) });
  window.REVIEW = review;
  const s = document.createElement('script'); s.src = 'app.js?v=' + encodeURIComponent(review.appVersion || '');
  s.onerror = () => say('Could not load the page code.');
  document.body.appendChild(s);
})();
