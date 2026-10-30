"""Reconcile the page's comment docs with the user's pending GitHub review, REST only (no GraphQL).

  ghsync.py <config.json> <docs_dir> [--remove <githubCommentId> ...]
  ghsync.py <config.json> <docs_dir> --submit <COMMENT|APPROVE|REQUEST_CHANGES> [--body-file F]

config.json: {"repo_dir", "repo": "<owner/name>", "pr": <number>, "head": "<PR head sha>", "diff": "<diff.json>",
              "gh": "<gh.json, optional: maps reply thread ids to their root comment id>", "snapdir": "<dir for snapshots>"}
docs_dir: the comment docs as `ArtifactData list` with out_dir saved them (<docs_dir>/<doc id>.json, or <docs_dir>/comments/...).
           Docs saved that way carry no version: give each write the doc's version from the list result as if_version.
--remove: GitHub comment ids of docs the page deleted outright (they are no longer in docs_dir).
Prints a JSON array of ArtifactData batch writes for every doc whose GitHub state changed. A doc the page deleted
while it was on GitHub is a tombstone (deleted: true): its comment leaves the draft and the doc gets a delete write
once nothing of it is left there. Comments the page added to the draft at submit time carry no id until a sync
claims them by path and text.

REST cannot add a comment to an existing pending review, edit a pending comment, put a reply or a file-level comment
into a pending review, nor read back a pending comment's line range. So:
 * deleting a comment from the draft is a single DELETE (always safe);
 * adding/updating one rebuilds the review (snapshot -> delete -> recreate -> verify -> restore on failure), but only
   when EVERY comment in the draft was made by this script and is unchanged on GitHub, so it can be recreated exactly
   from the docs; anything made or edited in GitHub's UI makes the draft "locked" and nothing in it is ever deleted;
 * what cannot go into the draft now (replies, file/commit-level, lines outside the diff, anything while locked) is
   marked deferred with a ready-to-post plan; the page adds it at submit time through its GitHub connector, or
   --submit posts it right after submitting. A deferred doc stays queued until it is really posted."""
import json, os, re, subprocess, sys, time
argv = sys.argv[1:]
CFG_PATH, DOCS_DIR = argv[0], argv[1]; CFG = json.load(open(CFG_PATH))
REPO, HEAD, SLUG, PR = CFG['repo_dir'], CFG['head'], CFG['repo'], int(CFG['pr'])
REMOVE = [int(argv[i + 1]) for i, a in enumerate(argv) if a == '--remove']
SUBMIT = next((argv[i + 1] for i, a in enumerate(argv) if a == '--submit'), None)
SUMMARY = next((open(argv[i + 1]).read() for i, a in enumerate(argv) if a == '--body-file'), '')
SNAPDIR = CFG.get('snapdir') or os.path.join(os.path.dirname(os.path.abspath(CFG_PATH)), 'ghsync-snapshots')
try: BADGES = json.load(open(os.path.expanduser('~/.config/review-artifact/badges.json')))
except FileNotFoundError: BADGES = {}
CLAUDE, HUMAN = BADGES.get('claude', ''), BADGES.get('human', '')
MAIN = {c['sha'][:7]: max(c['files'], key=lambda f: f['add'] + f['del'])['path'] for c in json.load(open(CFG['diff'])) if c['files']}
ROOTS = {}  # review thread node id -> numeric id of its first comment (needed to reply over REST)
if CFG.get('gh') and os.path.exists(CFG['gh']):
    ROOTS = {t['id']: t['rootCommentId'] for t in json.load(open(CFG['gh']))['threads'] if t.get('rootCommentId')}
def log(*a): print(*a, file=sys.stderr)
def git(*a): return subprocess.run(['git', '-C', REPO, *a], capture_output=True, text=True, check=True).stdout

class GhError(Exception): pass
def api(method, path, payload=None, paginate=False):
    a = ['gh', 'api', '-X', method, f'repos/{SLUG}/{path}'] + (['--paginate', '--slurp'] if paginate else [])
    if payload is not None: a += ['--input', '-']
    r = subprocess.run(a, input=json.dumps(payload) if payload is not None else None, capture_output=True, text=True)
    if r.returncode: raise GhError(f'{method} {path}: {(r.stdout or r.stderr).strip()[:500]}')
    out = json.loads(r.stdout) if r.stdout.strip() else None
    return [x for page in out for x in page] if paginate else out

# ---- docs -------------------------------------------------------------------------------------------------------
def load_docs():
    docs = {}
    for root, _, files in os.walk(DOCS_DIR):
        for f in files:
            if not f.endswith('.json'): continue
            d = json.load(open(os.path.join(root, f)))
            if isinstance(d.get('data'), dict): d = dict(d['data'], _version=d.get('version'))
            docs[f[:-5]] = d
    return docs
def norm(s): return (s or '').replace('\r\n', '\n').strip()
def body_of(c):
    b = c['body']
    if not c.get('path') and not c.get('replyTo'): b = '> ' + git('log', '-1', '--format=%s', c['commit']).strip() + '\n\n' + b
    if c.get('author') == 'claude' and CLAUDE: b += '\n\n' + CLAUDE + (' ' + HUMAN if c.get('humanReviewed') and HUMAN else '')
    return b
def last_known_body(c):  # what GitHub should hold for this doc if nobody touched it there
    if c.get('githubBody') is not None: return c['githubBody']
    if c.get('source') == 'github': return c.get('body', '')
    return c.get('githubQuote', '') + body_of(c)  # docs synced by the GraphQL version
def wanted(c): return c.get('status') == 'queued' and c.get('source') != 'github' and not c.get('replyToConv')

# ---- anchors ----------------------------------------------------------------------------------------------------
def map_line(sha, path, line):
    off = 0
    for m in re.finditer(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', git('diff', '-U0', sha, HEAD, '--', path), re.M):
        os_, oc = int(m[1]), int(m[2] if m[2] is not None else 1); nc = int(m[4] if m[4] is not None else 1)
        if line < (os_ if oc else os_ + 1): break
        if oc and line < os_ + oc: return None
        off += nc - oc
    return line + off
HUNKS = None
def hunk_of(path, line):  # index of the PR-diff hunk whose RIGHT side holds line (GitHub accepts only those), else None
    global HUNKS
    if HUNKS is None:
        HUNKS = json.loads(os.environ.get('GHSYNC_TEST_HUNKS', '{}'))  # test hook: pretend extra hunks exist
        for f in api('GET', f'pulls/{PR}/files?per_page=100', paginate=True):
            HUNKS[f['filename']] = HUNKS.get(f['filename'], []) + [(int(m[1]), int(m[2] if m[2] is not None else 1))
                                    for m in re.finditer(r'^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@', f.get('patch') or '', re.M)]
    return next((i for i, (s, n) in enumerate(HUNKS.get(path, [])) if s <= line < s + n), None)
def plan_of(c):
    """Where this doc goes: an inline anchor recreatable in a REST review, or a deferred plan."""
    if c.get('replyTo'):
        return {'kind': 'reply', 'deferred': 'reply', 'threadId': c['replyTo'],
                'inReplyTo': c.get('replyToCommentId') or ROOTS.get(c['replyTo']), 'body': body_of(c)}
    path = c.get('path') or MAIN.get(c['commit'][:7])
    if not c.get('path') or not c.get('line') or (c.get('side') or 'RIGHT') != 'RIGHT':
        hunk_of(path, 0)
        if path in HUNKS: return {'kind': 'file', 'deferred': 'commit-level' if not c.get('path') else 'file-level', 'path': path, 'body': body_of(c)}
        c = dict(c, line=None, startLine=None)  # fall through to the permalink form below
    line = map_line(c['commit'], c['path'], c['line']) if c.get('line') else None
    start = map_line(c['commit'], c['path'], c['startLine']) if line and c.get('startLine') else None
    h = hunk_of(path, line) if line else None
    if line and h is not None and (not start or (start < line and hunk_of(path, start) == h)):
        a = {'kind': 'line', 'path': path, 'line': line, 'side': 'RIGHT', 'commit': HEAD, 'body': body_of(c)}
        if start and start < line: a['startLine'] = start
        return a
    # Outside the PR's diff (or the line changed later): a file-level comment quoting the line(s) by permalink;
    # a file outside the PR takes no comments at all: anchor on the commit's most-changed file, quoting by permalink.
    rng = (f'#L{start}-L{line}' if start and line and start < line else f'#L{line}') if line else ''
    hunk_of(path, 0); inpr = path in HUNKS
    quote = f'https://github.com/{SLUG}/blob/{HEAD}/{path}{rng}\n\n' if line or not inpr else ''
    return {'kind': 'file', 'deferred': 'outside-diff', 'path': path if inpr else MAIN.get(c['commit'][:7], path), 'body': quote + body_of(c), 'quote': quote}
def rest_comment(a):
    r = {'path': a['path'], 'line': a['line'], 'side': a['side'], 'body': a['body']}
    if a.get('startLine'): r.update(start_line=a['startLine'], start_side=a['side'])
    return r

def remap(a):  # a recorded draft anchor moved to the current head, or None if it no longer resolves there
    if a.get('commit') == HEAD: return a
    line = map_line(a['commit'], a['path'], a['line']); start = map_line(a['commit'], a['path'], a['startLine']) if a.get('startLine') else None
    h = hunk_of(a['path'], line) if line else None
    if h is None or (a.get('startLine') and (not start or hunk_of(a['path'], start) != h)): return None
    return {**a, 'line': line, 'commit': HEAD, **({'startLine': start} if start else {})}

# ---- pending review ---------------------------------------------------------------------------------------------
ME = CFG.get('login') or subprocess.run(['gh', 'api', 'user', '--jq', '.login'], capture_output=True, text=True, check=True).stdout.strip()
def pending():
    rs = [r for r in api('GET', f'pulls/{PR}/reviews?per_page=100', paginate=True) if r['state'] == 'PENDING' and r['user']['login'] == ME]
    if not rs: return None, []
    return rs[0], api('GET', f'pulls/{PR}/reviews/{rs[0]["id"]}/comments?per_page=100', paginate=True)
def snapshot(review, cms, why):
    os.makedirs(SNAPDIR, exist_ok=True)
    p = os.path.join(SNAPDIR, f'pr{PR}-{time.strftime("%Y%m%d-%H%M%S")}-{why}.json')
    json.dump({'review': review, 'comments': cms, 'at': time.time()}, open(p, 'w'), indent=1); log('snapshot', p)
    return p
def fingerprint(review, cms): return (norm(review and review['body']), sorted((c['id'], c['updated_at'], norm(c['body'])) for c in cms))
def create_review(body, items):
    payload = {'commit_id': HEAD, 'comments': [rest_comment(a) for a in items]}
    if body: payload['body'] = body
    rv = api('POST', f'pulls/{PR}/reviews', payload)
    got = sorted(api('GET', f'pulls/{PR}/reviews/{rv["id"]}/comments?per_page=100', paginate=True), key=lambda x: x['id'])
    if len(got) != len(items) or any(g['path'] != a['path'] or norm(g['body']) != norm(a['body']) for g, a in zip(got, items)) \
            or norm(api('GET', f'pulls/{PR}/reviews/{rv["id"]}')['body']) != norm(body):
        snapshot(rv, got, 'bad-rebuild'); api('DELETE', f'pulls/{PR}/reviews/{rv["id"]}')
        raise GhError(f'review {rv["id"]} came back with {len(got)}/{len(items)} matching comments')
    return rv, [g['id'] for g in got]  # REST lists them in creation order (ids ascend)

# ---- reconcile --------------------------------------------------------------------------------------------------
DOCS = load_docs(); writes = {}
ORIG = {i: dict(d) for i, d in DOCS.items()}  # as saved: the output drops writes that change nothing against these
def upd(doc_id, **kw): writes.setdefault(doc_id, {}).update(kw)
DEL = {'__delete__': True}
GH_FIELDS = ('inDraft', 'githubCommentId', 'githubThreadId', 'githubPath', 'githubQuote', 'githubAnchor', 'githubBody', 'deferred', 'githubPlan', 'githubConflict', 'githubError', 'deferredError')
def clear_gh(doc_id, keep=()): upd(doc_id, **{k: DEL for k in GH_FIELDS if k not in keep and k in DOCS[doc_id]})
def set_draft(doc_id, cid, a):
    clear_gh(doc_id); upd(doc_id, inDraft=True, githubCommentId=cid, githubPath=a['path'], githubBody=a['body'],
                         githubAnchor={k: a[k] for k in ('path', 'line', 'startLine', 'side', 'commit') if k in a})
def set_deferred(doc_id, a, why=None):
    clear_gh(doc_id); upd(doc_id, deferred=why or a['deferred'], githubPlan={k: v for k, v in a.items() if k != 'deferred'})
    if a.get('quote'): upd(doc_id, githubQuote=a['quote'])

def reconcile():
    # Docs whose comment is already published (review submitted from GitHub's UI, or posted before) are done:
    # mark them posted so they are never re-added to a new draft.
    published = {c['id'] for c in api('GET', f'pulls/{PR}/comments?per_page=100', paginate=True)}
    for i, d in DOCS.items():
        if d.get('status') == 'queued' and d.get('githubCommentId') in published:
            upd(i, status='posted', postedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), inDraft=DEL, deferred=DEL, githubPlan=DEL)
            d['status'] = 'posted'; log('already published', d['githubCommentId'])
    review, cms = pending()
    if review: snapshot(review, cms, 'before')
    live = {c['id']: c for c in cms}
    # The page adds deferred comments through its connector at submit time, which returns no id: claim each one by
    # its path and text. One no longer found in the draft is planned again below.
    claimed = {d.get('githubCommentId') for d in DOCS.values()}
    for i, d in DOCS.items():
        if not d.get('inDraft') or d.get('githubCommentId') or d.get('githubBody') is None: continue
        cid = next((k for k, x in live.items() if k not in claimed and x['path'] == d.get('githubPath') and norm(x['body']) == norm(d['githubBody'])), None)
        if cid: d['githubCommentId'] = cid; claimed.add(cid); upd(i, githubCommentId=cid); log('claimed', cid, 'for', i)
    by_cid ={d['githubCommentId']: i for i, d in DOCS.items() if d.get('githubCommentId') in live}
    # A draft comment is recreatable only if this script made it (recorded anchor) and its text on GitHub is untouched.
    def recreatable(cid):
        i = by_cid.get(cid); d = DOCS.get(i) if i else None
        return bool(d and d.get('githubAnchor') and remap(d['githubAnchor']) and not live[cid].get('in_reply_to_id') and live[cid].get('diff_hunk')
                    and norm(live[cid]['body']) == norm(d.get('githubBody')))
    # 1. removals: single DELETEs, never touching comments edited on GitHub.
    for cid in REMOVE:
        if cid in live: api('DELETE', f'pulls/comments/{cid}'); live.pop(cid); log('removed', cid, '(doc deleted on the page)')
    for i, d in DOCS.items():
        cid = d.get('githubCommentId')
        if wanted(d) or d.get('status') in ('posted', None) or d.get('status') == 'queued' and d.get('source') == 'github': continue
        if cid in live:
            if norm(live[cid]['body']) != norm(last_known_body(d)):
                upd(i, githubConflict='edited on GitHub; left in the draft'); log('kept', cid, 'edited on GitHub'); continue
            api('DELETE', f'pulls/comments/{cid}'); live.pop(cid); log('removed', cid)
        if d.get('inDraft') or d.get('deferred') or d.get('githubCommentId'): clear_gh(i)
    # 2. what the draft should contain
    adds = []  # (doc id, inline anchor)
    for i, d in DOCS.items():
        if not wanted(d): continue
        cid = d.get('githubCommentId'); a = plan_of(d)
        if cid in live:
            if norm(live[cid]['body']) != norm(last_known_body(d)):
                upd(i, githubConflict='edited on GitHub; the page version was not pushed'); continue
            if a['kind'] == 'line' and a['body'] == d.get('githubBody') and d.get('githubAnchor') == {k: a[k] for k in ('path', 'line', 'startLine', 'side', 'commit') if k in a}:
                continue  # already right
            if a['kind'] != 'line' or not d.get('githubAnchor'):
                # in the draft already but not recreatable by REST (GraphQL-era reply/file comment): update means
                # delete + defer the new version; unchanged text stays where it is.
                if norm(a['body']) == norm(live[cid]['body']): continue
                api('DELETE', f'pulls/comments/{cid}'); live.pop(cid); set_deferred(i, a, a.get('deferred') or 'edited'); continue
            adds.append((i, a))  # changed: goes through a rebuild (or is deferred if the draft is locked)
        elif a['kind'] == 'line': adds.append((i, a))
        else: set_deferred(i, a)
    if not adds: return
    # 3. add/update needs a fresh review: allowed only if every remaining draft comment is recreatable.
    changed = {i for i, _ in adds}
    keep = [cid for cid in live if by_cid.get(cid) not in changed]
    locked = [cid for cid in keep if not recreatable(cid)]
    if locked:
        log('draft locked by', len(locked), 'comment(s) made or edited on GitHub; deferring', len(adds))
        for i, a in adds:
            cid = DOCS[i].get('githubCommentId')
            if cid in live: api('DELETE', f'pulls/comments/{cid}'); live.pop(cid)  # our own stale version
            set_deferred(i, a, 'draft-locked')
        return
    items = [(by_cid[cid], {**remap(DOCS[by_cid[cid]]['githubAnchor']), 'body': live[cid]['body']}) for cid in sorted(keep)] + adds
    body = review['body'] if review else ''; snap = None
    if review:
        snap = snapshot(review, list(live.values()), 'rebuild')
        r2, c2 = pending()  # last look: abort if anything moved since the snapshot
        if fingerprint(r2, c2) != fingerprint(review, list(live.values())): raise SystemExit('draft changed on GitHub during sync; nothing deleted, rerun')
        api('DELETE', f'pulls/{PR}/reviews/{review["id"]}')
    try:
        try: rv, ids = create_review(body, [a for _, a in items])
        except GhError:
            cur = pending()[0]  # a stale listing may still show the review just deleted: wait and retry once
            if not (review and cur and cur['id'] == review['id']): raise
            time.sleep(3); rv, ids = create_review(body, [a for _, a in items])
    except GhError as e:
        log('rebuild failed:', e)
        olds = [(i, a) for i, a in items if i not in changed] + \
               [(i, {**(remap(DOCS[i]['githubAnchor']) or DOCS[i]['githubAnchor']), 'body': live[DOCS[i]['githubCommentId']]['body']}) for i in changed if DOCS[i].get('githubCommentId') in live]
        for i, a in adds: set_deferred(i, a, 'rejected-by-github')  # e.g. a line GitHub would not resolve
        if not review: return
        if pending()[0]:  # someone (GitHub's UI) started a new draft meanwhile: REST cannot add to it
            log('a new pending review appeared; deferring', len(olds), 'comments; snapshot', snap)
            for i, a in olds: set_deferred(i, {**a, 'kind': 'line'}, 'draft-locked')
            return
        try:
            _, ids = create_review(body, [a for _, a in olds]); [set_draft(i, cid, a) for (i, a), cid in zip(olds, ids)]
            log('restored the draft from', snap)
        except GhError as e2:
            log('RESTORE FAILED:', e2, '- snapshot kept at', snap)
            for i, a in olds: set_deferred(i, {**a, 'kind': 'line'}, 'restore-failed')
        for i in changed:  # a restored old version: the doc keeps the new text and says why it is not on GitHub yet
            if 'inDraft' in writes.get(i, {}): upd(i, githubError=str(e)[:300])
        return
    for (i, a), cid in zip(items, ids): set_draft(i, cid, a)
    log('draft now has', len(ids), 'comments (review', rv['id'], ')')

# ---- submit fallback (the page normally submits through its connector) -----------------------------------------
def post_plan(p):
    if p['kind'] == 'reply':
        if not p.get('inReplyTo'): raise GhError('no root comment id for thread ' + str(p.get('threadId')))
        return api('POST', f'pulls/{PR}/comments/{p["inReplyTo"]}/replies', {'body': p['body']})
    if p['kind'] == 'file': return api('POST', f'pulls/{PR}/comments', {'body': p['body'], 'path': p['path'], 'commit_id': HEAD, 'subject_type': 'file'})
    return api('POST', f'pulls/{PR}/comments', {**rest_comment(p), 'commit_id': HEAD})
def submit():
    review, cms = pending(); now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    if review:
        snapshot(review, cms, 'submit')
        body = '\n\n'.join(x for x in (review['body'].strip(), SUMMARY.strip()) if x) if SUMMARY.strip() not in review['body'] else review['body']
        api('POST', f'pulls/{PR}/reviews/{review["id"]}/events', {'event': SUBMIT, 'body': body})
        live = {c['id'] for c in cms}
        for i, d in DOCS.items():
            if d.get('githubCommentId') in live and d.get('status') == 'queued': upd(i, status='posted', postedAt=now, syncPending=DEL)
    elif SUMMARY.strip() or SUBMIT != 'COMMENT':
        api('POST', f'pulls/{PR}/reviews', {'commit_id': HEAD, 'event': SUBMIT, 'body': SUMMARY})
    # Deferred docs are published now, one by one (GitHub shows each as its own comment); failures stay queued.
    for i, d in DOCS.items():
        p = writes.get(i, {}).get('githubPlan') or d.get('githubPlan')
        if not (wanted(d) and p and (writes.get(i, {}).get('deferred') or d.get('deferred'))): continue
        try: r = post_plan(p); upd(i, status='posted', postedAt=now, githubCommentId=r['id'], githubUrl=r['html_url'], deferred=DEL, deferredError=DEL, syncPending=DEL)
        except GhError as e: upd(i, deferredError=str(e)[:300]); log('NOT posted', i, e)

try:
    reconcile()
    if SUBMIT: submit()
finally:
    for i, d in DOCS.items():
        if d.get('syncPending'): upd(i, syncPending=DEL)
    out = []
    for i in set(writes) | {i for i, d in DOCS.items() if d.get('deleted')}:
        cur = ORIG.get(i, {})  # drop no-op writes (same value, or deleting an absent field)
        data = {k: v for k, v in writes.get(i, {}).items() if not (v == DEL and k not in cur) and not (v != DEL and cur.get(k) == v)}
        after = {**cur, **data}; after = {k: v for k, v in after.items() if v != DEL}
        # A tombstone (deleted on the page while on GitHub) goes once nothing of it is left on GitHub.
        gone = cur.get('deleted') and not any(after.get(k) for k in ('inDraft', 'githubCommentId', 'deferred', 'githubConflict'))
        if not data and not gone: continue
        w = {'op': 'delete', 'collection': 'comments', 'doc_id': i} if gone else {'op': 'update', 'collection': 'comments', 'doc_id': i, 'data': data}
        if DOCS.get(i, {}).get('_version'): w['if_version'] = DOCS[i]['_version']
        out.append(w)
    print(json.dumps(out))
