// The review page. loader.js fills window.REVIEW and then loads this file.
(function () {
  const R = window.REVIEW; // filled before this file runs: by loader.js from the local server, or inline by build.py
  const COMMITS = R.commits;
  { const slug = '[' + R.cfg.repo + '#' + R.cfg.pr + '] ', who = R.pr.title + ' (by ' + R.pr.author + ')', h = document.getElementById('prtitle');
    document.title = slug + who; h.textContent = slug; const s = document.createElement('span'); s.textContent = who; h.appendChild(s);
    const l = document.getElementById('loadstatus'); if (l) l.remove(); }
  // Other reviewers' threads (anchored to the PR commit that last changed their line) and the PR conversation, snapshotted at build time.
  const GH = R.gh;
  // GitHub's bodyHTML is already sanitized; strip anything active again before rendering it.
  function cleanHTML(html) {
    const doc = new DOMParser().parseFromString('<div>' + (html || '') + '</div>', 'text/html');
    doc.querySelectorAll('script, style, iframe, object, embed, form, input, button, link, meta').forEach(n => n.remove());
    doc.querySelectorAll('*').forEach(n => Array.from(n.attributes).forEach(a => { if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name); }));
    // The page cannot load external images (badges, camo-proxied icons): show their alt text instead, drop decorative ones.
    doc.querySelectorAll('picture source').forEach(n => n.remove());
    doc.querySelectorAll('img').forEach(img => {
      if (/^data:/i.test(img.getAttribute('src') || '')) return;
      const alt = (img.getAttribute('alt') || '').trim();
      if (!alt) { img.remove(); return; }
      const s = doc.createElement('span'); s.className = 'imgalt'; s.textContent = alt; img.replaceWith(s);
    });
    doc.querySelectorAll('picture, themed-picture').forEach(n => { if (!n.textContent.trim() && !n.querySelector('img')) n.remove(); });
    doc.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
    return doc.body.firstChild.innerHTML;
  }
  const isReply = x => !!(x.replyTo || x.replyToConv);
  const ghOpen = new Set(), ghClosed = new Set(); // per-view expand state of reviewer threads, kept across re-renders
  function ghThreadCard(t) {
    const d = document.createElement('details'); d.className = 'ghthread'; d.id = 'ghs-' + t.id;
    d.open = ghOpen.has(t.id) || (!t.resolved && !ghClosed.has(t.id)) || !!(openComposer && openComposer.replyTo === t.id);
    d.addEventListener('toggle', () => { if (d.open) { ghOpen.add(t.id); ghClosed.delete(t.id); } else { ghOpen.delete(t.id); ghClosed.add(t.id); } });
    const pills = (t.resolved ? '<span class="pill rejected">resolved</span>' : t.resolved === false ? '<span class="pill proposed">open</span>' : '') + (t.outdated ? '<span class="pill rejected">outdated</span>' : '');
    const first = t.comments[0];
    d.innerHTML = '<summary class="card-head"><b>' + esc(first.author) + '</b>' + pills + '<span>' + t.comments.length + ' comment' + (t.comments.length > 1 ? 's' : '') + ' · GitHub ' + esc(t.ghPath) + (t.ghLine ? ':' + t.ghLine : '') + '</span><a href="' + esc(first.url) + '" target="_blank" rel="noopener">open on GitHub</a></summary>' +
      t.comments.map(c => '<div class="ghc"><div class="ghwho"><b>' + esc(c.author) + '</b> <span>' + esc((c.at || '').slice(0, 10)) + '</span></div><div class="ghbody">' + cleanHTML(c.html) + '</div></div>').join('');
    Object.values(comments).filter(x => x.replyTo === t.id || (x.replyTo && x.replyToCommentId && x.replyToCommentId === t.rootCommentId)).forEach(x => d.appendChild(card(x)));
    aboutChats(t.id, d).forEach(x => d.appendChild(x));
    if (openAsk && openAsk.about === t.id) d.open = true;
    if (openComposer && openComposer.replyTo === t.id) d.appendChild(composer(openComposer));
    else {
      const b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'Reply (queue to your GitHub draft)';
      b.onclick = () => { openComposer = { commit: t.commit, commitIdx: current, path: t.path, line: t.line, side: t.side, replyTo: t.id }; editing = null; renderAll(); };
      const row = document.createElement('div'); row.className = 'actions'; row.appendChild(b); d.appendChild(row);
    }
    return d;
  }
  function cleanTextOf(h) { const d = document.createElement('div'); d.innerHTML = cleanHTML(h || ''); return (d.textContent || '').replace(/\s+/g, ' ').trim(); }
  function ghAt(sha, path, refs) { return GH.threads.filter(t => t.commit === sha && t.path === path && (refs ? refs.some(r => t.line === r.line && t.side === r.side) : !t.line)); }
  const SESSION_URL = R.cfg.session || ''; // the Claude Code session answering this page, if known
  { const a = document.getElementById('sessionlink'); if (a && /^https:\/\/claude\.ai\/code\//.test(SESSION_URL)) { a.href = SESSION_URL; a.hidden = false; } }
  const PR_MINE = R.mine; // the viewer authored the PR: change requests edit and commit locally instead of suggesting
  const REPO_SLUG = R.cfg.repo, PR_NUMBER = R.cfg.pr, REPO = 'https://github.com/' + REPO_SLUG;
  // Submitting goes straight to GitHub through the viewer's GitHub connector; Claude is the fallback.
  const GH_SERVER = 'Github CoPilot'; let mcp = null;
  const COLLAPSED_DEFAULT = new Set(R.cfg.collapsed || ['Cargo.lock', 'package-lock.json', 'yarn.lock', 'go.sum']);
  let db = null, dbReady = false;
  const cmReady = window.claude && window.claude.use ? window.claude.use('comments') : Promise.resolve(null);
  let cm = null;               // comments capability: used only to notify Claude's session; the conversation itself lives in the db
  let threads = {};            // id -> question thread (db collection "threads")
  let changes = {};            // id -> code change Claude proposes (db collection "changes", never in "comments": the GitHub sync reconciles those)
  let openAsk = null;          // {commit, commitIdx, path, line, side} for the in-page "Ask Claude" composer
  let sending = false;

  let showDismissed = lsGet('showdismissed') === '1'; // answered conversations the viewer dismissed stay hidden unless asked for
  const visibleThread = t => showDismissed || !t.dismissed;
  function threadsAt(sha, path, refs) { return Object.values(threads).filter(t => visibleThread(t) && t.kind !== 'feedback' && !t.about && t.commit === sha && t.path === path && (!refs || refs.some(r => t.line === r.line && (t.side || 'RIGHT') === r.side))); }
  async function writeThread(id, data, isNew) {
    if (!db) { toast('Store unavailable'); return false; }
    try { if (isNew) await db.collection('threads').doc(id).set(data); else await db.collection('threads').doc(id).update(data); return true; }
    catch (e) { toast('Could not save: ' + (e && e.code || 'error')); return false; }
  }
  // Notify Claude's session through a shell comment; the id in the text lets Claude find the db thread.
  // A send that may have gone through (no receipt in time) is not reported as failed; notifyErr holds only definite failures.
  const DEFINITE = ['consent_required', 'claude_unavailable', 'not_granted', 'capability_disabled', 'capability_removed', 'forbidden', 'invalid', 'rate_limited'];
  let notifyErr = null;
  // The automatic reply sees only this text, so name the file, line and code the request is about.
  function whereText(t, el) {
    if (!t.path) return '';
    const row = el && el.closest && el.closest('tr'), cells = row ? Array.from(row.querySelectorAll('td.code:not(.empty)')) : [];
    const code = cells.length ? cells[cells.length - 1].textContent.replace(/^[+−\s]+/, '').trim().slice(0, 200) : '';
    return '\n\n(on ' + t.path + lineLabel(t) + (code && !t.startLine ? ': `' + code + '`' : '') + ')';
  }
  async function notifyClaude(t, text, el, kind) {
    notifyErr = null;
    if (!cm) cm = await cmReady;
    if (!cm) { notifyErr = 'not_granted'; return null; }
    try {
      if (t.shellThreadId) { await cm.sendToClaude({ threadId: t.shellThreadId, text }); return t.shellThreadId; }
      // A re-render (a revision note closes its box first) can detach el; anchor to the card or thread that replaced it.
      if (!el || !el.isConnected) el = document.getElementById('cds-' + t.id) || document.getElementById('chg-' + t.id) || (t.about && (document.getElementById('cds-' + t.about) || document.getElementById('ghs-' + t.about))) || document.getElementById('commit');
      const anchor = await cm.anchorFor(el);
      const r = await cm.sendToClaude({ anchor, text: '[' + (kind || 'page question') + ' ' + t.id + '] ' + text + whereText(t, el) });
      return r.threadId;
    } catch (e) {
      const code = e && e.code; notifyErr = DEFINITE.includes(code) ? code : null;
      if (!notifyErr) { toast('Sent to Claude (no receipt yet)'); return null; }
      if (code === 'consent_required') toast('Saved. Allow commenting when asked so Claude gets notified');
      else if (code === 'claude_unavailable' || code === 'not_granted') toast('Saved. Tell Claude in chat to answer page questions');
      else toast('Saved, but Claude was not notified (' + (code || 'error') + ')');
      return null;
    }
  }
  async function sendQuestion(anchor, text, el) {
    if (sending) return; sending = true;
    const id = 'q_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const t = { id, kind: anchor.kind || 'question', commit: anchor.commit, path: anchor.path || null, line: anchor.line || null, startLine: anchor.startLine || null, side: anchor.side || null, about: anchor.about || null, onChange: anchor.onChange || null, newLine: anchor.newLine || null, newStart: anchor.newStart != null ? anchor.newStart : null, newEnd: anchor.newEnd != null ? anchor.newEnd : null, status: 'asked', messages: [{ role: 'user', text, at: new Date().toISOString() }], createdAt: new Date().toISOString() };
    const aboutNote = (anchor.aboutText ? '\n\n(about the comment: "' + anchor.aboutText.replace(/\s+/g, ' ').trim().slice(0, 300) + '")' : '')
      + (anchor.onChange ? '\n\n(on ' + (anchor.newEnd != null && anchor.newEnd > anchor.newStart ? 'lines ' + (anchor.newStart + 1) + '-' + (anchor.newEnd + 1) : anchor.newStart != null ? 'line ' + (anchor.newStart + 1) : 'a line') + ' of the new lines accepted change ' + anchor.onChange + ' wrote, only on the review branch: "' + String(anchor.newLine || '').trim().slice(0, 600) + '")' : '');
    const shellThreadId = await notifyClaude(t, text + aboutNote, el, t.kind === 'modify' ? 'modify request' : t.kind === 'feedback' ? 'feedback request' : 'page question');
    const ok = await writeThread(id, Object.assign({}, t, { shellThreadId, notifyError: shellThreadId ? null : notifyErr }), true);
    sending = false;
    if (ok) {
      dropDraft(t.kind === 'feedback' ? 'fb' : 'a|' + draftKey(anchor)); openAsk = null; renderAll(); toast(shellThreadId || !notifyErr ? 'Sent to Claude' : 'Question saved');
      // The feedback panel keeps unsent drafts across re-renders; a sent message must not come back.
      if (t.kind === 'feedback') { const ta = document.querySelector('#fb-panel #ask-ta'); if (ta) ta.value = ''; renderFeedback(); }
    }
  }
  async function sendFollowUp(t, text, el) {
    if (sending) return; sending = true;
    const shellThreadId = await notifyClaude(t, text, el);
    const messages = (t.messages || []).concat([{ role: 'user', text, at: new Date().toISOString() }]);
    const ok = await writeThread(t.id, { messages, status: 'asked', dismissed: false, shellThreadId: shellThreadId || t.shellThreadId || null, notifyError: shellThreadId || t.shellThreadId ? null : notifyErr, updatedAt: new Date().toISOString() }, false);
    sending = false;
    if (ok) { dropDraft('fu-' + t.id); toast(shellThreadId || !notifyErr ? 'Sent to Claude' : 'Follow-up saved'); }
  }
  function askComposer(anchor, el) {
    if (anchor.kind !== 'feedback') noteDraftAt('a|' + draftKey(anchor), anchor);
    const d = document.createElement('div'); d.className = 'composer'; d.style.borderColor = 'var(--posted)';
    const where = anchor.path ? anchor.path + lineLabel(anchor) : 'commit ' + COMMITS[anchor.commitIdx].short;
    const mod = anchor.kind === 'modify', fb = anchor.kind === 'feedback';
    const hint = fb ? 'Claude writes it up and files an issue on <a href="https://github.com/' + FEEDBACK_REPO + '" target="_blank" rel="noopener">' + FEEDBACK_REPO + '</a>, then replies here with the issue link' : mod ? 'Ask Claude to change · ' + esc(where) + ' · ' + (PR_MINE ? 'Claude proposes the change as a card; Accept folds it into the commit and pushes the review branch to your fork' : 'Claude proposes the change as a card; Accept queues it as a GitHub suggestion') : 'Ask Claude · ' + esc(where) + ' · the question and answer stay here on the page';
    d.innerHTML = '<div class="hint">' + hint + '</div><textarea id="ask-ta" data-draft="' + (fb ? 'fb' : 'a|' + esc(draftKey(anchor))) + '" placeholder="' + (fb ? 'What bothers you about the tool, or what is missing?' : mod ? (anchor.path ? 'What should change here?' : 'Reword the message, drop the commit, or rework it as a whole?') : 'What do you want to know about this code?') + '"></textarea><div class="actions"><button class="btn primary small" id="ask-send">' + (fb ? 'Send to Claude' : mod ? 'Ask Claude to change it' : 'Ask Claude') + '</button><button class="btn small" id="ask-cancel">Cancel</button></div>';
    if (mod) d.style.borderColor = 'var(--proposed)';
    d.querySelector('#ask-send').onclick = () => { const v = d.querySelector('#ask-ta').value.trim(); if (v) sendQuestion(anchor, v, el); };
    d.querySelector('#ask-cancel').onclick = () => { dropDraft(fb ? 'fb' : 'a|' + draftKey(anchor)); openAsk = null; renderAll(); };
    if (!fb) setTimeout(() => { const t = d.querySelector('#ask-ta'); if (t) t.focus(); }, 0);
    return d;
  }
  function threadCard(t, el) {
    const d = document.createElement('div'); d.className = 'chat'; d.id = 'chs-' + t.id;
    const msgs = (t.messages || []).map(m => '<div class="msg-row ' + m.role + '"><span class="who">' + (m.role === 'claude' ? 'Claude' : 'You') + '</span><div class="body">' + md(m.text) + '</div></div>').join('');
    const pending = t.status === 'asked' ? '<div class="pending">Waiting for Claude' + WAIT_DOTS + (t.shellThreadId || !t.notifyError ? '' : ' (not notified: tell Claude in chat to answer page questions)') + '</div>' : '';
    d.innerHTML = '<div class="card-head"><b>' + (t.kind === 'modify' ? 'Change request to Claude' : t.kind === 'feedback' ? 'Feedback on the tool' : 'Conversation with Claude') + '</b>' + (t.path || t.kind === 'feedback' ? '' : '<span>commit-level</span>') + (t.dismissed ? '<span class="pill rejected">dismissed</span><button class="btn small dismiss" data-act="restore">Restore</button>' : t.status === 'answered' ? '<button class="btn small dismiss" data-act="dismiss" title="Hide this answered conversation; it can be restored from the queue">Dismiss</button>' : '') + '</div>' + msgs + pending + (t.commentId && comments[t.commentId] ? '<div class="made"><button class="btn small" data-act="gocomment">Go to the comment Claude drafted</button></div>' : '') + (t.changeId && changes[t.changeId] && changes[t.changeId].status !== 'landed' ? '<div class="made"><button class="btn small" data-act="gochange">Go to the proposed change</button></div>' : '') + '<div class="followup"><textarea id="fu-' + t.id + '" placeholder="Follow up"></textarea><button class="btn small ask" data-act="followup">Send</button></div>';
    const gc = d.querySelector('[data-act="gocomment"]'); if (gc) gc.onclick = () => { const el = document.getElementById('cds-' + t.commentId); if (el) { setCursor(el, false); el.scrollIntoView({ block: 'center' }); flashRow(el); } };
    const gch = d.querySelector('[data-act="gochange"]'); if (gch) gch.onclick = () => jumpTo(changes[t.changeId].commit, 'chg-' + t.changeId);
    d.querySelector('[data-act="followup"]').onclick = () => { const ta = d.querySelector('#fu-' + t.id); const v = ta.value.trim(); if (v) sendFollowUp(t, v, el); };
    const dm = d.querySelector('[data-act="dismiss"], [data-act="restore"]');
    if (dm) dm.onclick = () => writeThread(t.id, { dismissed: dm.dataset.act === 'dismiss', updatedAt: new Date().toISOString() }, false);
    return d;
  }
  // Conversations started with i on a comment are drawn inside that comment, with the composer when it is open.
  function aboutChats(id, el) {
    const out = Object.values(threads).filter(t => t.about === id && visibleThread(t)).map(t => threadCard(t, el));
    if (openAsk && openAsk.about === id) out.push(askComposer(openAsk, el));
    return out;
  }
  // A line an accepted change wrote exists only on the review branch: ? and ✎ (and i / m) on it ask Claude about exactly
  // that line, or a range of that change's lines, anchored at the change and the indexes of its new lines.
  const isOvRow = (r, side) => !!r && !!r.dataset && !!r.dataset.chg && !!changes[r.dataset.chg] && (r.matches('tr.ovnew.done') || (r.classList.contains('ovfill') && side === 'RIGHT'));
  function askOverlay(x, rows, kind) {
    const rs = rows.slice().sort((a, b) => +a.dataset.ovi - +b.dataset.ovi), lo = +rs[0].dataset.ovi, hi = +rs[rs.length - 1].dataset.ovi;
    askAbout({ commit: x.commit, commitIdx: current, path: x.path, line: x.line, startLine: x.startLine || null, side: 'RIGHT', kind, onChange: x.id, newStart: lo, newEnd: hi, newLine: rs.map(r => r.dataset.nl).join('\n') });
  }
  // Shift+click on an overlay line's button: the range from the cursor's line, when both are new lines of the same change.
  function ovRangeTo(tr) {
    const cur = lineOf(current_()); if (!isOvRow(cur, 'RIGHT') || cur.dataset.chg !== tr.dataset.chg || cur === tr) return null;
    const all = Array.from(tr.closest('tbody').querySelectorAll('tr')).filter(r => isOvRow(r, 'RIGHT') && r.dataset.chg === tr.dataset.chg), i = all.indexOf(cur), k = all.indexOf(tr);
    return i < 0 || k < 0 ? null : all.slice(Math.min(i, k), Math.max(i, k) + 1);
  }
  function askAbout(anchor) { openAsk = anchor; openComposer = null; editing = null; renderAll(); setTimeout(() => { const t = document.getElementById('ask-ta'); if (t) t.scrollIntoView({ block: 'center' }); }, 0); }
  let comments = {};           // id -> doc
  let current = 0;             // commit index
  let openComposer = null;     // {commit, path, line, side} or {commit} for general
  let editing = null;          // comment id being edited
  const expanded = {}; // "<sha>:<path>" -> { gapIndex: { top, bot } } lines revealed around each hunk gap
  let viewMode = (function () { const v = lsGet('viewmode'); return v === 'unified' ? 'unified' : 'split'; })();

  // ---------- helpers ----------
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function md(s) {
    // minimal: fenced code, inline code, line breaks
    let out = '', parts = String(s).split(/```/);
    // Inline: `code`, [text](https://...), bare http(s) links (clickable, new tab) and **bold**; code spans are left alone.
    const link = (href, text) => '<a href="' + href + '" target="_blank" rel="noopener">' + text + '</a>';
    const inline = t => esc(t).split(/(`[^`]+`)/).map((seg, j) => (j % 2) ? '<code>' + seg.slice(1, -1) + '</code>' : seg
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/(?:(?!&quot;|&#39;)[^\s<])+)/g, (m0, text, href, bare) => {
        if (!bare) return link(href, text);
        const tail = bare.match(/[.,;:!?)\]]+$/), u = tail ? bare.slice(0, -tail[0].length) : bare;
        return link(u, u) + (tail ? tail[0] : '');
      })
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')).join('');
    parts.forEach((p, i) => { out += (i % 2) ? '<pre>' + esc(p.replace(/^\w*\n/, '')) + '</pre>' : inline(p); });
    return out;
  }
  // ---------- syntax highlighting and intra-line change marks ----------
  const LANG = { rs: 'rust', toml: 'ini', lock: 'ini', yml: 'yaml', yaml: 'yaml', md: 'markdown', json: 'json', sh: 'bash' };
  function langOf(path) { const m = /\.([a-z]+)$/i.exec(path); return (m && LANG[m[1].toLowerCase()]) || 'plaintext'; }
  function hl(text, lang) {
    if (!window.hljs || lang === 'plaintext') return esc(text);
    try { return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch (e) { return esc(text); }
  }
  // Wrap the character range [start, end) of the plain text, inside already-highlighted HTML, in <mark class="chg">.
  function markRange(html, start, end) {
    if (end <= start) return html;
    const box = document.createElement('div'); box.innerHTML = html;
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT); const nodes = []; let n; while ((n = walker.nextNode())) nodes.push(n);
    let pos = 0;
    nodes.forEach(node => {
      const len = node.nodeValue.length, a = Math.max(start, pos), b = Math.min(end, pos + len);
      if (a < b) {
        const t = node.nodeValue, before = t.slice(0, a - pos), mid = t.slice(a - pos, b - pos), after = t.slice(b - pos);
        const frag = document.createDocumentFragment();
        if (before) frag.appendChild(document.createTextNode(before));
        const m = document.createElement('mark'); m.className = 'chg'; m.textContent = mid; frag.appendChild(m);
        if (after) frag.appendChild(document.createTextNode(after));
        node.parentNode.replaceChild(frag, node);
      }
      pos += len;
    });
    return box.innerHTML;
  }
  // Common prefix/suffix of two strings; the middle is what changed.
  function changedSpan(x, y) {
    let p = 0; while (p < x.length && p < y.length && x[p] === y[p]) p++;
    let s = 0; while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
    return { x: [p, x.length - s], y: [p, y.length - s] };
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  // Unsent text and open composers survive a page reload; a draft goes away when it is sent or cancelled.
  const draftKey = a => [a.kind || '', a.commit, a.path || '', a.line || '', a.side || '', a.replyTo || '', a.replyToConv || ''].join('|') + (a.about ? '|@' + a.about : '') + (a.onChange ? '|~' + a.onChange + ':' + a.newStart + '-' + a.newEnd : '');
  let drafts = {}; try { drafts = JSON.parse(lsGet('drafts') || '{}') || {}; } catch (e) {}
  const taKey = ta => ta.dataset.draft || ta.id;
  // Each comment or question draft remembers where its composer was, so the queue can reopen it after Esc.
  let draftAt = {}; try { draftAt = JSON.parse(lsGet('draftat') || '{}') || {}; } catch (e) {}
  function noteDraftAt(k, anchor) { draftAt[k] = Object.assign({}, anchor); lsSet('draftat', JSON.stringify(draftAt)); }
  function dropDraft(k) { if (k in drafts) { delete drafts[k]; lsSet('drafts', JSON.stringify(drafts)); } if (k in draftAt) { delete draftAt[k]; lsSet('draftat', JSON.stringify(draftAt)); } }
  function restoreDrafts() { document.querySelectorAll('textarea').forEach(ta => { const k = taKey(ta); if (k && drafts[k] && ta.value !== drafts[k]) ta.value = drafts[k]; }); }
  document.addEventListener('input', e => { const ta = e.target; if (ta.tagName !== 'TEXTAREA' || !taKey(ta)) return; if (ta.value.trim()) drafts[taKey(ta)] = ta.value; else delete drafts[taKey(ta)]; lsSet('drafts', JSON.stringify(drafts)); });
  function saveUi() { lsSet('ui', JSON.stringify({ openComposer, openAsk, editing, fbOpen, subOpen })); }
  function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2200); }
  function newId() { return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }
  function byCommit(sha) { return Object.values(comments).filter(c => c.commit === sha); }
  function fileId(ci, path) { return 'f' + ci + '-' + path.replace(/[^a-zA-Z0-9]/g, '_'); }
  // Row ids double as comment anchors: "commit<n>-<path>-<L|R><line>" so a thread's location is readable.
  function rowId(ci, path, line, side) { return 'commit' + (ci + 1) + '-' + path.replace(/[^a-zA-Z0-9]/g, '_') + '-' + (side === 'LEFT' ? 'L' : 'R') + line; }

  // ---------- db ----------
  async function write(id, data, isNew) {
    if (!db) { toast('Comment store unavailable'); return false; }
    try { if (isNew) await db.collection('comments').doc(id).set(data); else await db.collection('comments').doc(id).update(data); return true; }
    catch (e) { toast('Could not save: ' + (e && e.code || 'error')); return false; }
  }
  // Queued comments mirror the viewer's pending GitHub review; Claude applies each change there when notified.
  function syncGitHub(c, what) {
    const el = document.querySelector('[data-cid="' + c.id + '"]') || document.getElementById('commit');
    notifyClaude({ id: c.id }, what + (c.githubCommentId ? ' (GitHub comment ' + c.githubCommentId + ')' : ''), el, 'github sync');
  }
  const affectsGitHub = (c, status) => c.source !== 'github' && !c.replyToConv && (c.inDraft || status === 'queued');
  async function remove(id) {
    if (!db) return false;
    const c = comments[id];
    // A comment in the GitHub draft becomes a hidden tombstone: the sync takes it out of the draft (unless it was
    // edited on GitHub meanwhile) and then deletes the doc.
    if (c && (c.inDraft || c.deferred)) {
      const ok = await write(id, { status: 'withdrawn', deleted: true, syncPending: true, updatedAt: new Date().toISOString() }, false);
      if (ok) syncGitHub(c, 'deleted; remove it from the draft'); return ok;
    }
    try { await db.collection('comments').doc(id).delete(); return true; } catch (e) { toast('Could not delete'); return false; }
  }
  async function setStatus(id, status) {
    const c = comments[id]; if (!c) return;
    const sync = affectsGitHub(c, status);
    const ok = await write(id, Object.assign({ status, updatedAt: new Date().toISOString() }, sync ? { syncPending: true } : {}), false);
    if (ok && sync) syncGitHub(c, 'status ' + c.status + ' -> ' + status);
    if (ok) toast(status === 'queued' ? 'Queued; adding to your GitHub draft' : status === 'rejected' ? 'Rejected' : 'Back to proposed');
  }
  async function toggleReviewed(c) {
    const sync = affectsGitHub(c, c.status);
    const ok = await write(c.id, Object.assign({ humanReviewed: !c.humanReviewed, updatedAt: new Date().toISOString() }, sync ? { syncPending: true } : {}), false);
    if (ok && sync) syncGitHub(c, c.humanReviewed ? 'unmarked reviewed' : 'marked reviewed by you');
  }
  async function saveEdit(id, body) {
    const ok = await write(id, { body, status: 'queued', editedByUser: true, syncPending: true, updatedAt: new Date().toISOString() }, false);
    if (ok) { dropDraft('ta-' + id); editing = null; renderAll(); toast('Edited; updating your GitHub draft'); syncGitHub(comments[id] || { id }, 'edited by you'); }
  }
  // Close the box as soon as a note is sent and ignore repeats while it is in flight, so one press sends it once.
  const notesInFlight = new Set();
  async function sendNote(id, note, el) {
    const c = comments[id]; if (!c || notesInFlight.has(id)) return;
    notesInFlight.add(id); const was = editing; editing = null; renderAll();
    try { await sendNoteNow(c, id, note, el, was); } finally { notesInFlight.delete(id); }
  }
  async function sendNoteNow(c, id, note, el, was) {
    const shellThreadId = await notifyClaude(c, note, el, 'revision request');
    const at = new Date().toISOString();
    const discussion = (c.discussion || []).concat([{ role: 'user', text: note, at }]);
    const ok = await write(id, { status: 'revise', discussionHidden: false, note, prevStatus: c.status, noteAt: at, discussion, shellThreadId: shellThreadId || c.shellThreadId || null, notifyError: shellThreadId || c.shellThreadId ? null : notifyErr }, false);
    if (ok) { dropDraft('ta-' + id); toast(shellThreadId || !notifyErr ? 'Sent to Claude' : 'Saved; Claude not notified'); }
    else { editing = was; renderAll(); }  // the unsent note is still in the box's saved draft
  }
  async function createComment(anchor, body) {
    const id = newId();
    const conv = !!anchor.replyToConv; // PR conversation replies can't live in a pending review: they wait here until posted
    const doc = { commit: anchor.commit, path: anchor.path || null, line: anchor.line || null, side: anchor.side || null, startLine: anchor.startLine || null, replyTo: anchor.replyTo || null, replyToCommentId: anchor.replyTo ? ((GH.threads.find(t => t.id === anchor.replyTo) || {}).rootCommentId || null) : null, replyToConv: anchor.replyToConv || null, convAuthor: anchor.convAuthor || null, body, author: 'user', status: 'queued', syncPending: !conv, createdAt: new Date().toISOString() };
    const ok = await write(id, doc, true);
    // The write's own snapshot re-renders before the composer is cleared, so render again once it is closed.
    if (ok) { dropDraft('c|' + draftKey(anchor)); openComposer = null; renderAll(); if (conv) toast('Queued; posted when you click "Post queued conversation replies"'); else { toast('Queued; adding to your GitHub draft'); syncGitHub(Object.assign({ id }, doc), 'new comment'); } }
  }

  // ---------- render ----------
  // A commit counts as viewed once every one of its files is marked viewed (the same localStorage keys as the checkboxes).
  function isFileViewed(c, path) { return lsGet('viewed:' + c.sha + ':' + path) === '1'; }
  function isCommitViewed(c) { return !!(c.files && c.files.length) && c.files.every(f => isFileViewed(c, f.path)); }
  function renderStepper() {
    const el = document.getElementById('stepper'); el.innerHTML = '';
    COMMITS.forEach((c, i) => {
      const cs = byCommit(c.sha);
      const p = cs.filter(x => x.status === 'proposed').length, q = cs.filter(x => x.status === 'queued').length;
      // Besides Claude's comments, the dots show what still needs the viewer on this commit: changes to decide (amber square),
      // conversations with Claude (teal; an outline while Claude has not answered) and open reviewer threads (blue). Changes
      // already decided are not counted. The tooltip spells the counts out.
      const chs = Object.values(changes).filter(x => x.commit === c.sha);
      const decide = chs.filter(x => x.status === 'proposed' || x.status === 'failed').length;
      const ths = Object.values(threads).filter(t => t.commit === c.sha && t.kind !== 'feedback' && !t.dismissed);
      const wait = ths.filter(t => t.status !== 'answered').length, conv = ths.length - wait;
      const gho = GH.threads.filter(t => t.commit === c.sha && !t.resolved).length;
      const kinds = [[p, 'proposed', 'proposed comment', 'proposed comments'], [q, 'queued', 'queued comment', 'queued comments'], [decide, 'chg', 'change to decide', 'changes to decide'], [wait, 'wait', 'question waiting for Claude', 'questions waiting for Claude'], [conv, 'conv', 'conversation with Claude', 'conversations with Claude'], [gho, 'gh', 'open reviewer thread', 'open reviewer threads']];
      const dots = kinds.map(k => ('<span class="dot ' + k[1] + '"></span>').repeat(Math.min(k[0], 8))).join('');
      const tip = kinds.filter(k => k[0]).map(k => k[0] + ' ' + (k[0] > 1 ? k[3] : k[2]));
      const viewed = isCommitViewed(c); if (viewed) tip.unshift('all files viewed');
      const b = document.createElement('button'); b.className = 'step' + (i === current ? ' active' : '') + (viewed ? ' viewed' : ''); b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', i === current);
      b.innerHTML = '<span class="n">' + (i + 1) + '/' + COMMITS.length + ' · ' + esc(c.short) + (isDropped(c.sha) ? ' · <span class="dropmark">dropped</span>' : '') + (viewed ? ' · <span class="viewmark">✓ viewed</span>' : '') + '</span><span class="s">' + esc((Object.values(changes).find(x => x.commit === c.sha && x.op === 'reword' && x.status === 'accepted' && x.message) || {}).message ? String(Object.values(changes).find(x => x.commit === c.sha && x.op === 'reword' && x.status === 'accepted' && x.message).message).split('\n')[0] : c.subject) + '</span><span class="dots">' + dots + '</span>';
      if (tip.length) b.title = tip.join(' · ');
      b.onclick = () => go(i); el.appendChild(b);
    });
    const all = Object.values(comments);
    const n = s => all.filter(x => x.status === s).length;
    document.getElementById('counts').innerHTML = '<span class="pill proposed">' + n('proposed') + ' proposed</span><span class="pill queued">' + n('queued') + ' queued</span>' + (n('revise') ? '<span class="pill revise">' + n('revise') + ' with Claude</span>' : '') + (n('posted') ? '<span class="pill posted">' + n('posted') + ' posted</span>' : '') + (function () { const k = Object.values(changes).filter(x => x.status === 'proposed' || x.status === 'failed').length; return k ? '<span class="pill proposed">' + k + ' change' + (k > 1 ? 's' : '') + ' to decide</span>' : ''; })();
    document.getElementById('prev').disabled = current === 0;
    document.getElementById('next').disabled = current === COMMITS.length - 1;
  }

  // Why a queued comment waits for the submit instead of sitting in the GitHub draft (shown on hover).
  const DEFER_WHY = {
    reply: 'GitHub cannot hold this reply in the draft; it is posted right after the review is submitted',
    'file-level': 'file-level comments are added to the draft when you submit',
    'commit-level': 'added when you submit, as a file comment quoting the commit subject',
    'outside-diff': 'the line is outside the PR diff; added when you submit, as a file comment linking the line',
    'draft-locked': 'your GitHub draft holds comments made on GitHub, so it is not rebuilt; added when you submit',
    'rejected-by-github': 'GitHub refused the line; tried again when you submit',
    'restore-failed': 'the draft could not be rebuilt; added when you submit',
    edited: 'changed after it went into the draft; added again when you submit',
  };
  function ghWarn(c) {
    const w = c.githubConflict || c.githubError || c.deferredError;
    return w ? '<span class="pill warn" title="' + esc(w) + '">' + (c.githubConflict ? 'edited on GitHub' : 'GitHub error') + '</span>' : '';
  }
  function card(c) {
    const who = c.author === 'claude' ? 'Claude' : 'You';
    const d = document.createElement('div'); d.className = 'card ' + c.status; d.dataset.cid = c.id; d.id = 'cds-' + c.id;
    let actions = '';
    const badge = c.author === 'claude' ? '<span class="pill claude">Generated with Claude Code</span>' + (c.humanReviewed ? '<span class="pill queued">Reviewed by Human</span>' : '') : '<b>' + who + '</b>';
    const head = '<div class="card-head">' + badge + '<span class="pill ' + c.status + '">' + (c.status === 'revise' ? 'revision requested' : c.status) + '</span>' + (c.editedByUser ? '<span>edited by you</span>' : '') + (c.revisedAt ? '<span>revised by Claude</span>' : '') + (c.path ? (c.line ? (c.startLine ? '<span>lines ' + c.startLine + '–' + c.line + '</span>' : '') : '<span>file-level</span>') : '<span>commit-level</span>') + (c.replyToConv && c.status === 'queued' ? '<span class="pill proposed">waits for "Post queued conversation replies"</span>' : c.syncPending ? '<span class="pill revise">syncing to GitHub…</span>' : c.status === 'queued' && c.deferred ? '<span class="pill proposed" title="' + esc(DEFER_WHY[c.deferred] || c.deferred) + '">added at submit</span>' : c.source === 'github' || (c.inDraft && c.status === 'queued') ? '<span class="pill posted">in your GitHub draft</span>' : '') + ghWarn(c) + '</div>';
    // The revision box opens under the conversation already held with Claude, which stays visible.
    const pastMsgs = (c.discussion || []).map(m => '<div class="msg-row ' + m.role + '"><span class="who">' + (m.role === 'claude' ? 'Claude' : 'You') + '</span><div class="body">' + md(m.text) + '</div></div>').join('');
    if (editing === c.id && c.author === 'claude') {
      d.innerHTML = head + '<div class="body">' + md(c.body) + '</div>' + (pastMsgs ? '<div class="discussion">' + pastMsgs + '</div>' : '') + '<div class="revise"><div class="hint">Tell Claude what to change. The comment stays as is until Claude rewrites it.</div><textarea id="ta-' + c.id + '" placeholder="e.g. shorter, drop the sudo detail, suggest skipping CLONE_NEWUSER when root instead"></textarea><div class="actions"><button class="btn primary small" data-act="sendnote">Send to Claude</button><button class="btn small" data-act="canceledit">Cancel</button></div></div>';
    } else if (editing === c.id) {
      d.innerHTML = head + '<textarea id="ta-' + c.id + '">' + esc(c.body) + '</textarea><div class="actions"><button class="btn primary small" data-act="saveedit">Save and queue</button><button class="btn small" data-act="canceledit">Cancel</button></div>';
    } else {
      const revise = c.author === 'claude' ? '<button class="btn small" data-act="edit">Ask Claude to revise</button>' : '<button class="btn small" data-act="edit">Edit</button>';
      const reviewed = '<button class="btn small' + (c.humanReviewed ? '' : ' primary') + '" data-act="reviewed">' + (c.humanReviewed ? 'Remove Reviewed by Human' : 'Add Reviewed by Human') + '</button>';
      // Only an explicit Queue click puts a comment into the GitHub draft; unqueueing removes it from there.
      if (c.status === 'proposed') actions = '<button class="btn primary small" data-act="approve">Queue → GitHub draft</button>' + (c.author === 'claude' ? reviewed : '') + revise + '<button class="btn small" data-act="reject">Reject</button>';
      else if (c.status === 'queued') actions = c.source === 'github' ? '' : (c.author === 'claude' ? reviewed + revise + '<button class="btn small" data-act="unqueue">Unqueue (remove from draft)</button>' : revise + '<button class="btn small" data-act="delete">Delete</button>');
      else if (c.status === 'rejected') actions = '<button class="btn small" data-act="restore">Restore</button>';
      // Claude withdraws its own comment when a conversation shows it no longer holds; it stays visible and can be restored.
      else if (c.status === 'withdrawn') actions = '<button class="btn small" data-act="restore">Restore (I still want it)</button>';
      else if (c.status === 'revise') actions = '<button class="btn small" data-act="cancelrevise">Withdraw request</button>';
      const disc = c.discussion || [];
      const legacy = c.status === 'revise' && c.note && !disc.some(m => m.role === 'user' && m.text === c.note) ? [{ role: 'user', text: c.note }] : [];
      const msgs = disc.concat(legacy).map(m => '<div class="msg-row ' + m.role + '"><span class="who">' + (m.role === 'claude' ? 'Claude' : 'You') + '</span><div class="body">' + md(m.text) + '</div></div>').join('');
      const wait = c.status === 'revise' ? '<div class="pending">Waiting for Claude' + WAIT_DOTS + (c.shellThreadId || !c.notifyError ? '' : ' (not notified: tell Claude in chat to pick up revision requests)') + '</div>' : '';
      // The conversation with Claude under a comment can be dismissed once it is settled; a new request shows it again.
      const hideBtn = msgs && !wait ? '<button class="btn small dismiss" data-act="hidedisc" title="Hide this conversation with Claude">Dismiss conversation</button>' : '';
      const note = c.discussionHidden && msgs && !wait ? '<div class="discussion"><button class="btn small" data-act="showdisc">Show conversation with Claude (' + (disc.length + legacy.length) + ')</button></div>' : msgs || wait ? '<div class="discussion">' + msgs + wait + hideBtn + '</div>' : '';
      d.innerHTML = head + '<div class="body">' + md(c.body) + '</div>' + note + (actions ? '<div class="actions">' + actions + '</div>' : '');
      aboutChats(c.id, d).forEach(x => d.appendChild(x));
    }
    d.addEventListener('click', e => {
      const act = e.target.getAttribute && e.target.getAttribute('data-act'); if (!act) return;
      if (act === 'approve') setStatus(c.id, 'queued');
      else if (act === 'reject') setStatus(c.id, 'rejected');
      else if (act === 'restore' || act === 'unqueue') setStatus(c.id, 'proposed');
      else if (act === 'reviewed') toggleReviewed(c);
      else if (act === 'hidedisc' || act === 'showdisc') write(c.id, { discussionHidden: act === 'hidedisc' });
      else if (act === 'cancelrevise') setStatus(c.id, c.prevStatus || 'proposed');
      else if (act === 'delete') remove(c.id);
      else if (act === 'edit') { editing = c.id; renderAll(); setTimeout(() => { const t = document.getElementById('ta-' + c.id); if (t) t.focus(); }, 0); }
      else if (act === 'canceledit') { editing = null; renderAll(); }
      else if (act === 'saveedit') { const v = document.getElementById('ta-' + c.id).value.trim(); if (v) saveEdit(c.id, v); }
      else if (act === 'sendnote') { const v = document.getElementById('ta-' + c.id).value.trim(); if (v) sendNote(c.id, v, d); }
    });
    return d;
  }

  // ---------- proposed changes ----------
  // Claude writes each change it proposes to "changes"; the viewer accepts or declines it on its card.
  async function writeChange(id, data) {
    if (!db) { toast('Store unavailable'); return false; }
    try { await db.collection('changes').doc(id).update(data); return true; }
    catch (e) { toast('Could not save: ' + (e && e.code || 'error')); return false; }
  }
  const changesAt = (sha, path, refs) => Object.values(changes).filter(x => x.status !== 'landed' && x.commit === sha && x.path === path && x.line && (!refs || refs.some(r => x.line === r.line && (x.side || 'RIGHT') === r.side)));
  // Jump to a card or row by id, on its own commit, unfolding its file.
  function jumpTo(sha, id, fallbacks) {
    const ci = COMMITS.findIndex(c => c.sha === sha); if (ci >= 0 && ci !== current) go(ci);
    setTimeout(() => { let el = document.getElementById(id); if (!el && fallbacks) { for (const f of fallbacks) if ((el = document.getElementById(f))) { toast('Line not in this diff; showing its file'); break; } } if (!el) { toast('Not shown in this view'); return; } if (el.tagName === 'DETAILS') el.open = true; const sec = el.closest('.file'); if (sec) { sec.classList.remove('collapsed'); sec.hidden = false; const tg = sec.querySelector('[data-toggle]'); if (tg) tg.textContent = '▾'; } setCursor(el, false); el.scrollIntoView({ block: 'center' }); flashRow(el); }, 0);
  }
  // A change with no path acts on the whole commit: op "drop" removes it, op "reword" gives it a new message.
  const chgWhere = ch => ch.path ? ch.path + lineLabel(ch) : 'commit ' + ((COMMITS.find(c => c.sha === ch.commit) || {}).short || String(ch.commit || '').slice(0, 10)) + (ch.op === 'drop' ? ' · drop' : ' · new message');
  const commitChanges = sha => Object.values(changes).filter(x => x.commit === sha && !x.path && x.op && x.status !== 'landed');
  // A commit an accepted change dropped from the review branch: marked next to its title and in the stepper.
  const isDropped = sha => Object.values(changes).some(x => x.commit === sha && !x.path && x.op === 'drop' && x.status === 'accepted');
  // A change shows only what it changes: a line diff of old and new, with two lines of context around each edit and the
  // unchanged runs between them folded into one line, so a 3-line edit of a 200-line block reads as 3 lines.
  function lineDiff(o, n) {
    const m = o.length, k = n.length;
    if (m * k > 4000000) return o.map(s => ['d', s]).concat(n.map(s => ['a', s]));
    const L = Array.from({ length: m + 1 }, () => new Uint32Array(k + 1));
    for (let i = m - 1; i >= 0; i--) for (let j = k - 1; j >= 0; j--) L[i][j] = o[i] === n[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = []; let i = 0, j = 0;
    while (i < m && j < k) { if (o[i] === n[j]) { out.push(['c', o[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(['d', o[i++]]); else out.push(['a', n[j++]]); }
    while (i < m) out.push(['d', o[i++]]); while (j < k) out.push(['a', n[j++]]);
    return out;
  }
  function diffRows(o, n, fmt, ctx) {
    const ops = lineDiff(o, n), keep = ops.map(() => false);
    ops.forEach((op, i) => { if (op[0] !== 'c') for (let x = Math.max(0, i - ctx); x <= Math.min(ops.length - 1, i + ctx); x++) keep[x] = true; });
    let html = '', skipped = 0;
    const flush = () => { if (skipped) html += '<div class="md-n">⋯ ' + skipped + ' unchanged line' + (skipped > 1 ? 's' : '') + '</div>'; skipped = 0; };
    ops.forEach((op, i) => {
      if (!keep[i]) { skipped++; return; }
      flush(); const cls = op[0] === 'd' ? 'md-d' : op[0] === 'a' ? 'md-a' : 'md-c', mk = op[0] === 'd' ? '−' : op[0] === 'a' ? '+' : ' ';
      html += '<div class="' + cls + '"><span class="marker">' + mk + '</span>' + fmt(op[1]) + '</div>';
    });
    flush(); return html;
  }
  function miniDiff(ch) {
    if (!ch.path && ch.op) {
      const cm = COMMITS.find(c => c.sha === ch.commit) || {}, oldMsg = ch.oldMessage || [cm.subject, cm.body].filter(Boolean).join('\n\n');
      if (ch.op === 'drop') return '<div class="minidiff msgdiff"><div class="md-d"><span class="marker">−</span>' + esc(cm.subject || oldMsg.split('\n')[0]) + '</div><div class="md-n">(the whole commit is dropped)</div></div>';
      return '<div class="minidiff msgdiff">' + diffRows(oldMsg.split('\n'), String(ch.message || '').split('\n'), esc, 2) + '</div>';
    }
    const lang = langOf(ch.path || ''), o = ch.old || [], n = ch.new || [];
    return '<div class="minidiff">' + diffRows(o, n, x => hl(x, lang), 2) + (n.length ? '' : '<div class="md-n">(the lines are deleted)</div>') + '</div>';
  }
  const chgOpen = new Set(), chgBusy = new Set(); // settled cards the viewer unfolded; accepts in flight
  // Accepting is instant: the card turns accepted and the overlay shows at once. On the viewer's PR, Claude then folds it onto the
  // review branch in the background (applied: false until then); on others' PRs the page queues the suggestion itself.
  // Accepting a change settles the conversation that asked for it: it is dismissed (restorable from the queue).
  const dismissOrigin = ch => { const t = ch.threadId && threads[ch.threadId]; if (t && !t.dismissed && t.status === 'answered') writeThread(t.id, { dismissed: true, updatedAt: new Date().toISOString() }, false); };
  async function acceptChange(ch, el) {
    if (chgBusy.has(ch.id)) return; chgBusy.add(ch.id);
    try {
      const at = new Date().toISOString();
      if (!PR_MINE) {
        const cid = 'sugg_' + ch.id, fence = '```';
        const body = (ch.reason || '') + (ch.path ? '\n\n' + fence + 'suggestion\n' + (ch.new || []).join('\n') + (ch.new && ch.new.length ? '\n' : '') + fence : ch.op === 'reword' ? '\n\nProposed commit message:\n\n' + String(ch.message || '').split('\n').map(l => '> ' + l).join('\n') : '\n\nThis commit could be dropped.');
        const doc = { commit: ch.commit, path: ch.path || null, line: ch.line || null, side: ch.path ? (ch.side || 'RIGHT') : null, startLine: ch.startLine || null, body, author: 'claude', status: 'queued', syncPending: true, createdAt: at };
        if (!await write(cid, doc, true)) return;
        if (!await writeChange(ch.id, { status: 'accepted', decidedAt: at, commentId: cid, error: null })) return;
        dismissOrigin(ch); toast('Accepted; suggestion queued'); syncGitHub(Object.assign({ id: cid }, doc), 'new comment'); return;
      }
      if (!await writeChange(ch.id, { status: 'accepted', applied: false, decidedAt: at, error: null })) return;
      dismissOrigin(ch); toast('Accepted');
      const live = document.getElementById('chg-' + ch.id);
      notifyClaude(ch, ch.shellThreadId ? '[accept change ' + ch.id + ']' : 'apply it on the review branch', live || el, 'accept change').then(sid => writeChange(ch.id, { shellThreadId: sid || ch.shellThreadId || null, notifyError: sid || ch.shellThreadId ? null : notifyErr }));
    } finally { chgBusy.delete(ch.id); }
  }
  function changeCard(ch) {
    const st = ch.status || 'proposed', d = document.createElement('div'); d.className = 'card change cs-' + st; d.id = 'chg-' + ch.id; d.dataset.chg = ch.id;
    const fold = st === 'accepted' || st === 'declined' || st === 'stale', folded = fold && !chgOpen.has(ch.id);
    const title = st === 'accepted' ? '<b>Accepted</b>' : st === 'declined' ? '<b class="struck">Declined</b>' : st === 'stale' ? '<b>Not applied: the PR changed under it</b>' : ch.op === 'drop' && !ch.path ? '<b>Proposed: drop this commit</b>' : ch.op === 'reword' && !ch.path ? '<b>Proposed: new commit message</b>' : '<b>Proposed change</b>';
    const spill = st === 'accepting' ? '<span class="pill revise">accepting</span>' : st === 'failed' ? '<span class="pill warn">failed</span>' : st === 'proposed' ? '<span class="pill proposed">proposed</span>' : '';
    const sha = esc((ch.newCommit || '').slice(0, 10)), br = esc(ch.branch || 'the review branch');
    const pill = st !== 'accepted' ? '' : PR_MINE && ch.applied === false ? '<span class="pill revise" title="Claude is putting it on the review branch; no need to wait">applying' + WAIT_DOTS + '</span>' : !PR_MINE ? '<button class="pill queued linkbtn" data-act="gocomment" title="Go to the comment in your queue">' + (ch.path ? 'suggestion' : 'comment') + ' queued</button>' : ch.commitUrl ? '<a class="pill queued" href="' + esc(ch.commitUrl) + '" target="_blank" rel="noopener">' + (sha ? sha + ' on ' : 'on ') + br + '</a>' : '<span class="pill queued">' + (sha ? sha + ' on ' : 'on ') + br + '</span>';
    const tip = PR_MINE ? (ch.path ? 'Claude folds it into the commit' : ch.op === 'drop' ? 'Claude drops the commit' : 'Claude rewrites the commit message') + ' and pushes the review branch to your fork' : ch.path ? 'Queues it as a GitHub suggestion in your pending review' : 'Queues it as a commit-level comment in your pending review';
    const acc = '<button class="btn primary small" data-act="accept" title="' + tip + '">' + (st === 'failed' ? 'Retry' : 'Accept') + '</button>', dec = '<button class="btn small" data-act="decline">Decline</button>';
    const acts = st === 'proposed' || st === 'failed' ? acc + dec : st === 'declined' ? '<button class="btn small" data-act="restorechg">Restore</button>' : st === 'stale' ? dec : '';
    const toggle = fold ? '<button class="btn small" data-act="expand">' + (folded ? 'Show change' : 'Hide change') + '</button>' : '';
    const wait = st === 'accepting' ? '<div class="pending">Waiting for Claude' + WAIT_DOTS + (ch.shellThreadId || !ch.notifyError ? '' : ' (not notified: tell Claude in chat to apply accepted changes)') + '</div>' : '';
    const err = st === 'failed' && ch.error ? '<div class="note chgerr">' + md(ch.error) + '</div>' : '';
    d.innerHTML = '<div class="card-head">' + title + spill + '<span>' + esc(chgWhere(ch)) + '</span>' + pill + toggle + (fold ? acts : '') + '</div>' + (folded ? '' : (ch.reason ? '<div class="body">' + md(ch.reason) + '</div>' : '') + miniDiff(ch) + err + wait + (!fold && acts ? '<div class="actions">' + acts + '</div>' : ''));
    d.addEventListener('click', e => {
      const b = e.target.closest && e.target.closest('[data-act]'), act = b && b.dataset.act; if (!act) return;
      const at = new Date().toISOString();
      if (act === 'accept') acceptChange(ch, d);
      else if (act === 'decline') writeChange(ch.id, { status: 'declined', decidedAt: at }).then(ok => { if (ok) toast('Declined'); });
      else if (act === 'restorechg') writeChange(ch.id, { status: 'proposed', decidedAt: null }).then(ok => { if (ok) toast('Back to proposed'); });
      else if (act === 'expand') { if (chgOpen.has(ch.id)) chgOpen.delete(ch.id); else chgOpen.add(ch.id); renderFiles(); }
      else if (act === 'gocomment') { const c = comments[ch.commentId]; if (c) jumpTo(c.commit, 'cds-' + c.id); else toast('The suggestion is not loaded yet'); }
    });
    return d;
  }
  // On the viewer's PR, accepted changes sit on the review branch, not on the PR yet: say so under the top bar.
  function renderChangeBanner() {
    const el = document.getElementById('chgbanner'); if (!el) return;
    const acc = PR_MINE ? Object.values(changes).filter(x => x.status === 'accepted') : [];
    el.hidden = !acc.length; if (!acc.length) { el.innerHTML = ''; return; }
    const last = acc.slice().sort((a, b) => String(b.at || b.decidedAt || '').localeCompare(String(a.at || a.decidedAt || '')))[0];
    el.innerHTML = acc.length + ' accepted change' + (acc.length > 1 ? 's' : '') + ' on <code>' + esc(last.branch || 'the review branch') + '</code>, not on the PR yet' + (last.compareUrl ? ' · <a href="' + esc(last.compareUrl) + '" target="_blank" rel="noopener">Compare</a>' : '') + (acc.some(x => x.applied === false) ? ' · applying ' + acc.filter(x => x.applied === false).length + '…' : ' · <b>Push to the PR</b> when you approve');
  }

  function composer(anchor) {
    noteDraftAt('c|' + draftKey(anchor), anchor);
    const d = document.createElement('div'); d.className = 'composer';
    const where = anchor.path ? anchor.path + lineLabel(anchor) : 'commit-level comment on ' + COMMITS[anchor.commitIdx].short;
    d.innerHTML = '<div class="hint">' + (anchor.replyToConv ? 'Reply to ' + esc(anchor.convAuthor || '') + ' in the PR conversation · queued until you post it' : (anchor.replyTo ? 'Reply' : 'New comment') + ' · ' + esc(where) + ' · queued as yours') + '</div><textarea id="composer-ta" data-draft="c|' + esc(draftKey(anchor)) + '" placeholder="Write the review comment as it should appear on GitHub"></textarea><div class="actions"><button class="btn primary small" id="composer-save">Queue comment</button><button class="btn small" id="composer-cancel">Cancel</button></div>';
    d.querySelector('#composer-save').onclick = () => { const v = d.querySelector('#composer-ta').value.trim(); if (v) createComment(anchor, v); };
    d.querySelector('#composer-cancel').onclick = () => { dropDraft('c|' + draftKey(anchor)); openComposer = null; renderAll(); };
    setTimeout(() => { const t = d.querySelector('#composer-ta'); if (t) t.focus(); }, 0);
    return d;
  }

  function renderCommit() {
    const c = COMMITS[current]; const el = document.getElementById('commit');
    const add = c.files.reduce((s, f) => s + f.add, 0), del = c.files.reduce((s, f) => s + f.del, 0);
    el.innerHTML = '<h2 id="commit' + (current + 1) + '-' + esc(c.short) + '">' + esc(c.subject) + '</h2><div class="meta"><a class="sha" href="' + REPO + '/pull/' + PR_NUMBER + '/commits/' + c.sha + '" target="_blank" rel="noopener">' + esc(c.short) + '</a><span>' + c.files.length + ' files</span><span class="stat"><span class="a">+' + add + '</span> <span class="d">−' + del + '</span></span></div>' + (c.body ? '<p class="msg">' + esc(c.body) + '</p>' : '') + '<ul class="filelist">' + c.files.map(f => '<li><a href="#' + fileId(current, f.path) + '" data-jump="' + esc(fileId(current, f.path)) + '">' + esc(f.path) + '</a> <span class="stat"><span class="a">+' + f.add + '</span> <span class="d">−' + f.del + '</span></span></li>').join('') + '</ul>';
    el.querySelectorAll('a[data-jump]').forEach(a => a.onclick = e => { e.preventDefault(); const t = document.getElementById(a.getAttribute('data-jump')); if (t) { t.classList.remove('collapsed'); const tg = t.querySelector('[data-toggle]'); if (tg) tg.textContent = '▾'; t.scrollIntoView({ block: 'start' }); } });
    const viewedCount = c.files.filter(f => lsGet('viewed:' + c.sha + ':' + f.path) === '1').length;
    const tb = document.createElement('div'); tb.className = 'toolbar';
    tb.innerHTML = '<span class="progress"><b>' + viewedCount + '</b> of ' + c.files.length + ' files viewed</span><button class="btn small" data-all="expand">Expand all</button><button class="btn small" data-all="collapse">Collapse all</button><button class="btn small" data-all="unviewed">Show only unviewed</button>';
    tb.querySelector('[data-all="expand"]').onclick = () => document.querySelectorAll('.file').forEach(s => { s.classList.remove('collapsed'); s.hidden = false; s.querySelector('[data-toggle]').textContent = '▾'; });
    tb.querySelector('[data-all="collapse"]').onclick = () => document.querySelectorAll('.file').forEach(s => { s.classList.add('collapsed'); s.querySelector('[data-toggle]').textContent = '▸'; });
    tb.querySelector('[data-all="unviewed"]').onclick = () => document.querySelectorAll('.file').forEach(s => { s.hidden = s.querySelector('input[type=checkbox]').checked; });
    el.appendChild(tb);
    const g = document.createElement('div'); g.className = 'general';
    const gen = byCommit(c.sha).filter(x => !x.path && !isReply(x));
    const paths = new Set(c.files.map(f => f.path));
    const orphan = byCommit(c.sha).filter(x => x.path && !paths.has(x.path));
    g.innerHTML = '<h3>Commit-level comments and conversations</h3>';
    gen.forEach(x => g.appendChild(card(x)));
    const h2 = el.querySelector('h2'), cchg = commitChanges(c.sha);
    cchg.forEach(x => g.appendChild(changeCard(x)));
    // Accepted commit changes live on the review branch: show the commit as it is there (the new message; a dropped commit
    // keeps its diff and its card says it is gone). A change still being accepted is previewed under the old title.
    cchg.filter(x => x.status === 'accepting').forEach(x => {
      if (x.op === 'drop') { h2.classList.add('ovdrop'); h2.insertAdjacentHTML('afterend', '<div class="ovmsg"><span class="ovmark">dropped</span> (accepting…)</div>'); }
      else if (x.op === 'reword') h2.insertAdjacentHTML('afterend', '<div class="ovmsg"><span class="ovmark">new message</span> (accepting…)\n' + esc(x.message || '') + '</div>');
    });
    if (isDropped(c.sha)) h2.insertAdjacentHTML('beforeend', ' <span class="pill dropped" title="Dropped from the review branch by an accepted change">dropped</span>');
    cchg.filter(x => x.status === 'accepted' && x.op === 'reword' && x.message).forEach(x => {
      const lines = String(x.message).split('\n'), subj = lines[0], body = lines.slice(1).join('\n').replace(/^\n+/, '');
      h2.textContent = subj; const m = el.querySelector('.msg');
      if (m) { if (body) m.textContent = body; else m.remove(); } else if (body) { const p = document.createElement('p'); p.className = 'msg'; p.textContent = body; el.querySelector('.meta').insertAdjacentElement('afterend', p); }
    });
    threadsAt(c.sha, null, null).forEach(t => g.appendChild(threadCard(t, h2)));
    ghAt(c.sha, null, null).forEach(t => g.appendChild(ghThreadCard(t)));
    if (GH.conversation.length) {
      const pc = document.createElement('details'); pc.className = 'ghthread';
      pc.open = ghOpen.has('pr-conv') || !!(openComposer && openComposer.replyToConv);
      pc.addEventListener('toggle', () => { if (pc.open) ghOpen.add('pr-conv'); else ghOpen.delete('pr-conv'); });
      pc.innerHTML = '<summary class="card-head"><b>PR conversation</b><span>' + GH.conversation.length + ' items · replies are queued and posted together when you click "Post queued conversation replies"</span></summary>';
      GH.conversation.forEach(c => {
        const item = document.createElement('div'); item.className = 'ghc';
        item.innerHTML = '<div class="ghwho"><b>' + esc(c.author) + '</b> <span>' + esc(c.kind) + ' · ' + esc((c.at || '').slice(0, 10)) + '</span> <a href="' + esc(c.url) + '" target="_blank" rel="noopener">open</a></div><div class="ghbody">' + cleanHTML(c.html) + '</div>';
        Object.values(comments).filter(x => x.replyToConv === c.url).forEach(x => item.appendChild(card(x)));
        if (openComposer && openComposer.replyToConv === c.url) item.appendChild(composer(openComposer));
        else {
          const b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'Reply (queue)';
          b.onclick = () => { openComposer = { commit: COMMITS[current].sha, commitIdx: current, replyToConv: c.url, convAuthor: c.author }; editing = null; renderAll(); };
          const row = document.createElement('div'); row.className = 'actions'; row.appendChild(b); item.appendChild(row);
        }
        pc.appendChild(item);
      });
      g.appendChild(pc);
    }
    if (openAsk && !openAsk.about && openAsk.commitIdx === current && !openAsk.path && openAsk.kind !== 'feedback') g.appendChild(askComposer(openAsk, h2));
    if (orphan.length) { const h = document.createElement('div'); h.className = 'empty'; h.textContent = 'Anchored to files not in this commit:'; g.appendChild(h); orphan.forEach(x => g.appendChild(card(x))); }
    if (openComposer && openComposer.commitIdx === current && !openComposer.path && !openComposer.replyTo && !openComposer.replyToConv) g.appendChild(composer(openComposer));
    else {
      const row = document.createElement('div'); row.className = 'actions';
      const b = document.createElement('button'); b.className = 'btn small'; b.textContent = '+ Queue a commit-level GitHub comment'; b.dataset.k = '1'; b.onclick = () => { openComposer = { commit: c.sha, commitIdx: current }; renderAll(); }; row.appendChild(b);
      const a = document.createElement('button'); a.className = 'btn small ask'; a.textContent = '? Ask Claude about this commit'; a.dataset.i = '1'; a.onclick = () => askAbout({ commit: c.sha, commitIdx: current }); row.appendChild(a);
      const m = document.createElement('button'); m.className = 'btn small'; m.style.color = 'var(--proposed)'; m.style.borderColor = 'var(--proposed)'; m.textContent = '✎ Ask Claude to change this commit'; m.title = 'Reword its message, drop it, or rework it as a whole (m)'; m.dataset.m = '1'; m.onclick = () => askAbout({ commit: c.sha, commitIdx: current, kind: 'modify' }); row.appendChild(m);
      g.appendChild(row);
    }
    // Every item of the commit-level section is a keyboard stop, before the files.
    Array.from(g.children).filter(ch => ch.tagName !== 'H3').forEach((ch, i) => { ch.classList.add('gstop'); if (!ch.id) ch.id = 'gstop-' + current + '-' + i; });
    el.appendChild(g);
  }

  function renderFiles() {
    const c = COMMITS[current]; const root = document.getElementById('files'); root.innerHTML = '';
    const col = document.createElement('div'); col.className = 'col';
    c.files.forEach(f => {
      const fid = fileId(current, f.path);
      const viewedKey = 'viewed:' + c.sha + ':' + f.path;
      const viewed = lsGet(viewedKey) === '1';
      const sec = document.createElement('section'); sec.className = 'file' + ((viewed || COLLAPSED_DEFAULT.has(f.path)) ? ' collapsed' : ''); sec.id = fid;
      const head = document.createElement('div'); head.className = 'file-head'; head.id = fid + '-head';
      head.innerHTML = '<button class="btn small" data-toggle aria-label="Toggle diff">' + (sec.classList.contains('collapsed') ? '▸' : '▾') + '</button><span class="path">' + esc(f.path) + '</span><span class="tag">' + ({ A: 'added', D: 'deleted', M: 'modified' })[f.status] + '</span><span class="stat"><span class="a">+' + f.add + '</span> <span class="d">−' + f.del + '</span></span><label><input type="checkbox" id="v-' + fid + '"' + (viewed ? ' checked' : '') + '> Viewed</label>';
      head.querySelector('[data-toggle]').onclick = () => { sec.classList.toggle('collapsed'); head.querySelector('[data-toggle]').textContent = sec.classList.contains('collapsed') ? '▸' : '▾'; };
      head.querySelector('input').onchange = e => { lsSet(viewedKey, e.target.checked ? '1' : '0'); sec.classList.toggle('collapsed', e.target.checked); head.querySelector('[data-toggle]').textContent = e.target.checked ? '▸' : '▾'; const p = document.querySelector('.progress b'); if (p) p.textContent = c.files.filter(x => lsGet('viewed:' + c.sha + ':' + x.path) === '1').length; renderStepper(); markStep(); };
      sec.appendChild(head);
      const fileLevel = byCommit(c.sha).filter(x => x.path === f.path && !x.line && !isReply(x));
      const ghFile = ghAt(c.sha, f.path, null);
      if (fileLevel.length || ghFile.length) { const th = document.createElement('div'); th.className = 'thread'; th.style.borderBottom = '1px solid var(--line-soft)'; ghFile.forEach(x => th.appendChild(ghThreadCard(x))); fileLevel.forEach(x => th.appendChild(card(x))); sec.appendChild(th); }
      const wrap = document.createElement('div'); wrap.className = 'diffwrap';
      const split = viewMode === 'split';
      const table = document.createElement('table'); table.className = 'diff' + (split ? ' split' : '');
      const tbody = document.createElement('tbody');
      const fileComments = byCommit(c.sha).filter(x => x.path === f.path && x.line && !isReply(x));
      const anchored = new Set(), anchoredChg = new Set(), fileChanges = changesAt(c.sha, f.path, null);
      // Accepted changes (and, faded, those being accepted) on the viewer's PR: the replaced lines struck in amber, the new ones drawn after them.
      const ovs = PR_MINE ? fileChanges.filter(x => x.status === 'accepted' || x.status === 'accepting') : [];
      const cols = split ? 4 : 3;
      const cellNum = (side, line, cls) => '<td class="num ' + cls + '">' + (line != null ? '<span class="lbtns"><button class="addbtn" data-side="' + side + '" data-line="' + line + '" title="Queue a GitHub comment on this line" aria-label="Queue a GitHub comment on this line">+</button>' + (side === 'RIGHT' ? '<button class="modbtn" title="Ask Claude to change this line" aria-label="Ask Claude to change this line">✎</button>' : '') + '<button class="askbtn" title="Ask Claude about this line" aria-label="Ask Claude about this line">?</button></span>' + line : '') + '</td>';
      const lang = langOf(f.path);
      const cellCode = (t, s, cls, range) => { let h = hl(s, lang); if (range) h = markRange(h, range[0], range[1]); return '<td class="code ' + cls + '">' + (t ? '<span class="marker">' + (t === 'a' ? '+' : t === 'd' ? '−' : ' ') + '</span>' + h : '') + '</td>'; };
      const emptyPair = (left) => '<td class="num ' + (left ? 'left ' : '') + 'empty"></td><td class="code ' + (left ? 'l' : 'r') + ' empty"></td>';
      // Synthetic rows hold no line numbers or ids: comments keep anchoring to the PR's own lines, and the cursor skips them.
      const ovSlots = {}; // accepted change id -> rows whose new side it blanked (split view), filled with its new lines
      const ovRow = (x, s, i) => {
        const tr = document.createElement('tr'), pv = x.status === 'accepting'; tr.className = 'ovnew' + (pv ? ' prev' : ' done');
        // An accepted change is drawn as the plain new version, numbered from the first line it replaces; only a change still being accepted is marked as a preview.
        const g = pv ? '<td class="num ovg"><span class="ovmark">preview</span></td>' : '<td class="num a"><span class="lbtns"><button class="modbtn" title="Ask Claude to change this line" aria-label="Ask Claude to change this line">✎</button><button class="askbtn" title="Ask Claude about this line" aria-label="Ask Claude about this line">?</button></span>' + ((x.startLine || x.line) + i) + '</td>', code = '<td class="code ' + (pv ? 'ovn' : 'a') + (split ? ' r' : '') + '"><span class="marker">+</span>' + hl(s, lang) + '</td>';
        tr.innerHTML = split ? emptyPair(true) + g + code : (pv ? '<td class="num left ovg"></td>' : '<td class="num left a"></td>') + g + code;
        // Its own id (by change and line) lets the cursor stop on it; the change keeps its PR anchor for comments.
        tr.dataset.chg = x.id; tr.dataset.nl = s; tr.dataset.ovi = i; if (!pv) tr.id = 'ov-' + x.id + '-' + i;
        // Its ? and ✎ ask about exactly this line (Shift+click: the range from the cursor's line of the same change).
        tr.querySelectorAll('.askbtn, .modbtn').forEach(b => b.onclick = e => { const kind = b.classList.contains('modbtn') ? 'modify' : undefined; const rows = e && e.shiftKey ? ovRangeTo(tr) : null; askOverlay(x, rows || [tr], kind); });
        return tr;
      };
      // Conversations on the new lines of an accepted change hang under the exact line they were asked about.
      const ovShown = new Set();
      // A change proposed on top of an accepted one (its old lines are that change's new lines, or it names the change
      // with onChange and newEnd) hangs under the line it edits: the last line of its first edit, not the change's end.
      const ovChgShown = new Set();
      const ovAnchorOf = (ch, x) => {
        if (ch.id === x.id || ch.path !== x.path || ['accepted', 'accepting', 'landed'].includes(ch.status)) return null;
        if (ch.onChange === x.id && ch.newEnd != null) return ch.newEnd;
        const o = ch.old || [], nw = x.new || [];
        if (!o.length || o.length !== nw.length || o.some((l, k) => l !== nw[k])) return null;
        const ops = lineDiff(o, ch.new || []); let oi = 0, last = null, started = false;
        for (const op of ops) {
          if (op[0] === 'c') { if (started) break; oi++; continue; }
          started = true; if (op[0] === 'd') { last = oi; oi++; } else if (last == null) last = Math.max(0, oi - 1);
        }
        return last == null ? o.length - 1 : Math.min(last, o.length - 1);
      };
      const ovThreadRow = (x, i, lineEl) => {
        const convs = Object.values(threads).filter(t => visibleThread(t) && !t.about && t.onChange === x.id && t.newEnd === i);
        const ask = openAsk && openAsk.onChange === x.id && openAsk.newEnd === i;
        const chsHere = fileChanges.filter(ch => ovAnchorOf(ch, x) === i);
        if (!convs.length && !ask && !chsHere.length) return null;
        const ctr = document.createElement('tr'); ctr.className = 'cmt'; const td = document.createElement('td'); td.colSpan = cols; const th = document.createElement('div'); th.className = 'thread';
        convs.forEach(t => { ovShown.add(t.id); th.appendChild(threadCard(t, lineEl)); });
        chsHere.forEach(ch => { ovChgShown.add(ch.id); anchoredChg.add(ch.id); th.appendChild(changeCard(ch)); });
        if (ask) th.appendChild(askComposer(openAsk, lineEl));
        td.appendChild(th); ctr.appendChild(td); return ctr;
      };
      function threadRow(refs, lineEl) {
        const here = fileComments.filter(x => refs.some(r => x.line === r.line && (x.side || 'RIGHT') === r.side));
        const convs = threadsAt(c.sha, f.path, refs).filter(t => !ovShown.has(t.id));
        const ghs = ghAt(c.sha, f.path, refs);
        const comp = openComposer && !openComposer.replyTo && openComposer.commitIdx === current && openComposer.path === f.path && refs.some(r => openComposer.line === r.line && openComposer.side === r.side);
        const ask = openAsk && !openAsk.about && openAsk.newEnd == null && openAsk.commitIdx === current && openAsk.path === f.path && refs.some(r => openAsk.line === r.line && openAsk.side === r.side);
        const chs = fileChanges.filter(x => !ovChgShown.has(x.id) && refs.some(r => x.line === r.line && (x.side || 'RIGHT') === r.side));
        if (!here.length && !convs.length && !ghs.length && !chs.length && !comp && !ask) return null;
        const ctr = document.createElement('tr'); ctr.className = 'cmt'; const td = document.createElement('td'); td.colSpan = cols; const th = document.createElement('div'); th.className = 'thread';
        here.forEach(x => { anchored.add(x.id); th.appendChild(card(x)); });
        ghs.forEach(t => th.appendChild(ghThreadCard(t)));
        convs.forEach(t => th.appendChild(threadCard(t, lineEl)));
        chs.forEach(x => { anchoredChg.add(x.id); th.appendChild(changeCard(x)); });
        if (comp) th.appendChild(composer(openComposer));
        if (ask) th.appendChild(askComposer(openAsk, lineEl));
        td.appendChild(th); ctr.appendChild(td); return ctr;
      }
      function lineRow(cls, html, refs) {
        const tr = document.createElement('tr'); tr.className = 'line ' + cls; tr.innerHTML = html;
        tr.dataset.ids = refs.map(r => rowId(current, f.path, r.line, r.side)).join(' ');
        tr.id = rowId(current, f.path, refs[refs.length - 1].line, refs[refs.length - 1].side);
        // A button acts on the side of the cell it sits in (the split view's old or new line).
        const refOf = b => { const a = b.closest('.lbtns').querySelector('.addbtn'), sd = a && a.dataset.side; return refs.find(r => r.side === sd) || refs[refs.length - 1]; };
        tr.querySelectorAll('.askbtn').forEach(b => b.onclick = e => { const r = refOf(b); askAbout(withRange({ commit: c.sha, commitIdx: current, path: f.path, line: r.line, side: r.side }, tr, e)); });
        tr.querySelectorAll('.modbtn').forEach(b => b.onclick = e => { const r = refOf(b); askAbout(withRange({ commit: c.sha, commitIdx: current, path: f.path, line: r.line, side: r.side, kind: 'modify' }, tr, e)); });
        tr.querySelectorAll('.addbtn').forEach(b => b.onclick = e => { openComposer = withRange({ commit: c.sha, commitIdx: current, path: f.path, line: parseInt(b.dataset.line, 10), side: b.dataset.side }, tr, e); editing = null; renderAll(); setTimeout(() => { const t = document.getElementById('composer-ta'); if (t) t.scrollIntoView({ block: 'center' }); }, 0); });
        const rr = refs.find(r => r.side === 'RIGHT'), ov = rr ? ovs.filter(x => rr.line >= (x.startLine || x.line) && rr.line <= x.line) : [];
        // Lines an accepted change replaced are hidden (their comments and the change card still show below); a change being accepted strikes them.
        // An accepted change rewrites the commit's new side only: its old lines stay as removed lines (left side), and a row with nothing on the old side is hidden.
        if (ov.some(x => x.status === 'accepted')) {
          const tds = tr.children, oldNum = tds[0], oldCode = split ? tds[1] : tds[2], hasOld = split ? !oldCode.classList.contains('empty') : oldNum.textContent.trim() !== '' || !!oldNum.querySelector('[data-side="LEFT"]');
          if (!hasOld) tr.hidden = true;
          else {
            if (split) { tds[2].className = 'num empty'; tds[2].innerHTML = ''; tds[3].className = 'code r empty'; tds[3].innerHTML = ''; const a = ov.find(x => x.status === 'accepted'); (ovSlots[a.id] = ovSlots[a.id] || []).push(tr); }
            else { tds[1].innerHTML = ''; }
            oldNum.classList.add('d'); oldCode.classList.add('d'); const mk = oldCode.querySelector('.marker'); if (mk) mk.textContent = '−';
          }
        }
        else if (ov.length) { const cs = tr.querySelectorAll('td.code'), cell = cs[cs.length - 1]; if (cell && !cell.classList.contains('empty')) cell.classList.add('ovold'); tr.classList.add('ovprev'); }
        tbody.appendChild(tr);
        // A change accepted later over the same lines replaces this one's new lines (e.g. a reworded comment, later deleted with its block).
        const superseded = x => ovs.some(y => y !== x && y.status === 'accepted' && (y.startLine || y.line) <= (x.startLine || x.line) && y.line >= x.line && String(y.decidedAt || y.at || '') > String(x.decidedAt || x.at || ''));
        ov.filter(x => x.line === rr.line && !superseded(x)).forEach(x => (x.new || []).forEach((s, i) => {
          // In the split view the new lines fill the right side of the removed lines first, so a replaced line sits beside its replacement.
          const slot = x.status === 'accepted' && (ovSlots[x.id] || [])[i];
          if (slot) { const r = ovRow(x, s, i), num = r.children[2], code = r.children[3]; slot.children[3].replaceWith(code); slot.children[2].replaceWith(num); slot.classList.add('ovfill'); slot.dataset.chg = x.id; slot.dataset.nl = s; slot.dataset.ovi = i; const tr2 = x.status === 'accepted' && ovThreadRow(x, i, slot); if (tr2) { let at = slot; while (at.nextElementSibling && at.nextElementSibling.classList.contains('cmt')) at = at.nextElementSibling; at.after(tr2); } }
          else { const r = ovRow(x, s, i); tbody.appendChild(r); const tr2 = x.status === 'accepted' && ovThreadRow(x, i, r); if (tr2) tbody.appendChild(tr2); }
        }));
        const row = threadRow(refs, tr); if (row) tbody.appendChild(row);
      }
      // GitHub-style context expansion: the unchanged lines between hunks come from the file's full text at this commit.
      const text = f.text || null, xkey = c.sha + ':' + f.path;
      const ctxRow = (n, delta) => {
        const s = text[n - 1], o = n - delta;
        if (split) lineRow('c', cellNum('LEFT', o, 'left') + cellCode('c', s, 'l') + cellNum('RIGHT', n, '') + cellCode('c', s, 'r'), [{ line: o, side: 'LEFT' }, { line: n, side: 'RIGHT' }]);
        else lineRow('c', '<td class="num left c">' + o + '</td>' + cellNum('RIGHT', n, 'c') + cellCode('c', s, 'c'), [{ line: n, side: 'RIGHT' }]);
      };
      // A gap is new-side lines [from, to]; `delta` maps them to old-side numbers. Shows what the viewer expanded plus an expander row.
      function gap(gi, from, to, delta, header) {
        const size = text ? to - from + 1 : 0;
        const st = (expanded[xkey] && expanded[xkey][gi]) || { top: 0, bot: 0 };
        const top = Math.min(st.top, size), bot = Math.min(st.bot, size - top);
        for (let n = from; n < from + top; n++) ctxRow(n, delta);
        const hidden = size - top - bot;
        if (hidden > 0 || header) {
          const tr = document.createElement('tr'); tr.className = 'hunk'; tr.id = fid + '-gap' + gi;
          const set = (dt, db) => { expanded[xkey] = expanded[xkey] || {}; expanded[xkey][gi] = { top: top + dt, bot: bot + db }; renderFiles(); };
          const btns = hidden <= 0 ? '' : hidden <= 20 ? '<button class="xbtn" data-x="all" title="Expand ' + hidden + ' lines">↕ ' + hidden + '</button>'
            : (gi > 0 ? '<button class="xbtn" data-x="down" title="Expand down">↓ 20</button>' : '') + (header ? '<button class="xbtn" data-x="up" title="Expand up">↑ 20</button>' : '') + '<button class="xbtn" data-x="all" title="Expand all ' + hidden + ' lines">↕ all ' + hidden + '</button>';
          tr.innerHTML = '<td colspan="' + cols + '"><span class="xbtns">' + btns + '</span>' + (header ? esc(header) : '') + '</td>';
          tr.querySelectorAll('.xbtn').forEach(x => x.onclick = () => x.dataset.x === 'all' ? set(hidden, 0) : x.dataset.x === 'down' ? set(20, 0) : set(0, 20));
          tbody.appendChild(tr);
        }
        for (let n = to - bot + 1; n <= to; n++) ctxRow(n, delta);
      }
      const span = h => { const m = /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(h.header); return { o: +m[1], oc: m[2] == null ? 1 : +m[2], n: +m[3], nc: m[4] == null ? 1 : +m[4] }; };
      let prevEnd = 0, delta = 0;
      f.hunks.forEach((h, hi) => {
        const sp = span(h);
        gap(hi, prevEnd + 1, sp.n - 1, sp.n - sp.o, h.header);
        prevEnd = sp.n + sp.nc - 1; delta = (sp.n + sp.nc) - (sp.o + sp.oc);
        if (!split) {
          h.lines.forEach(l => {
            const side = l.t === 'd' ? 'LEFT' : 'RIGHT'; const line = l.t === 'd' ? l.o : l.n;
            lineRow(l.t, '<td class="num left ' + l.t + '">' + (l.o != null ? l.o : '') + '</td>' + cellNum(side, line, l.t) + cellCode(l.t, l.s, l.t), [{ line, side }]);
          });
          return;
        }
        let i = 0;
        while (i < h.lines.length) {
          const l = h.lines[i];
          if (l.t === 'c') {
            lineRow('c', cellNum('LEFT', l.o, 'left') + cellCode('c', l.s, 'l') + cellNum('RIGHT', l.n, '') + cellCode('c', l.s, 'r'), [{ line: l.o, side: 'LEFT' }, { line: l.n, side: 'RIGHT' }]);
            i++; continue;
          }
          const dels = [], adds = [];
          while (i < h.lines.length && h.lines[i].t === 'd') dels.push(h.lines[i++]);
          while (i < h.lines.length && h.lines[i].t === 'a') adds.push(h.lines[i++]);
          const paired = dels.length === adds.length; // only then is a positional pairing meaningful enough to mark intra-line changes
          for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
            const d = dels[k], a = adds[k]; const refs = [];
            if (d) refs.push({ line: d.o, side: 'LEFT' }); if (a) refs.push({ line: a.n, side: 'RIGHT' });
            let sp = (paired && d && a) ? changedSpan(d.s, a.s) : null;
            // Skip the marks when most of the line was replaced: they would only add noise. A pure insertion or deletion (one side unchanged) is always marked.
            if (sp && sp.x[1] > sp.x[0] && sp.y[1] > sp.y[0] && Math.max(sp.x[1] - sp.x[0], sp.y[1] - sp.y[0]) > 0.6 * Math.max(d.s.length, a.s.length)) sp = null;
            lineRow('pair', (d ? cellNum('LEFT', d.o, 'left d') + cellCode('d', d.s, 'l d', sp && sp.x) : emptyPair(true)) + (a ? cellNum('RIGHT', a.n, 'a') + cellCode('a', a.s, 'r a', sp && sp.y) : emptyPair(false)), refs);
          }
        }
      });
      if (text && f.hunks.length) gap(f.hunks.length, prevEnd + 1, text.length, delta, null);
      table.appendChild(tbody); wrap.appendChild(table); sec.appendChild(wrap);
      const lost = fileComments.filter(x => !anchored.has(x.id)), lostChg = fileChanges.filter(x => !anchoredChg.has(x.id));
      if (lost.length || lostChg.length) { const th = document.createElement('div'); th.className = 'thread'; const h = document.createElement('div'); h.className = 'empty'; h.textContent = 'Comments whose line is outside this diff:'; th.appendChild(h); lost.forEach(x => th.appendChild(card(x))); lostChg.forEach(x => th.appendChild(changeCard(x))); wrap.appendChild(th); }
      col.appendChild(sec);
    });
    root.appendChild(col);
    applyCursor();
  }

  function renderQueue() {
    const el = document.getElementById('queue'); el.innerHTML = '<h2>Review queue</h2>';
    const all = Object.values(comments).sort((a, b) => (a.commit === b.commit ? 0 : COMMITS.findIndex(c => c.sha === a.commit) - COMMITS.findIndex(c => c.sha === b.commit)) || (a.path || '').localeCompare(b.path || '') || (a.line || 0) - (b.line || 0));
    if (!all.length && !Object.keys(threads).length && !Object.keys(changes).length) { el.innerHTML += '<div class="empty">' + (dbReady ? 'No comments yet. Hover a diff line and press + to add one.' : 'Loading comments…') + '</div>'; return; }
    const unsent = Object.keys(drafts).filter(k => draftAt[k] && (drafts[k] || '').trim() && !(openComposer && 'c|' + draftKey(openComposer) === k) && !(openAsk && 'a|' + draftKey(openAsk) === k));
    if (unsent.length) {
      const g = document.createElement('div'); g.className = 'qgroup';
      g.innerHTML = '<h3><span class="pill proposed">' + unsent.length + '</span>Unsent drafts</h3>';
      unsent.forEach(k => {
        const a = draftAt[k], ci = COMMITS.findIndex(c => c.sha === a.commit); if (ci < 0) return;
        const b = document.createElement('button'); b.className = 'qitem';
        b.innerHTML = '<div class="where">' + (ci + 1) + ' · ' + esc(a.path ? a.path + lineLabel(a) : 'commit-level') + ' · ' + (k[0] === 'c' ? 'comment' : a.kind === 'modify' ? 'change request' : 'question') + '</div><div class="snip">' + esc(drafts[k].split('\n')[0]) + '</div>';
        b.onclick = () => { go(ci); const an = Object.assign({}, a, { commitIdx: ci }); if (k[0] === 'c') { openComposer = an; openAsk = null; } else { openAsk = an; openComposer = null; } renderAll(); setTimeout(() => { const t = document.getElementById(k[0] === 'c' ? 'composer-ta' : 'ask-ta'); if (t) { const sec = t.closest('.file'); if (sec) { sec.classList.remove('collapsed'); sec.hidden = false; } t.scrollIntoView({ block: 'center' }); t.focus(); } }, 0); };
        g.appendChild(b);
      });
      el.appendChild(g);
    }
    const allConvs = Object.values(threads).filter(t => !(t.kind === 'feedback' && t.status === 'answered')), hiddenN = allConvs.filter(t => t.dismissed).length;
    const convs = allConvs.filter(visibleThread);
    if (allConvs.length) {
      const g = document.createElement('div'); g.className = 'qgroup';
      const open = convs.filter(t => t.status === 'asked').length;
      g.innerHTML = '<h3><span class="pill revise">' + convs.length + '</span>Conversations with Claude' + (open ? ' · ' + open + ' waiting' : '') + '</h3>';
      if (hiddenN) {
        const tg = document.createElement('button'); tg.className = 'btn small'; tg.textContent = showDismissed ? 'Hide dismissed' : 'Show ' + hiddenN + ' dismissed';
        tg.onclick = () => { showDismissed = !showDismissed; lsSet('showdismissed', showDismissed ? '1' : '0'); renderAll(); }; g.appendChild(tg);
      }
      convs.forEach(t => {
        const ci = COMMITS.findIndex(c => c.sha === t.commit); const first = (t.messages && t.messages[0] && t.messages[0].text) || '';
        const b = document.createElement('button'); b.className = 'qitem';
        b.innerHTML = '<div class="where">' + (t.kind === 'feedback' ? 'feedback on the tool' : (ci + 1) + ' · ' + esc(t.path ? t.path + (t.line ? ':' + t.line : '') : 'commit-level')) + (t.status === 'asked' ? ' · waiting' : '') + '</div><div class="snip">' + esc(first.split('\n')[0]) + '</div>';
        b.onclick = () => { if (t.kind === 'feedback') { fbOpen = true; renderFeedback(); return; } go(ci); setTimeout(() => { const el = t.path && t.line ? document.querySelector('[data-ids~="' + rowId(ci, t.path, t.line, t.side || 'RIGHT') + '"]') : document.getElementById('commit'); if (el) { const sec = el.closest('.file'); if (sec) { sec.classList.remove('collapsed'); sec.hidden = false; } el.scrollIntoView({ block: 'center' }); flashRow(el); } }, 0); };
        g.appendChild(b);
      });
      el.appendChild(g);
    }
    const pendChg = Object.values(changes).filter(x => (x.status === 'proposed' || x.status === 'failed') && COMMITS.some(c => c.sha === x.commit)).sort((a, b) => COMMITS.findIndex(c => c.sha === a.commit) - COMMITS.findIndex(c => c.sha === b.commit) || (a.path || '').localeCompare(b.path || '') || (a.line || 0) - (b.line || 0));
    if (pendChg.length) {
      const g = document.createElement('div'); g.className = 'qgroup'; g.innerHTML = '<h3><span class="pill proposed">' + pendChg.length + '</span>Proposed changes</h3>';
      pendChg.forEach(x => {
        const ci = COMMITS.findIndex(c => c.sha === x.commit), b = document.createElement('button'); b.className = 'qitem';
        b.innerHTML = '<div class="where">' + (ci + 1) + ' · ' + esc(chgWhere(x)) + (x.status === 'failed' ? ' · failed' : '') + '</div><div class="snip">' + esc(String(x.reason || (x.new || [])[0] || x.message || '').split('\n')[0]) + '</div>';
        b.onclick = () => jumpTo(x.commit, 'chg-' + x.id, ['commit']); g.appendChild(b);
      });
      el.appendChild(g);
    }
    const ghT = GH.threads.filter(t => COMMITS.some(c => c.sha === t.commit)).sort((a, b) => !!a.resolved - !!b.resolved || COMMITS.findIndex(c => c.sha === a.commit) - COMMITS.findIndex(c => c.sha === b.commit) || (a.path || '').localeCompare(b.path || '') || (a.line || 0) - (b.line || 0));
    if (ghT.length) {
      const g = document.createElement('div'); g.className = 'qgroup'; const nOpen = ghT.filter(t => !t.resolved).length;
      g.innerHTML = '<h3><span class="pill rejected">' + ghT.length + '</span>Reviewer threads · ' + nOpen + ' open</h3>';
      ghT.forEach(t => {
        const ci = COMMITS.findIndex(c => c.sha === t.commit), f = t.comments[0] || {}, b = document.createElement('button'); b.className = 'qitem';
        const txt = String(f.body || f.text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || (cleanTextOf(f.html));
        b.innerHTML = '<div class="where">' + (ci + 1) + ' · ' + esc(f.author || '') + ' · ' + esc((t.path || 'commit-level') + lineLabel(t)) + ' <span class="pill ' + (t.resolved ? 'rejected">resolved' : 'proposed">open') + '</span></div><div class="snip">' + esc(txt.length > 80 ? txt.slice(0, 80) + '…' : txt) + '</div>';
        b.onclick = () => jumpTo(t.commit, 'ghs-' + t.id, (t.path ? [fileId(ci, t.path) + '-head'] : []).concat('commit'));
        g.appendChild(b);
      });
      el.appendChild(g);
    }
    const convQueued = all.filter(x => x.replyToConv && x.status === 'queued');
    if (convQueued.length) {
      const g = document.createElement('div'); g.className = 'qgroup';
      const b = document.createElement('button'); b.className = 'btn primary small'; b.textContent = 'Post ' + convQueued.length + ' queued conversation repl' + (convQueued.length > 1 ? 'ies' : 'y');
      b.title = 'Claude posts them on the PR conversation now (they are public immediately)';
      b.onclick = () => { if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Click again: post publicly now'; return; } notifyClaude({ id: 'conv-' + Date.now().toString(36) }, convQueued.map(x => x.id).join(', '), document.getElementById('queue'), 'post conversation replies'); convQueued.forEach(x => write(x.id, { syncPending: true }, false)); toast('Sent to Claude to post'); };
      g.appendChild(b); el.appendChild(g);
    }
    const groups = [['revise', 'Sent to Claude for revision'], ['queued', 'Queued: in your GitHub draft'], ['proposed', 'Proposed by Claude, awaiting your call'], ['rejected', 'Rejected'], ['withdrawn', 'Withdrawn by Claude'], ['posted', 'Posted']];
    groups.forEach(([st, label]) => {
      const items = all.filter(x => x.status === st); if (!items.length) return;
      const g = document.createElement('div'); g.className = 'qgroup'; g.innerHTML = '<h3><span class="pill ' + st + '">' + items.length + '</span>' + label + '</h3>';
      items.forEach(x => {
        const ci = COMMITS.findIndex(c => c.sha === x.commit);
        const b = document.createElement('button'); b.className = 'qitem';
        b.innerHTML = '<div class="where">' + (ci + 1) + ' · ' + esc(x.path ? x.path + (x.line ? ':' + x.line : '') : 'commit-level') + ' · ' + (x.author === 'claude' ? 'Claude' : 'you') + '</div><div class="snip">' + esc(x.body.split('\n')[0]) + '</div>';
        b.onclick = () => { go(ci); setTimeout(() => { const t = x.path && x.line ? document.querySelector('[data-ids~="' + rowId(ci, x.path, x.line, x.side || 'RIGHT') + '"]') : document.getElementById('commit'); if (t) { const sec = t.closest('.file'); if (sec) { sec.classList.remove('collapsed'); sec.hidden = false; } t.scrollIntoView({ block: 'center' }); flashRow(t); } }, 0); };
        g.appendChild(b);
      });
      el.appendChild(g);
    });
  }

  // Arrows move between the page's regions: Right enters the review queue, Left returns to the diff; Up and Down move within the region.
  let region = 'diff', qCur = 0;
  const qStops = () => Array.from(document.querySelectorAll('#queue button')).filter(b => b.offsetParent);
  function markQ(scroll) {
    const st = qStops(); qCur = Math.max(0, Math.min(st.length - 1, qCur));
    st.forEach((b, i) => b.classList.toggle('qcur', region === 'queue' && i === qCur));
    if (scroll && region === 'queue' && st[qCur]) st[qCur].scrollIntoView({ block: 'nearest' });
  }
  function toQueue() { if (region !== 'diff' || !qStops().length) return; region = 'queue'; markQ(true); }
  function toDiff() { if (region === 'commits') { region = 'diff'; markStep(); return; } if (region !== 'queue') return; region = 'diff'; markQ(false); }
  function moveQ(d) { qCur += d; markQ(true); }
  function renderAll() { renderStepper(); renderCommit(); renderFiles(); renderQueue(); renderChangeBanner(); measureHead(); renderFeedback(); restoreDrafts(); saveUi(); markQ(false); markStep(); markSel(); restoreFocus(); }
  // The text box being typed in keeps focus across reloads and re-renders, so keys go into it instead of firing shortcuts.
  let focusPos = 0;
  document.addEventListener('focusin', e => { if (e.target.tagName === 'TEXTAREA' && e.target.id) lsSet('focus', e.target.id); });
  document.addEventListener('focusout', e => { if (e.target.tagName === 'TEXTAREA') setTimeout(() => { const a = document.activeElement; if (document.hasFocus() && (!a || a.tagName !== 'TEXTAREA')) lsSet('focus', ''); }, 0); });
  ['input', 'keyup', 'click'].forEach(ev => document.addEventListener(ev, e => { if (e.target.tagName === 'TEXTAREA') { focusPos = e.target.selectionStart; lsSet('focuspos', String(focusPos)); } }));
  // Sending a message (or saving a comment) ends the typing: the box loses focus and is not focused again by the re-render,
  // so the keyboard shortcuts work right away.
  const SEND_BTNS = '#ask-send, #composer-save, [data-act="followup"], [data-act="sendnote"], [data-act="saveedit"]';
  document.addEventListener('click', e => {
    if (!e.target.closest || !e.target.closest(SEND_BTNS)) return;
    lsSet('focus', ''); setTimeout(() => { const a = document.activeElement; if (a && a.tagName === 'TEXTAREA' && a.blur) a.blur(); lsSet('focus', ''); }, 0);
  }, true);
  function restoreFocus() {
    const id = lsGet('focus'), ta = id && document.getElementById(id), a = document.activeElement;
    if (!ta || a === ta || (a && a.tagName === 'TEXTAREA')) return;
    const pos = Math.min(parseInt(lsGet('focuspos') || '0', 10) || 0, ta.value.length);
    ta.focus({ preventScroll: true }); ta.setSelectionRange(pos, pos);
  }
  // Esc leaves every text box too: forget the remembered one so the re-render does not focus it again.
  function closeAll() { showKeys(false); clearSel(); lsSet('focus', ''); const a = document.activeElement; if (a && a.blur && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT')) a.blur(); openComposer = null; openAsk = null; editing = null; fbOpen = false; showFbDone = false; fbCur = Infinity; subOpen = false; renderSubmit(); renderAll(); }
  // Submitting the review is the viewer's explicit, two-click action; Claude performs it on GitHub when notified.
  let subOpen = false;
  function toggleSubmit() { subOpen = !subOpen; if (subOpen && fbOpen) { fbOpen = false; renderFeedback(); } renderSubmit(); }
  document.getElementById('submitrev').onclick = toggleSubmit;
  // On the viewer's own PR there is nothing to approve: the header action pushes the approved review branch instead.
  if (PR_MINE) { const sb = document.getElementById('submitrev'); sb.textContent = 'Push to the PR'; sb.setAttribute('aria-label', 'Push the review branch to the PR'); }
  function renderSubmit() {
    const old = document.getElementById('sub-panel'); const keep = old ? { body: old.querySelector('#sub-body').value, ev: (old.querySelector('input[name=subev]:checked') || {}).value } : null;
    if (old) old.remove(); if (!subOpen) return;
    const all = Object.values(comments);
    const queued = all.filter(x => x.status === 'queued' && !x.replyToConv), atSubmit = queued.filter(x => x.deferred).length, inDraft = queued.length - atSubmit, conv = all.filter(x => x.status === 'queued' && x.replyToConv).length, syncing = all.filter(x => x.syncPending).length;
    const p = document.createElement('div'); p.id = 'sub-panel'; p.className = 'fbpanel';
    if (PR_MINE) { renderPushPanel(p, queued.length, conv, syncing); return; }
    p.innerHTML = '<div class="fbpanel-head"><b>Submit your review</b><button class="btn small" aria-label="Close">✕</button></div>' +
      '<div class="hint">' + inDraft + ' comment' + (inDraft === 1 ? '' : 's') + ' in your pending GitHub review' + (atSubmit ? ' + ' + atSubmit + ' added at submit' : '') + (syncing ? ' · ' + syncing + ' still syncing' : '') + '. Submitting makes them public.</div>' +
      '<textarea id="sub-body" placeholder="Review summary (optional)"></textarea>' +
      '<div class="subev">' + [['COMMENT', 'Comment'], ['APPROVE', 'Approve'], ['REQUEST_CHANGES', 'Request changes']].map(([v, l], i) => '<label><input type="radio" name="subev" value="' + v + '"' + (i === 0 ? ' checked' : '') + '> ' + l + '</label>').join('') + '</div>' +
      (conv ? '<label class="subconv"><input type="checkbox" id="sub-conv" checked> Also post ' + conv + ' queued conversation repl' + (conv === 1 ? 'y' : 'ies') + '</label>' : '') +
      '<div class="actions"><button class="btn primary small" id="sub-go">Submit review</button><button class="btn small" id="sub-cancel">Cancel</button></div>';
    if (keep) { p.querySelector('#sub-body').value = keep.body; const r = p.querySelector('input[value="' + keep.ev + '"]'); if (r) r.checked = true; }
    p.querySelector('.fbpanel-head button').onclick = p.querySelector('#sub-cancel').onclick = () => { subOpen = false; renderSubmit(); };
    const go = p.querySelector('#sub-go');
    // Changing the review type asks for the confirming click again.
    p.querySelectorAll('input[name=subev]').forEach(r => r.onchange = () => { delete go.dataset.armed; go.textContent = 'Submit review'; });
    go.onclick = async () => {
      const ev = p.querySelector('input[name=subev]:checked').value, label = { COMMENT: 'comment', APPROVE: 'approve', REQUEST_CHANGES: 'request changes' }[ev];
      if (!go.dataset.armed) { go.dataset.armed = '1'; go.textContent = 'Click again: submit as "' + label + '" (public)'; return; }
      const body = p.querySelector('#sub-body').value.trim(), withConv = !!(p.querySelector('#sub-conv') || {}).checked;
      // Docs still syncing need Claude to update the draft first, so those submits go through Claude.
      if (mcp && !syncing) {
        go.disabled = true; go.textContent = 'Submitting to GitHub…'; ghStatus('Submitting your review to GitHub…');
        try {
          const failed = await submitDirect(ev, body, withConv); dropDraft('sub-body'); subOpen = false; renderSubmit();
          ghStatus(failed ? 'Review submitted; ' + failed + ' repl' + (failed === 1 ? 'y' : 'ies') + ' not posted (see the GitHub error pill)' : 'Review submitted on GitHub', REPO + '/pull/' + PR_NUMBER, failed ? 0 : 6000); return;
        }
        catch (e) { ghStatus(null); toast('GitHub call failed (' + (e && e.code || 'error') + '); asking Claude to submit'); }
      }
      const sent = await notifyClaude({ id: 'submit-' + Date.now().toString(36) }, 'event=' + ev + ' postConversationReplies=' + (withConv ? 'yes' : 'no') + '\n' + body, document.getElementById('submitrev'), 'submit review');
      if (sent || !notifyErr) dropDraft('sub-body'); subOpen = false; renderSubmit(); toast(sent || !notifyErr ? 'Sent to Claude: submitting your review' : 'Claude was not notified; tell Claude in chat to submit');
    };
    document.body.appendChild(p); placePanels(); restoreDrafts(); saveUi(); setTimeout(() => p.querySelector('#sub-body').focus(), 0);
  }
  // Own PR: force-push the review branch (every accepted change) onto the PR branch on the fork, and post queued replies with it.
  function renderPushPanel(p, nQueued, conv, syncing) {
    const acc = Object.values(changes).filter(x => x.status === 'accepted'), applying = acc.filter(x => x.applied === false).length;
    const br = esc((acc.find(x => x.branch) || {}).branch || 'review/pr-' + PR_NUMBER), posts = nQueued + conv;
    p.innerHTML = '<div class="fbpanel-head"><b>Push to the PR</b><button class="btn small" aria-label="Close">✕</button></div>' +
      '<div class="hint">' + (acc.length ? acc.length + ' accepted change' + (acc.length === 1 ? '' : 's') + ' on <code>' + br + '</code>' + (applying ? ' · ' + applying + ' still applying' : '') + '; Claude force-pushes it onto the PR branch on your fork (never upstream).' : 'No accepted changes to push.') + (posts ? ' ' + posts + ' queued repl' + (posts === 1 ? 'y is' : 'ies are') + ' posted with it.' : '') + (syncing ? ' ' + syncing + ' still syncing.' : '') + '</div>' +
      (posts ? '<textarea id="sub-body" placeholder="Comment posted with the replies (optional)"></textarea>' : '<textarea id="sub-body" hidden></textarea>') +
      '<div class="actions"><button class="btn primary small" id="sub-go"' + ((!acc.length && !posts) || applying ? ' disabled' : '') + '>Push to the PR</button><button class="btn small" id="sub-cancel">Cancel</button></div>';
    p.querySelector('.fbpanel-head button').onclick = p.querySelector('#sub-cancel').onclick = () => { subOpen = false; renderSubmit(); };
    const go = p.querySelector('#sub-go');
    go.onclick = async () => {
      if (!go.dataset.armed) { go.dataset.armed = '1'; go.textContent = acc.length ? 'Click again: force-push to the PR' : 'Click again: post publicly'; return; }
      go.disabled = true; const body = p.querySelector('#sub-body').value.trim();
      if (acc.length) {
        const sid = await notifyClaude({ id: 'push-' + Date.now().toString(36) }, br + ' (' + acc.map(x => x.id).join(', ') + ')', document.getElementById('submitrev'), 'push review branch');
        toast(sid || !notifyErr ? 'Sent to Claude: pushing the review branch to the PR' : 'Claude was not notified; ask in chat to push the review branch');
      }
      if (posts) {
        if (mcp && !syncing) { try { const failed = await submitDirect('COMMENT', body, true); ghStatus(failed ? failed + ' repl' + (failed === 1 ? 'y' : 'ies') + ' not posted (see the GitHub error pill)' : 'Replies posted on GitHub', REPO + '/pull/' + PR_NUMBER, failed ? 0 : 6000); } catch (e) { toast('GitHub call failed; asking Claude to post'); await notifyClaude({ id: 'submit-' + Date.now().toString(36) }, 'event=COMMENT postConversationReplies=yes\n' + body, document.getElementById('submitrev'), 'submit review'); } }
        else await notifyClaude({ id: 'submit-' + Date.now().toString(36) }, 'event=COMMENT postConversationReplies=yes\n' + body, document.getElementById('submitrev'), 'submit review');
      }
      dropDraft('sub-body'); subOpen = false; renderSubmit();
    };
    document.body.appendChild(p); placePanels(); restoreDrafts(); saveUi(); setTimeout(() => (posts ? p.querySelector('#sub-body') : go).focus(), 0);
  }
  function stepReviewType(dir) {
    const rs = Array.from(document.querySelectorAll('#sub-panel input[name=subev]')); if (!rs.length) return;
    const i = rs.findIndex(r => r.checked), n = rs[(i + dir + rs.length) % rs.length]; n.checked = true; n.onchange();
  }
  // A status line that stays up while GitHub works; a link when done.
  function ghStatus(msg, href, ms) {
    let el = document.getElementById('ghstatus'); if (!msg) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'ghstatus'; document.body.appendChild(el); }
    el.textContent = msg + (href ? ' · ' : ''); if (href) { const a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'open on GitHub'; el.appendChild(a); }
    if (ms) setTimeout(() => { if (el.isConnected && el.firstChild && el.firstChild.textContent.startsWith(msg)) el.remove(); }, ms);
  }
  const errText = e => String((e && (e.message || e.code)) || 'error').slice(0, 300);
  // The viewer's pending review (only its author can see it), or null.
  async function pendingReview(base) {
    for (let page = 1; page <= 10; page++) {
      const r = await mcp.callTool(GH_SERVER, 'pull_request_read', Object.assign({ method: 'get_reviews', perPage: 100, page }, base));
      const list = Array.isArray(r && r.payload) ? r.payload : [];
      const p = list.find(x => x.state === 'PENDING'); if (p) return p;
      if (list.length < 100) return null;
    }
    return null;
  }
  // Submits in order: comments the sync could not put into the draft are added to it, the review is submitted with
  // the draft's own body kept ahead of the summary, then replies are posted (GitHub takes them only after a submit).
  // A doc is marked posted only once its own call succeeded. Throws before the submit, so Claude can take over;
  // resolves with the number of replies left unposted.
  async function submitDirect(ev, body, withConv) {
    const [owner, repo] = REPO_SLUG.split('/'), now = new Date().toISOString(), base = { owner, repo, pullNumber: PR_NUMBER };
    if (withConv) for (const c of Object.values(comments).filter(x => x.status === 'queued' && x.replyToConv)) {
      ghStatus('Posting conversation replies…');
      const r = await mcp.callTool(GH_SERVER, 'add_issue_comment', { owner, repo, issue_number: PR_NUMBER, body: 'In reply to [' + (c.convAuthor || 'comment') + '](' + c.replyToConv + '):\n\n' + c.body });
      await write(c.id, { status: 'posted', githubUrl: (r && r.payload && r.payload.html_url) || null, postedAt: now });
    }
    const queued = Object.values(comments).filter(x => x.status === 'queued' && !x.replyToConv);
    const adds = queued.filter(x => x.deferred && x.githubPlan && x.githubPlan.kind !== 'reply');
    const replies = queued.filter(x => x.deferred && x.githubPlan && x.githubPlan.kind === 'reply');
    const inDraft = queued.filter(x => !x.deferred && (x.inDraft || x.source === 'github'));
    ghStatus('Reading your GitHub draft…');
    let draft = await pendingReview(base);
    if (!draft && adds.length) {
      await mcp.callTool(GH_SERVER, 'pull_request_review_write', Object.assign({ method: 'create' }, base));
      draft = await pendingReview(base); if (!draft) throw new Error('no pending review after creating one');
    }
    for (const c of adds) {
      ghStatus('Adding comments to your GitHub draft…');
      const p = c.githubPlan, a = Object.assign({ path: p.path, body: p.body, subjectType: p.kind === 'line' ? 'LINE' : 'FILE' }, base);
      if (p.kind === 'line') { a.line = p.line; a.side = p.side || 'RIGHT'; if (p.startLine) { a.startLine = p.startLine; a.startSide = a.side; } }
      try { await mcp.callTool(GH_SERVER, 'add_comment_to_pending_review', a); }
      catch (e) { await write(c.id, { deferredError: errText(e) }); throw e; }
      // The connector returns no comment id: the next sync finds the comment by its path and text.
      await write(c.id, { inDraft: true, githubBody: p.body, githubPath: p.path, deferred: null, githubPlan: null, deferredError: null });
      inDraft.push(c);
    }
    ghStatus('Submitting your review to GitHub…');
    if (draft) {
      const kept = (draft.body || '').trim(), full = !kept ? body : !body || kept.includes(body) ? kept : kept + '\n\n' + body;
      await mcp.callTool(GH_SERVER, 'pull_request_review_write', Object.assign({ method: 'submit_pending', event: ev, body: full }, base));
    } else if (body || ev !== 'COMMENT') await mcp.callTool(GH_SERVER, 'pull_request_review_write', Object.assign({ method: 'create', event: ev, body }, base));
    for (const c of inDraft) await write(c.id, { status: 'posted', postedAt: now });
    let failed = 0;
    for (const c of replies) {
      ghStatus('Posting replies…');
      const p = c.githubPlan;
      try {
        if (!p.inReplyTo) throw new Error('no GitHub comment id for this thread');
        const r = await mcp.callTool(GH_SERVER, 'add_reply_to_pull_request_comment', Object.assign({ commentId: Number(p.inReplyTo), body: p.body }, base));
        const x = (r && r.payload) || {};
        await write(c.id, { status: 'posted', postedAt: now, githubUrl: x.html_url || null, githubCommentId: x.id ? Number(x.id) : null, deferred: null, githubPlan: null, deferredError: null });
      } catch (e) { failed++; await write(c.id, { deferredError: errText(e) }); }
    }
    return failed;
  }
  // Feedback conversations with Claude live in a panel by the Feedback button, never in the diff.
  let fbOpen = false, showFbDone = false;
  function renderFeedback() {
    const old = document.getElementById('fb-panel'); const draft = old && old.querySelector('#ask-ta') ? old.querySelector('#ask-ta').value : '';
    if (old) old.remove(); if (!fbOpen) return;
    const p = document.createElement('div'); p.id = 'fb-panel'; p.className = 'fbpanel';
    p.innerHTML = '<div class="fbpanel-head"><b>Feedback on the review tool</b><button class="btn small" aria-label="Close feedback">✕</button></div>';
    p.querySelector('.fbpanel-head button').onclick = closeFeedback;
    // Answered feedback (fixed, or an issue filed) is dismissed on its own; a link brings it back.
    const fbAll = Object.values(threads).filter(t => t.kind === 'feedback'), fbDone = fbAll.filter(t => t.status === 'answered').length;
    if (fbDone) { const l = document.createElement('button'); l.className = 'btn small'; l.textContent = showFbDone ? 'Hide resolved feedback' : 'Show ' + fbDone + ' resolved'; l.onclick = () => { showFbDone = !showFbDone; renderFeedback(); }; l.classList.add('fbstop'); p.appendChild(l); }
    fbAll.filter(t => (showFbDone || t.status !== 'answered') && visibleThread(t)).sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '')).forEach(t => { const card = threadCard(t, document.getElementById('feedback')); card.classList.add('fbstop'); p.appendChild(card); });
    const comp = askComposer({ commit: COMMITS[current].sha, commitIdx: current, kind: 'feedback' }, document.getElementById('feedback'));
    comp.querySelector('#ask-cancel').onclick = closeFeedback; comp.classList.add('fbstop');
    if (draft) comp.querySelector('#ask-ta').value = draft;
    p.appendChild(comp); document.body.appendChild(p); placePanels(); restoreDrafts(); saveUi(); markFb(false);
  }
  // Closing the panel always folds the resolved feedback away again.
  function closeFeedback() { fbOpen = false; showFbDone = false; fbCur = Infinity; renderFeedback(); }
  // j / l move between the panel's items (resolved toggle, conversations, the new-feedback box); Enter acts on one.
  // The panel opens on the new-feedback box, its last item.
  let fbCur = Infinity;
  function markFb(scroll) {
    const st = Array.from(document.querySelectorAll('#fb-panel .fbstop')); fbCur = Math.max(0, Math.min(st.length - 1, fbCur));
    st.forEach((el, i) => el.classList.toggle('fbcur', i === fbCur)); if (scroll && st[fbCur]) st[fbCur].scrollIntoView({ block: 'nearest' });
  }
  function fbKey(k) {
    const st = Array.from(document.querySelectorAll('#fb-panel .fbstop')); if (!st.length) return false;
    if (k === 'j' || k === 'ArrowUp') { fbCur--; markFb(true); return true; }
    if (k === 'l' || k === 'ArrowDown') { fbCur++; markFb(true); return true; }
    if (k === 'Enter') { const el = st[fbCur]; if (!el) return false; if (el.tagName === 'BUTTON') el.click(); else { const ta = el.querySelector('textarea'); if (ta) ta.focus(); } return true; }
    return false;
  }
  // Header panels open just under the button that opened them, not below the whole header.
  function placePanels() { [['fb-panel', 'feedback'], ['sub-panel', 'submitrev']].forEach(([pid, bid]) => { const p = document.getElementById(pid), b = document.getElementById(bid); if (!p || !b) return; const top = Math.max(8, Math.round(b.getBoundingClientRect().bottom + 6)); p.style.top = top + 'px'; p.style.maxHeight = 'calc(100vh - ' + (top + 16) + 'px)'; }); }
  function measureHead() { const st = document.documentElement.style, fh = document.querySelector('#files .file-head'); st.setProperty('--head-h', document.getElementById('top').offsetHeight + 'px'); if (fh) st.setProperty('--fh-h', fh.offsetHeight + 'px'); }
  function go(i) { if (i < 0 || i >= COMMITS.length) return; current = i; cursorId = null; openComposer = null; editing = null; location.hash = 'commit-' + (i + 1); renderAll(); window.scrollTo({ top: 0 }); }
  function fromHash() { const m = /^#commit-(\d+)$/.exec(location.hash); const i = m ? parseInt(m[1], 10) - 1 : 0; if (i >= 0 && i < COMMITS.length && i !== current) { current = i; openComposer = null; editing = null; renderAll(); } }

  function renderMode() { document.getElementById('mode').textContent = viewMode === 'split' ? 'Unified' : 'Split'; }
  document.getElementById('mode').onclick = () => { viewMode = viewMode === 'split' ? 'unified' : 'split'; lsSet('viewmode', viewMode); renderMode(); renderFiles(); };
  renderMode();
  // Feedback on the tool goes to Claude, which writes it up as an issue on the tool's repo.
  const WAIT_DOTS = '<span class="dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>';
  const FEEDBACK_REPO = 'QuerthDP/review-artifact';
  function toggleFeedback(e) {
    if (fbOpen) { closeFeedback(); return; }
    fbOpen = true; if (subOpen) { subOpen = false; renderSubmit(); }
    renderFeedback();
    // Opening the panel, by click or by the f key, goes straight to typing.
    setTimeout(() => { const ta = document.querySelector('#fb-panel #ask-ta'); if (ta) ta.focus(); }, 0);
  }
  document.getElementById('feedback').onclick = toggleFeedback;
  // A fresh Claude review of the whole PR: the first click arms, the second sends; its findings arrive as proposed comments.
  document.getElementById('askreview').onclick = async () => {
    const b = document.getElementById('askreview');
    if (!b.dataset.armed) { b.dataset.armed = '1'; b.textContent = 'Click again: review the PR'; setTimeout(() => { if (b.dataset.armed === '1') { delete b.dataset.armed; b.textContent = 'Ask Claude to review'; } }, 5000); return; }
    b.dataset.armed = 'sent'; b.disabled = true; b.textContent = 'Review requested';
    const sent = await notifyClaude({ id: 'rev-' + Date.now().toString(36) }, 'scope=pr viewing commit ' + (current + 1) + '/' + COMMITS.length, b, 'review request');
    if (sent || !notifyErr) toast('Claude is reviewing the PR; its comments will appear as proposals');
    else { delete b.dataset.armed; b.disabled = false; b.textContent = 'Ask Claude to review'; }
  };
  function renderQueueToggle() { const hidden = lsGet('queuehidden') === '1'; document.body.classList.toggle('queue-hidden', hidden); document.getElementById('queuetoggle').textContent = hidden ? 'Show queue' : 'Hide queue'; }
  document.getElementById('queuetoggle').onclick = () => { lsSet('queuehidden', lsGet('queuehidden') === '1' ? '0' : '1'); renderQueueToggle(); measureHead(); };
  renderQueueToggle();
  document.getElementById('prev').onclick = () => go(current - 1);
  document.getElementById('next').onclick = () => go(current + 1);
  window.addEventListener('hashchange', fromHash);
  window.addEventListener('resize', () => { measureHead(); placePanels(); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureHead);
  if (window.ResizeObserver) new ResizeObserver(measureHead).observe(document.getElementById('top'));
  function flashRow(t) { if (!t.classList) return; t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); }
  // Keyboard cursor: one selected stop (file header, expander row or diff line) so the review can be done without a mouse.
  let cursorId = null;
  // In the split view the cursor sits on one side of a line, the old (LEFT) or the new (RIGHT) version; ← / → switch it.
  // The side sticks while moving; a row with nothing on that side shows the cursor on its other side.
  let cursorSide = 'RIGHT';
  const isSplitRow = el => viewMode === 'split' && el && el.matches && el.matches('#files tr.line, #files tr.ovnew');
  const rowHas = (tr, side) => !!tr.querySelector(side === 'LEFT' ? 'td.code.l:not(.empty)' : 'td.code.r:not(.empty)');
  const effSide = tr => !isSplitRow(tr) ? null : rowHas(tr, cursorSide) ? cursorSide : (cursorSide === 'LEFT' ? 'RIGHT' : 'LEFT');
  // With gh set (j / l) the stops also include each GitHub reviewer thread, so the keyboard can enter it without the arrows.
  const stops = gh => Array.from(document.querySelectorAll('#commit .gstop, #files .file-head, #files tr.line, #files tr.ovnew.done, #files tr.hunk' + (gh ? ', #files .thread > .ghthread' : ''))).filter(el => !el.closest('[hidden]') && (el.classList.contains('file-head') || !el.closest('.collapsed')));
  function applyCursor() {
    document.querySelectorAll('.kcur').forEach(x => x.classList.remove('kcur')); document.querySelectorAll('td.kcell').forEach(x => x.classList.remove('kcell', 'kfirst'));
    const el = cursorId && document.getElementById(cursorId); if (!el) return; el.classList.add('kcur');
    const sd = effSide(el); if (!sd) return;
    const tds = el.children, k = sd === 'LEFT' ? 0 : 2; if (tds.length < 4) return;
    tds[k].classList.add('kcell', 'kfirst'); tds[k + 1].classList.add('kcell');
  }
  // ← / → on a split line move the cursor to that side; with nowhere to go, the keys keep moving between the diff and the queue.
  function sideKey(side) {
    const cur = region === 'diff' && current_(); if (!isSplitRow(cur)) return false;
    if (selFrom && selSide && selSide !== side) { cursorSide = side; selSide = side; applyCursor(); markSel(); return true; }
    if (effSide(cur) === side || !rowHas(cur, side)) return false;
    cursorSide = side; if (selFrom) selSide = side; applyCursor(); markSel(); return true;
  }
  function setCursor(el, scroll) {
    if (!el || !el.id) return; cursorId = el.id; applyCursor(); savePos(); if (scroll === false) return;
    const r = el.getBoundingClientRect(), topPad = coverTop() + 12, botPad = 60;
    if (r.top < topPad) window.scrollBy(0, r.top - topPad); else if (r.bottom > window.innerHeight - botPad) window.scrollBy(0, r.bottom - window.innerHeight + botPad);
  }
  // Height covered by the sticky page header and the sticky file header; a selected line must stay below it.
  function coverTop() { const fh = document.querySelector('#files .file-head'); return document.getElementById('top').offsetHeight + (fh ? fh.offsetHeight : 0); }
  // c jumps back to the commit message at the top; pressing it again returns to the cursor and scroll position it
  // left.
  let topReturn = null;
  function toggleTop() {
    if (topReturn) { const back = topReturn; topReturn = null; const el = back.id && document.getElementById(back.id); if (el) setCursor(el, false); window.scrollTo(0, back.y); return; }
    topReturn = { id: cursorId, y: window.scrollY };
    const first = stops()[0]; if (first && first.closest('#commit')) setCursor(first, false);
    window.scrollTo(0, 0);
  }
  function current_() { const el = cursorId && document.getElementById(cursorId); return el && el.classList.contains('kcur') ? el : null; }
  function nearestStop(list, y) { let best = list[0], bd = Infinity; list.forEach(el => { const d = Math.abs(el.getBoundingClientRect().top - y); if (d < bd) { bd = d; best = el; } }); return best; }
  function moveCursor(dir, gh) {
    const list = stops(gh); if (!list.length) return; lastCmt = null;
    const sel = current_(); const cur = sel && list.includes(sel) ? sel : lineOf(sel); const i = cur ? list.indexOf(cur) : -1;
    setCursor(i < 0 ? nearestStop(list, coverTop() + 12) : list[Math.max(0, Math.min(list.length - 1, i + dir))]);
  }
  // A selected comment card stands for the diff line it hangs under (j / l, k, i, m); file-level cards for the file header.
  // Rows of an accepted change drawn into the diff are not lines: neighbours are found past them.
  const skipOv = (n, dir) => { while (n && n.classList && n.classList.contains('ovnew')) n = dir < 0 ? n.previousElementSibling : n.nextElementSibling; return n; };
  function lineOf(el) {
    if (!el || !el.parentElement || !el.parentElement.classList.contains('thread')) return el;
    const tr = el.closest('tr.cmt'); if (tr) return skipOv(tr.previousElementSibling, -1);
    const sec = el.closest('.file'); return sec ? sec.querySelector('.file-head') : el;
  }
  // Arrows also stop on each comment card, reviewer thread and conversation, so the keyboard can enter them; Up from the top reaches the commit stepper.
  const arrowStops = () => Array.from(document.querySelectorAll('#commit .gstop, #files .file-head, #files tr.line, #files tr.ovnew.done, #files tr.hunk, #files .thread > .card, #files .thread > .chat, #files .thread > .ghthread')).filter(el => !el.closest('[hidden]') && (el.classList.contains('file-head') || !el.closest('.collapsed')));
  function arrowMove(dir) {
    const list = arrowStops(); if (!list.length) return; lastCmt = null;
    const cur = current_(); const i = cur ? list.indexOf(cur) : -1;
    if (i === 0 && dir < 0) { toCommits(); return; }
    setCursor(i < 0 ? nearestStop(list, coverTop() + 12) : list[Math.max(0, Math.min(list.length - 1, i + dir))]);
  }
  function toCommits() { region = 'commits'; document.querySelectorAll('.kcur').forEach(x => x.classList.remove('kcur')); markStep(); window.scrollTo({ top: 0 }); }
  function markStep() { document.querySelectorAll('#stepper .step').forEach((b, i) => b.classList.toggle('qcur', region === 'commits' && i === current)); const a = document.querySelector('#stepper .step.qcur'); if (a) a.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  function fromCommits() { region = 'diff'; markStep(); const list = arrowStops(); if (list.length) setCursor(list[0]); }
  // Enter on a card opens its reply: the reviewer thread's reply box, the follow-up to Claude, or a revision note / edit of a comment.
  function enterCard(cur) {
    if (cur.classList.contains('change')) { const b = cur.querySelector('[data-act="accept"]') || cur.querySelector('[data-act="expand"]'); if (b) b.click(); else toast('Nothing to accept here'); return; }
    if (cur.classList.contains('ghthread')) { cur.open = true; const b = Array.from(cur.querySelectorAll(':scope > .actions .btn')).pop(); if (b) b.click(); return; }
    if (cur.classList.contains('chat')) { const t = cur.querySelector('.followup textarea'); if (t) t.focus(); return; }
    const b = cur.querySelector('[data-act="edit"]'); if (b) b.click(); else toast('Nothing to reply to here');
  }
  function pageCursor(dir) {
    const cur = current_(); const y = cur ? cur.getBoundingClientRect().top : 160;
    // Step by the area left under the sticky page and file headers, keeping two lines of overlap, so no line is skipped.
    const cover = coverTop();
    window.scrollBy(0, dir * Math.max(120, window.innerHeight - cover - 44)); lastCmt = null;
    const list = stops(); if (list.length) setCursor(nearestStop(list, Math.max(cover + 12, Math.min(y, window.innerHeight - 80))), false);
  }
  // Shift + j / l (or Shift + Up / Down, or Shift + click on a line's button) picks a range of lines in one file and side;
  // k, i and m then open one multi-line comment or request whose start line is the top of the range.
  let selFrom = null;
  // A range keeps the side it was started on (split view), even across rows that have nothing on that side.
  let selSide = null;
  function lineLabel(a) { return a.line ? ':' + (a.startLine ? a.startLine + '-' : '') + a.line : ''; }
  function selRows() {
    const a = selFrom && document.getElementById(selFrom), b = lineOf(current_());
    if (!a || !b || !b.matches('tr.line, tr.ovnew.done') || a === b || a.closest('.file') !== b.closest('.file')) return null;
    const all = Array.from(a.closest('.file').querySelectorAll('tr.line, tr.ovnew.done')), i = all.indexOf(a), k = all.indexOf(b);
    return all.slice(Math.min(i, k), Math.max(i, k) + 1);
  }
  // An open composer or question on a range keeps it framed until it is sent or closed.
  function openRangeRows() {
    const a = [openComposer, openAsk].find(x => x && x.startLine && x.path && x.commitIdx === current); if (!a) return null;
    const rows = []; for (let n = a.startLine; n <= a.line; n++) { const tr = document.querySelector('[data-ids~="' + rowId(current, a.path, n, a.side || 'RIGHT') + '"]'); if (tr && rows.indexOf(tr) < 0) rows.push(tr); }
    return rows.length ? rows : null;
  }
  function markSel() {
    document.querySelectorAll('tr.sel').forEach(x => x.classList.remove('sel', 'sel-first', 'sel-last')); document.querySelectorAll('td.scell').forEach(x => x.classList.remove('scell', 'sfirst'));
    const picked = selRows(), r = picked || openRangeRows() || []; r.forEach(x => x.classList.add('sel')); if (!r.length) return;
    r[0].classList.add('sel-first'); r[r.length - 1].classList.add('sel-last');
    // In the split view the range is framed on its side: the cursor's side while picking, the anchor's side once a composer is open.
    if (viewMode !== 'split') return;
    const open = !picked && [openComposer, openAsk].find(x => x && x.startLine && x.path && x.commitIdx === current);
    const side = open ? (open.side || 'RIGHT') : (selSide || effSide(lineOf(current_())) || cursorSide), k = side === 'LEFT' ? 0 : 2;
    r.forEach(x => { const tds = x.children; if (tds.length < 4) return; tds[k].classList.add('scell', 'sfirst'); tds[k + 1].classList.add('scell'); });
  }
  function clearSel() { selFrom = null; selSide = null; markSel(); }
  function extendSel(dir) {
    const cur = lineOf(current_()); if (!selFrom && cur && cur.matches('tr.line, tr.ovnew.done')) { selFrom = cur.id; selSide = effSide(cur); }
    moveCursor(dir); markSel();
  }
  const sideLines = (tr, side) => Array.from(tr.querySelectorAll('.addbtn')).filter(x => x.dataset.side === side).map(x => parseInt(x.dataset.line, 10));
  function withRange(anchor, tr, e) {
    if (e && e.shiftKey) { const cur = lineOf(current_()); if (cur && cur.matches('tr.line') && cur !== tr) selFrom = cur.id; setCursor(tr, false); }
    const rows = selRows(); clearSel(); if (!rows || rows.indexOf(tr) < 0) return anchor;
    const lines = rows.flatMap(x => sideLines(x, anchor.side)), lo = Math.min.apply(null, lines), hi = Math.max.apply(null, lines);
    if (!lines.length || lo >= hi) return anchor;
    return Object.assign(anchor, { line: hi, startLine: lo });
  }
  function lineAction(sel) {
    // i on a selected comment talks to Claude inside it: a Claude comment gets its revision box, a conversation its
    // follow-up, and your own comments and reviewers' threads a conversation drawn inside them.
    if (sel === '.askbtn') {
      const here = current_(), pick = '.card, .chat, .ghthread';
      const item = lastCmt ? (lastCmt.matches(pick) ? lastCmt : lastCmt.querySelector('.thread > .card, .thread > .chat, .thread > .ghthread')) : here && here.matches(pick) ? here : null;
      if (item && item.matches('.chat')) { const ta = item.querySelector('.followup textarea'); if (ta) { ta.scrollIntoView({ block: 'center' }); ta.focus(); return; } }
      const c = item && item.matches('.card') && comments[item.dataset.cid];
      if (c) {
        const rev = Array.from(item.querySelectorAll('[data-act="edit"]')).find(x => x.textContent === 'Ask Claude to revise');
        if (rev) { rev.click(); return; }
        askAbout({ commit: c.commit, commitIdx: current, path: c.path || null, line: c.line || null, startLine: c.startLine || null, side: c.side || null, about: c.id, aboutText: c.body || '' }); return;
      }
      const gt = item && item.matches('.ghthread') && item.id && GH.threads.find(t => 'ghs-' + t.id === item.id);
      if (gt) { const gb = item.querySelector('.ghbody'); askAbout({ commit: gt.commit, commitIdx: current, path: gt.path || null, line: gt.line || null, side: gt.side || null, about: gt.id, aboutText: gb ? gb.textContent : '' }); return; }
    }
    const cur = lineOf(current_());
    if (cur && cur.classList.contains('gstop')) { const b = document.querySelector(sel === '.askbtn' ? '#commit [data-i]' : sel === '.addbtn' ? '#commit [data-k]' : sel === '.modbtn' ? '#commit [data-m]' : null); if (b) b.click(); else toast('Not available at commit level'); return; }
    // A line an accepted change wrote exists only on the review branch: i and m talk to Claude about it (anchored at the
    // change's lines), while a GitHub comment has to wait until the branch is pushed to the PR. In the split view the
    // filled right side of a removed line counts as that new line.
    // A range picked over them asks about exactly those lines; it cannot mix them with the PR's own lines.
    const picked = selRows(), pSide = picked ? (viewMode === 'split' ? (selSide || effSide(cur) || 'RIGHT') : 'RIGHT') : null;
    const ovSide = viewMode === 'split' ? (effSide(cur) || 'RIGHT') : 'RIGHT';
    const ovRows = picked ? picked.filter(r => isOvRow(r, pSide)) : isOvRow(cur, ovSide) ? [cur] : [];
    if (ovRows.length) {
      if (sel === '.addbtn') { toast('These lines are only on the review branch: comment on them on GitHub after Push to the PR, or ask Claude with i'); return; }
      const others = picked ? picked.filter(r => !isOvRow(r, pSide) && (viewMode !== 'split' || rowHas(r, pSide))) : [];
      if (others.length || ovRows.some(r => r.dataset.chg !== ovRows[0].dataset.chg)) { toast('A range cannot mix the lines of an accepted change with other lines'); return; }
      if (sel === '.askbtn' && !picked) {
        // As on any line, i continues the conversation already open under it.
        const cmt = cur.nextElementSibling, chat = cmt && cmt.classList.contains('cmt') ? Array.from(cmt.querySelectorAll('.thread > .chat')).filter(c => !c.querySelector('[data-act="restore"]')).pop() : null;
        const ta = chat && chat.querySelector('.followup textarea'); if (ta) { ta.scrollIntoView({ block: 'center' }); ta.focus(); return; }
      }
      clearSel(); askOverlay(changes[ovRows[0].dataset.chg], ovRows, sel === '.modbtn' ? 'modify' : undefined); return;
    }
    if (!cur || !cur.matches('tr.line')) { toast('Select a line first (j / l)'); return; }
    const rows = picked, rangeSide = rows && viewMode === 'split' ? (selSide || effSide(cur) || 'RIGHT') : null;
    const row = rows ? (rangeSide ? rows.filter(x => rowHas(x, rangeSide)).pop() || rows[rows.length - 1] : rows[rows.length - 1]) : cur;
    // i continues the conversation already open on this line (the selected one, else the latest) instead of starting another.
    if (sel === '.askbtn' && !rows) {
      const here = current_(), cmt = skipOv(row.nextElementSibling, 1);
      const chat = here && here.classList.contains('chat') ? here : cmt && cmt.classList.contains('cmt') ? Array.from(cmt.querySelectorAll('.thread > .chat')).filter(c => !c.querySelector('[data-act="restore"]')).pop() : null;
      const ta = chat && chat.querySelector('.followup textarea'); if (ta) { ta.scrollIntoView({ block: 'center' }); ta.focus(); return; }
    }
    // The buttons of the side the cursor is on (the new side outside the split view, where each row has one side).
    const side = rangeSide || effSide(cur) || 'RIGHT', sideOf = x => { const a = x.closest('.lbtns').querySelector('.addbtn'); return a && a.dataset.side; };
    const btns = Array.from(row.querySelectorAll(sel)), b = isSplitRow(row) ? btns.find(x => sideOf(x) === side) : (btns.find(x => sideOf(x) === 'RIGHT') || btns[btns.length - 1]);
    if (b) b.click(); else if (sel === '.modbtn') toast(side === 'LEFT' && isSplitRow(row) ? 'Claude changes the new code: press → for the new side' : 'Claude changes the new code: pick a new or unchanged line'); else toast('Nothing on this side of the line');
  }
  // v marks the file holding the cursor as viewed, or unmarks it; a viewed file collapses, so the cursor moves to its
  // header, and an unmarked one expands again.
  // On the commit stepper, v marks every file of the selected commit as viewed, or unmarks them all when all are viewed.
  // A stepper button with focus (clicked or reached with Tab) counts as the commit stepper too, for that button's commit.
  const focusedStep = () => { const a = document.activeElement; return a && a.matches && a.matches('#stepper .step') ? Array.from(document.querySelectorAll('#stepper .step')).indexOf(a) : -1; };
  function toggleViewed() {
    const fs = focusedStep();
    if (region === 'commits' || fs >= 0) {
      const c = COMMITS[fs >= 0 ? fs : current]; if (!c || !c.files || !c.files.length) { toast('This commit has no files'); return; }
      const on = !isCommitViewed(c);
      c.files.forEach(f => lsSet('viewed:' + c.sha + ':' + f.path, on ? '1' : '0'));
      renderAll(); toast(on ? 'Commit marked as viewed' : 'Commit marked as not viewed'); return;
    }
    const cur = current_(), sec = cur && cur.closest('.file'); if (!sec) { toast('Select a line in a file first (j / l)'); return; }
    const cb = sec.querySelector('.file-head input[type=checkbox]'); if (!cb) return;
    cb.checked = !cb.checked; cb.dispatchEvent(new Event('change'));
    if (cb.checked) { const head = sec.querySelector('.file-head'); setCursor(head); }
    toast(cb.checked ? 'Marked as viewed' : 'Marked as not viewed');
  }
  function enterCursor() {
    // After n / p the highlighted comment, not the line above it, is what Enter replies to.
    if (lastCmt) { const card = lastCmt.matches('.card, .chat, .ghthread') ? lastCmt : lastCmt.querySelector('.thread > .card, .thread > .chat, .thread > .ghthread'); if (card) { enterCard(card); return; } }
    const cur = current_(); if (!cur) return;
    if (cur.parentElement && cur.parentElement.classList.contains('thread')) { enterCard(cur); return; }
    if (cur.classList.contains('gstop')) { if (cur.tagName === 'DETAILS') cur.open = !cur.open; else lineAction('.addbtn'); }
    else if (cur.classList.contains('file-head')) cur.querySelector('[data-toggle]').click();
    else if (cur.classList.contains('hunk')) {
      const before = stops(), i = before.indexOf(cur), y = cur.getBoundingClientRect().top;
      const b = cur.querySelector('.xbtn[data-x=all]') || cur.querySelector('.xbtn'); if (b) b.click();
      // A fully expanded gap loses its row; keep the cursor at the same place, now the first revealed line.
      if (!current_()) { const after = stops(); const el = after[Math.max(0, i)] ; if (el) setCursor(el, false); window.scrollBy(0, (el ? el.getBoundingClientRect().top : y) - y); }
    }
    else lineAction('.addbtn');
  }
  document.addEventListener('click', e => {
    const el = e.target.closest && e.target.closest('#files tr.line, #files tr.ovnew.done, #files .file-head, #files tr.hunk'); if (!el || !el.id) return;
    const td = e.target.closest('td'); if (isSplitRow(el) && td && el.children.length >= 4) { const sd = Array.from(el.children).indexOf(td) < 2 ? 'LEFT' : 'RIGHT'; if (rowHas(el, sd)) cursorSide = sd; }
    setCursor(el, false); toDiff();
  });
  let lastCmt = null;
  window.addEventListener('wheel', () => { lastCmt = null; }, { passive: true });
  window.addEventListener('touchmove', () => { lastCmt = null; }, { passive: true });
  function stepComment(dir) {
    // Each GitHub reviewer thread is a stop of its own, which takes the cursor; a row holding only such threads is not.
    const rows = Array.from(document.querySelectorAll('tr.cmt, .general .card, .thread > .ghthread, .general > .ghthread')).filter(r => !r.closest('[hidden]') && !r.closest('.collapsed') && (!r.matches('tr.cmt') || r.querySelector('.thread > :not(.ghthread)')));
    if (!rows.length) return;
    // Step from the comment we last jumped to; centring can fail near the page end, so the viewport midpoint alone would repeat it.
    const top = r => r.getBoundingClientRect().top + window.scrollY;
    const last = rows.indexOf(lastCmt);
    let idx;
    if (last >= 0) idx = last + dir;
    else {
      const y = window.scrollY + window.innerHeight / 2;
      idx = dir > 0 ? rows.findIndex(r => top(r) > y + 10) : rows.map(r => top(r) < y - 10).lastIndexOf(true);
    }
    if (idx < 0 || idx >= rows.length) idx = dir > 0 ? 0 : rows.length - 1;
    lastCmt = rows[idx];
    if (rows[idx].matches('.ghthread')) { if (rows[idx].id) setCursor(rows[idx], false); rows[idx].scrollIntoView({ block: 'center' }); flashRow(rows[idx]); return; }
    const ln = skipOv(rows[idx].previousElementSibling, -1); if (ln && ln.matches && ln.matches('tr.line')) setCursor(ln, false);
    rows[idx].scrollIntoView({ block: 'center' }); flashRow(ln || rows[idx]);
  }
  // d, q and r act on the cards of the selected line or comment: dismiss or restore a conversation or reject or restore a comment, queue, toggle Reviewed by Human.
  function cardAction(sel, none) {
    const cur = current_(); let scope = [];
    if (lastCmt) scope = [lastCmt];
    else if (cur && (cur.classList.contains('gstop') || (cur.parentElement && cur.parentElement.classList.contains('thread')))) scope = [cur];
    else if (cur && cur.matches('tr.line')) { for (let n = skipOv(cur.nextElementSibling, 1); n && n.matches('tr.cmt'); n = n.nextElementSibling) scope.push(n); }
    // A list of selectors is tried in order of preference.
    const sels = Array.isArray(sel) ? sel : [sel]; let b = null;
    for (const one of sels) { b = scope.map(x => x.querySelector(one)).find(Boolean); if (b) break; }
    if (b) b.click(); else toast(none);
  }
  // t shows the full list of keys, so the header carries only the hint.
  // While it is open, j / l and the arrows step through the entries, PgUp / PgDn / Home / End scroll it, and t or Esc closes it.
  let keysCur = 0, keysFrom = null;
  function showKeys(on) {
    const p = document.getElementById('keys-panel'); if (!p || p.hidden === !on) return; p.hidden = !on;
    if (on) { keysFrom = document.activeElement; const b = document.getElementById('keyshint'); if (b) p.style.top = Math.round(b.getBoundingClientRect().bottom + 6) + 'px'; p.scrollTop = 0; keysCur = 0; markKeys(); p.focus({ preventScroll: true }); }
    else if (keysFrom && keysFrom.focus && document.activeElement === p) keysFrom.focus({ preventScroll: true });
  }
  function markKeys() {
    const dts = Array.from(document.querySelectorAll('#keys-panel dt')); keysCur = Math.max(0, Math.min(dts.length - 1, keysCur));
    document.querySelectorAll('#keys-panel .kon').forEach(x => x.classList.remove('kon'));
    const dt = dts[keysCur]; if (!dt) return; dt.classList.add('kon'); dt.nextElementSibling.classList.add('kon'); dt.scrollIntoView({ block: 'nearest' });
  }
  function keysKey(k) {
    const p = document.getElementById('keys-panel'), n = p.querySelectorAll('dt').length;
    const step = { j: -1, ArrowUp: -1, l: 1, ArrowDown: 1 }[k];
    if (step) { keysCur += step; markKeys(); return true; }
    if (k === 'Home' || k === 'End') { keysCur = k === 'Home' ? 0 : n - 1; markKeys(); return true; }
    if (k === 'PageUp' || k === 'PageDown') { p.scrollBy(0, (k === 'PageUp' ? -1 : 1) * (p.clientHeight - 40)); const top = p.getBoundingClientRect().top; const dts = Array.from(p.querySelectorAll('dt')); const i = dts.findIndex(d => d.getBoundingClientRect().top >= top + 30); keysCur = i < 0 ? n - 1 : i; markKeys(); return true; }
    return false;
  }
  document.getElementById('keyshint').onclick = () => showKeys(document.getElementById('keys-panel').hidden);
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') {
      // Enter sends, Shift+Enter starts a new line.
      // In the review summary Up / Down pick the review type, and Enter arms, then submits.
      if (e.target.id === 'sub-body' && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey) { e.preventDefault(); stepReviewType(e.key === 'ArrowDown' ? 1 : -1); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target.id === 'sub-body') { e.preventDefault(); const g = document.getElementById('sub-go'); if (g && !g.disabled) g.click(); return; }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target.tagName === 'TEXTAREA' && e.target.id !== 'sub-body') { e.preventDefault(); const btn = e.target.parentElement.querySelector('.btn.primary, [data-act="followup"]'); if (btn) btn.click(); }
      if (e.key === 'Escape') closeAll();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Escape') { closeAll(); return; }
    if (!document.getElementById('keys-panel').hidden && keysKey(e.key)) { e.preventDefault(); return; }
    if (fbOpen && fbKey(e.key)) { e.preventDefault(); return; }
    if (subOpen && e.key.startsWith('Arrow')) { e.preventDefault(); stepReviewType(e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1); return; }
    if (subOpen && e.key === 'Enter' && !(e.target.closest && e.target.closest('button'))) { e.preventDefault(); const g = document.getElementById('sub-go'); if (g && !g.disabled) g.click(); return; }
    if (region === 'commits' && e.key.startsWith('Arrow')) { e.preventDefault(); if (e.key === 'ArrowLeft') { go(current - 1); toCommits(); } else if (e.key === 'ArrowRight') { go(current + 1); toCommits(); } else if (e.key === 'ArrowDown') fromCommits(); return; }
    if (region === 'queue' && e.key === 'Enter') { e.preventDefault(); const b = qStops()[qCur]; if (b) { if (b.classList.contains('qitem')) toDiff(); b.click(); } return; }
    if (e.key === 'Enter' && e.target.closest && e.target.closest('button, a, label')) return;
    if (e.shiftKey && region === 'diff' && ['J', 'L', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); extendSel(e.key === 'J' || e.key === 'ArrowUp' ? -1 : 1); return; }
    if (selFrom && ['j', 'l', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', '[', ']'].includes(e.key)) clearSel();
    const keys = {
      ']': () => go(current + 1), '[': () => go(current - 1), ArrowRight: () => sideKey('RIGHT') || toQueue(), ArrowLeft: () => sideKey('LEFT') || toDiff(),
      j: () => moveCursor(-1, true), ArrowUp: () => region === 'queue' ? moveQ(-1) : arrowMove(-1), l: () => moveCursor(1, true), ArrowDown: () => region === 'queue' ? moveQ(1) : arrowMove(1),
      PageUp: () => pageCursor(-1), PageDown: () => pageCursor(1),
      n: () => stepComment(1), p: () => stepComment(-1), k: () => lineAction('.addbtn'), i: () => lineAction('.askbtn'), u: () => toggleSubmit(), v: () => toggleViewed(), t: () => showKeys(document.getElementById('keys-panel').hidden), f: () => toggleFeedback(), d: () => cardAction(['[data-act="dismiss"], .chat [data-act="restore"]', '[data-act="reject"], .card > .actions [data-act="restore"]', '[data-act="hidedisc"], [data-act="showdisc"]', '.change [data-act="decline"], .change [data-act="restorechg"]'], 'Nothing to dismiss here'), q: () => cardAction(['[data-act="approve"]', '.change [data-act="accept"]'], 'No proposed comment or change here'), r: () => cardAction('[data-act="reviewed"]', 'No Claude comment to mark here'), h: () => document.getElementById('queuetoggle').click(), m: () => lineAction('.modbtn'), c: () => toggleTop(), Enter: () => enterCursor()
    };
    const act = keys[e.key] || (e.key.length === 1 ? keys[e.key.toLowerCase()] : null);
    // Letter keys bring the cursor back to the diff, except v on the commit stepper, which marks that commit viewed.
    if (act) { e.preventDefault(); if (e.key.length === 1 && !((region === 'commits' || focusedStep() >= 0) && e.key.toLowerCase() === 'v')) toDiff(); act(); }
  });

  // The mouse pointer hides after two idle seconds or on a key press, and comes back when the mouse moves.
  let idleT;
  function hidePointer() { document.body.classList.add('nopointer'); }
  // Scrolling under a still mouse fires mousemove with no movement in some browsers; only real movement shows the pointer.
  window.addEventListener('mousemove', e => { if (!e.movementX && !e.movementY) return; document.body.classList.remove('nopointer'); clearTimeout(idleT); idleT = setTimeout(hidePointer, 2000); }, { passive: true });
  window.addEventListener('keydown', hidePointer);
  // A reload keeps the place: the selected line goes back to where it sat on screen, or else the page to its old offset.
  let restoring = true;
  function savePos() { if (restoring) return; const el = current_(); lsSet('pos', JSON.stringify({ commit: current, id: el ? el.id : null, top: el ? el.getBoundingClientRect().top : 0, y: window.scrollY })); }
  function restorePos() {
    if (!restoring) return; let p = null; try { p = JSON.parse(lsGet('pos') || 'null'); } catch (e) {}
    if (!p || p.commit !== current) return;
    const el = p.id && document.getElementById(p.id);
    if (el) { cursorId = p.id; applyCursor(); window.scrollBy(0, el.getBoundingClientRect().top - p.top); } else window.scrollTo(0, p.y);
  }
  // Comments load after the first paint and push lines down, so the place is restored again until the viewer moves.
  const settle = () => { restoring = false; };
  ['wheel', 'touchmove', 'keydown', 'mousedown'].forEach(ev => window.addEventListener(ev, settle, { passive: true, once: true }));
  setTimeout(settle, 4000);
  let posT; window.addEventListener('scroll', () => { clearTimeout(posT); posT = setTimeout(savePos, 150); }, { passive: true });
  window.addEventListener('pagehide', savePos);
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  try { const ui = JSON.parse(lsGet('ui') || 'null'); if (ui) ({ openComposer, openAsk, editing, fbOpen, subOpen } = ui); } catch (e) {}
  if (subOpen) renderSubmit();
  const m0 = /^#commit-(\d+)$/.exec(location.hash); if (m0) { const i = parseInt(m0[1], 10) - 1; if (i >= 0 && i < COMMITS.length) current = i; }
  renderAll(); restorePos();

  cmReady.then(ns => { cm = ns; });
  window.claude && window.claude.use && window.claude.use('mcp').then(ns => { mcp = ns; });
  window.claude && window.claude.use && window.claude.use('db').then(ns => {
    db = ns;
    if (!db) { document.getElementById('dbbanner').hidden = false; dbReady = true; renderQueue(); return; }
    // A rebuild after a rebase changes the commit hashes, so a doc anchored to
    // a hash no longer in the series moves (in memory only) to the latest
    // commit touching its file, or to the last commit, instead of vanishing.
    const reanchor = x => {
      if (!x.commit || COMMITS.some(c => c.sha === x.commit)) return x;
      const hit = x.path ? [...COMMITS].reverse().find(c => (c.files || []).some(f => f.path === x.path)) : null;
      return Object.assign(x, { staleCommit: x.commit, commit: (hit || COMMITS[COMMITS.length - 1]).sha });
    };
    db.collection('comments').onSnapshot(snap => {
      // Tombstones (deleted while in the GitHub draft) wait for the sync, hidden.
      const next = {}; snap.docs.forEach(d => { if (d.exists && !d.data().deleted) next[d.id] = reanchor(Object.assign({ id: d.id }, d.data())); });
      comments = next; dbReady = true; renderAll(); restorePos();
    }, err => { document.getElementById('dbbanner').hidden = false; dbReady = true; renderQueue(); });
    db.collection('threads').onSnapshot(snap => {
      const next = {}; snap.docs.forEach(d => { if (d.exists) next[d.id] = reanchor(Object.assign({ id: d.id }, d.data())); });
      threads = next; renderAll(); restorePos();
    }, err => {});
    db.collection('changes').onSnapshot(snap => {
      const next = {}; snap.docs.forEach(d => { if (d.exists) next[d.id] = Object.assign({ id: d.id }, d.data()); });
      changes = next; renderAll(); restorePos();
    }, err => {});
  });
})();
