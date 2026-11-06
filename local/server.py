"""Local review app: serves the review page (app/) on this machine and keeps its store, so git and GitHub work runs here.

  server.py <PR url | owner/repo#N> [--repo-dir DIR] [--port N] [--state DIR] [--session URL] [--open] [--detach] [--no-push]
  server.py <PR url | owner/repo#N> --stop [--state DIR]

--detach starts the server in its own session (it outlives the caller) and prints its info line once it listens; when a
server for the PR already runs, it is reused (the line says "reused": true). --port defaults to the first free one from
8765. --open opens the page in a browser tab. The server stops itself once the PR is closed.

The page is the same code as the claude.ai review artifact. The server stands in for the artifact platform: it keeps the
page's comments/threads/changes collections in <state>/db.json, and every request the page sends to Claude arrives here.
Mechanical requests run at once on this machine (accepting a change on the review branch, pushing it to the user's fork,
GitHub sync, submitting the review, posting conversation replies). The rest (questions, change and revision requests,
feedback, review requests, a new PR head) go to <state>/inbox.jsonl, one JSON line each, for the Claude agent answering
the page: it takes them with "store.py next" and answers by writing docs back through store.py.

Pushes go only to the user's own fork (a remote whose owner is the user's login), never to the PR's upstream repository
or any repository of its owner. Listens on 127.0.0.1 only; POSTs need the X-Review header and a local Host."""
import json, os, re, shlex, shutil, signal, subprocess, sys, tempfile, threading, time, traceback, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(R, 'app')
argv = sys.argv[1:]
def opt(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default
m = re.search(r'github\.com/([^/]+)/([^/]+)/pull/(\d+)', argv[0]) or re.match(r'([^/\s]+)/([^#\s]+)#(\d+)$', argv[0])
if not m: sys.exit(__doc__)
OWNER, NAME, N = m[1], m[2], int(m[3]); SLUG = f'{OWNER}/{NAME}'
REPO_DIR = os.path.abspath(opt('--repo-dir', os.getcwd()))
PORT_OPT = opt('--port')
STATE = os.path.abspath(os.path.expanduser(opt('--state', f'~/.cache/review-artifact/{OWNER}_{NAME}_{N}')))
SESSION = opt('--session', '')
NO_PUSH = '--no-push' in argv  # for trying the server out: accepts stay on the local review branch
os.makedirs(STATE, exist_ok=True)
INFO = os.path.join(STATE, 'server.json')  # url, port and pid of the running server

def open_tab(url):
    subprocess.Popen(['xdg-open', url] if shutil.which('xdg-open') else ['python3', '-m', 'webbrowser', '-t', url],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)

def running():
    """The info of a live server for this PR, or None."""
    try: info = json.load(open(INFO)); os.kill(info['pid'], 0)
    except (OSError, ValueError, KeyError): return None
    try:
        with urllib.request.urlopen(info['url'] + 'api/ping', timeout=5) as r:
            return info if json.load(r).get('pr') == f'{SLUG}#{N}' else None
    except Exception: return None

if '--stop' in argv:
    info = running()
    if info: os.kill(info['pid'], signal.SIGTERM); print('stopped', info['url'])
    else: print('not running')
    sys.exit(0)
if '--detach' in argv or '--open' in argv:
    info = running()
    if info:
        if '--open' in argv: open_tab(info['url'])
        print(json.dumps(dict(info, reused=True))); sys.exit(0)
if '--detach' in argv:
    try: os.remove(INFO)
    except FileNotFoundError: pass
    out = open(os.path.join(STATE, 'server.out'), 'w')
    child = subprocess.Popen([sys.executable, '-I', os.path.abspath(__file__)] + [a for a in argv if a != '--detach'], cwd=os.getcwd(),
                             stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
    deadline = time.time() + 580
    while time.time() < deadline and child.poll() is None:
        try:
            info = json.load(open(INFO))
            if info.get('pid') == child.pid: print(json.dumps(info)); sys.exit(0)
        except (FileNotFoundError, ValueError): pass
        time.sleep(0.5)
    sys.exit('the server did not start:\n' + open(os.path.join(STATE, 'server.out')).read()[-2000:])
LOG = open(os.path.join(STATE, 'server.log'), 'a', buffering=1)
def log(*a): print(time.strftime('%H:%M:%S'), *a, file=LOG)

def run(*cmd, cwd=None, check=True, env=None, input=None):
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, errors='replace', env=env, input=input)
    if check and r.returncode: raise RuntimeError(f"{' '.join(cmd[:4])}: {(r.stderr or r.stdout).strip()[-400:]}")
    return r.stdout
def git(*a, check=True, cwd=None, env=None): return run('git', *a, cwd=cwd or REPO_DIR, check=check, env=env)
def gh_json(path): return json.loads(run('gh', 'api', path))

LOGIN = run('gh', 'api', 'user', '--jq', '.login').strip()
ENV = dict(os.environ, GH_LOGIN=LOGIN)

def remote_for(owner, name):
    """The remote of this clone that points at github.com/<owner>/<name>, or None."""
    for line in git('remote', '-v').splitlines():
        rem, url = line.split()[:2]
        mm = re.search(r'github\.com[:/]([^/]+)/([^/\s]+?)(?:\.git)?$', url)
        if mm and mm[1].lower() == owner.lower() and mm[2].lower() == name.lower(): return rem
    return None
FORK = remote_for(LOGIN, NAME)  # the user's own fork: the only place pushes go
UPSTREAM_URL = f'https://github.com/{SLUG}'
BRANCH = f'review/pr-{N}'
WT = os.path.join(STATE, 'wt')

# ---- the page's store ------------------------------------------------------------------------------------------
COLS = ('comments', 'threads', 'changes')
DEL = {'__delete__': True}
lock = threading.Condition()
DB_PATH = os.path.join(STATE, 'db.json')
try: DB = json.load(open(DB_PATH))
except FileNotFoundError: DB = {'version': 0, 'docs': {c: {} for c in COLS}, 'docVersions': {c: {} for c in COLS}}
for c in COLS: DB['docs'].setdefault(c, {}); DB['docVersions'].setdefault(c, {})
REVIEW = {}  # the data the page renders, rebuilt for every new PR head

def save():
    tmp = DB_PATH + '.tmp'; json.dump(DB, open(tmp, 'w')); os.replace(tmp, DB_PATH)

def write_doc(op, col, did, data=None, if_version=None):
    """One write, under the lock. Returns False on a version conflict."""
    if col not in COLS: raise ValueError(f'unknown collection {col}')
    docs, vers = DB['docs'][col], DB['docVersions'][col]
    if if_version is not None and vers.get(did) != if_version: return False
    if op == 'delete': docs.pop(did, None); vers.pop(did, None)
    else:
        cur = {} if op == 'set' else dict(docs.get(did, {}))
        for k, v in (data or {}).items():
            if v == DEL: cur.pop(k, None)
            else: cur[k] = v
        docs[did] = cur; vers[did] = vers.get(did, 0) + 1
    return True

def commit_writes(writes):
    """Applies ArtifactData-style writes ({op, collection|col, doc_id|id, data, if_version}) atomically enough for one user."""
    with lock:
        ok = [write_doc(w['op'], w.get('collection') or w.get('col'), w.get('doc_id') or w.get('id'), w.get('data'), w.get('if_version')) for w in writes]
        DB['version'] += 1; save(); lock.notify_all()
    return ok

def app_version():
    return str(max(os.path.getmtime(os.path.join(APP, f)) for f in ('index.html', 'app.js', 'loader.js')))

def snapshot():
    return {'version': DB['version'], 'reviewVersion': REVIEW.get('reviewVersion'), 'appVersion': app_version(), 'docs': DB['docs'], 'docVersions': DB['docVersions']}

# ---- PR data -----------------------------------------------------------------------------------------------------
def build():
    pr = gh_json(f'repos/{SLUG}/pulls/{N}')
    head, head_ref = pr['head']['sha'], pr['head']['ref']
    up = remote_for(OWNER, NAME) or UPSTREAM_URL
    git('fetch', '-q', up, f'+pull/{N}/head:refs/review-artifact/pr-{N}/head', f"+refs/heads/{pr['base']['ref']}:refs/review-artifact/pr-{N}/base")
    base = git('merge-base', f'refs/review-artifact/pr-{N}/base', head).strip()
    diff, ghp = os.path.join(STATE, 'diff.json'), os.path.join(STATE, 'gh.json')
    run(sys.executable, '-I', os.path.join(R, 'scripts/mkdiff.py'), REPO_DIR, base, head, diff)
    run(sys.executable, '-I', os.path.join(R, 'scripts/ghthreads.py'), REPO_DIR, SLUG, str(N), diff, ghp, env=ENV)
    json.dump({'repo_dir': REPO_DIR, 'repo': SLUG, 'pr': N, 'head': head, 'diff': diff, 'gh': ghp, 'login': LOGIN,
               'snapdir': os.path.join(STATE, 'ghsync-snapshots')}, open(os.path.join(STATE, 'ghsync.json'), 'w'))
    try: collapsed = json.load(open(os.path.join(STATE, 'collapsed.json')))
    except FileNotFoundError: collapsed = ['Cargo.lock', 'package-lock.json', 'yarn.lock', 'go.sum']
    REVIEW.update(reviewVersion=head, base=base, headRef=head_ref, headRepo=(pr['head']['repo'] or {}).get('full_name'), state=pr['state'],
                  data={'cfg': {'repo': SLUG, 'pr': N, 'session': SESSION, 'collapsed': collapsed, 'local': True},
                        'pr': {'title': pr['title'], 'author': pr['user']['login'], 'head': head},
                        'mine': pr['user']['login'] == LOGIN, 'commits': json.load(open(diff)), 'gh': json.load(open(ghp))})
    log('built', head[:10], 'base', base[:10])

def watch_app():
    # A fix to the page code (feedback) reaches open tabs at once: wake the long poll, which reloads the page.
    seen = app_version()
    while True:
        time.sleep(2)
        try:
            cur = app_version()
            if cur != seen:
                seen = cur; log('page code changed; reloading open tabs')
                with lock: DB['version'] += 1; lock.notify_all()
        except Exception as e: log('app watch failed:', e)

def watch_head():
    while True:
        time.sleep(60)
        try:
            head, state = (run('gh', 'api', f'repos/{SLUG}/pulls/{N}', '--jq', '.head.sha + " " + .state').split() + ['', ''])[:2]
            if state and state != 'open': return close_down()
            if head and head != REVIEW.get('reviewVersion'):
                old = REVIEW.get('reviewVersion'); build()
                with lock: DB['version'] += 1; lock.notify_all()
                to_claude(None, f'[new head {head}] the PR head moved from {old}; mark accepted changes landed or stale as the workflow says')
        except Exception as e: log('head check failed:', e)

def close_down():
    """The PR is closed: tell the agent, give it time to take the message, then stop."""
    to_claude(None, '[pr closed] the PR is closed; the server stops')
    deadline = time.time() + 600
    while time.time() < deadline and read_cursor() < len(inbox_lines()): time.sleep(5)
    time.sleep(3)  # let the response carrying the message reach the agent
    stop()

def stop(*_):
    try:
        if json.load(open(INFO)).get('pid') == os.getpid(): os.remove(INFO)
    except (OSError, ValueError): pass
    log('stopped'); os._exit(0)

# ---- requests to Claude --------------------------------------------------------------------------------------------
INBOX = os.path.join(STATE, 'inbox.jsonl')
CURSOR = os.path.join(STATE, 'inbox.cursor')  # how many inbox lines the agent has taken
seq = [int(time.time() * 1000)]
def to_claude(thread, text):
    with lock:
        seq[0] += 1; tid = thread or f'local_{seq[0]}'
        with open(INBOX, 'a') as f: f.write(json.dumps({'threadId': tid, 'text': text, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}) + '\n')
        lock.notify_all()
    return tid

def inbox_lines():
    try: return open(INBOX).read().splitlines()
    except FileNotFoundError: return []
def read_cursor():
    try: return int(open(CURSOR).read().strip() or 0)
    except (FileNotFoundError, ValueError): return 0

def take_inbox(wait):
    """Blocks up to `wait` seconds for requests the agent has not taken yet; returns them and marks them taken."""
    end = time.time() + max(0, min(wait, 570))
    with lock:
        while True:
            lines, cur = inbox_lines(), read_cursor()
            left = end - time.time()
            if len(lines) > cur or left <= 0: break
            lock.wait(min(left, 30))
        open(CURSOR, 'w').write(str(len(lines)))
    return [json.loads(x) for x in lines[cur:] if x.strip()]

work = []; work_cv = threading.Condition()
def enqueue(job):
    with work_cv: work.append(job); work_cv.notify()
def worker():
    while True:
        with work_cv:
            while not work: work_cv.wait()
            job = work.pop(0)
        try: job()
        except Exception: log('job failed:', traceback.format_exc())

MECHANICAL = re.compile(r'^\[(accept change|push review branch|github sync|submit review|post conversation replies) ([^\]]*)\]\s*(.*)', re.S)
def route(thread, text):
    """Runs a mechanical request here; queues anything else for Claude. Returns the thread id the page keeps."""
    mm = MECHANICAL.match(text)
    if not mm: return to_claude(thread, text)
    kind, ident, rest = mm[1], mm[2].strip(), mm[3]
    tid = thread or f'local_{int(time.time() * 1000)}'
    if kind == 'accept change': enqueue(lambda: accept_change(ident))
    elif kind == 'push review branch': enqueue(lambda: push_review_branch(rest))
    elif kind == 'github sync': enqueue(github_sync)
    elif kind == 'submit review': enqueue(lambda: submit_review(rest))
    elif kind == 'post conversation replies': enqueue(lambda: post_conv_replies(re.findall(r'[\w-]+', rest)))
    return tid

# ---- GitHub sync and submit (the skill's ghsync.py) -----------------------------------------------------------------
def ghsync(*extra):
    d = os.path.join(STATE, 'docs'); shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    with lock:
        for did, doc in DB['docs']['comments'].items():
            json.dump({'data': doc, 'version': DB['docVersions']['comments'].get(did)}, open(os.path.join(d, did + '.json'), 'w'))
    for attempt in range(3):
        r = subprocess.run([sys.executable, '-I', os.path.join(R, 'scripts/ghsync.py'), os.path.join(STATE, 'ghsync.json'), d, *extra],
                           capture_output=True, text=True, env=ENV)
        log('ghsync', *extra, 'rc', r.returncode, r.stderr.strip()[-600:])
        if 'draft changed on GitHub during sync' in r.stdout + r.stderr and not extra: continue
        break
    out = r.stdout.strip().splitlines()
    writes = json.loads(out[-1]) if out and out[-1].startswith('[') else []
    if 'RESTORE FAILED' in r.stdout + r.stderr: to_claude(None, '[ghsync restore failed] tell the user; see ' + os.path.join(STATE, 'server.log'))
    ok = commit_writes(writes)
    if not all(ok): log('ghsync: some writes lost a version race; syncing again'); enqueue(github_sync)

def github_sync(): ghsync()

def submit_review(rest):
    head_line, _, summary = rest.partition('\n')
    ev = (re.search(r'event=(\w+)', head_line) or [None, 'COMMENT'])[1]
    if re.search(r'postConversationReplies=yes', head_line):
        post_conv_replies([i for i, d in DB['docs']['comments'].items() if d.get('status') == 'queued' and d.get('replyToConv')])
    f = tempfile.NamedTemporaryFile('w', delete=False, dir=STATE, suffix='.md'); f.write(summary.strip()); f.close()
    ghsync('--submit', ev, '--body-file', f.name)

def post_conv_replies(ids):
    for i in ids:
        d = DB['docs']['comments'].get(i)
        if not d or d.get('status') != 'queued' or not d.get('replyToConv'): continue
        body = f"In reply to [{d.get('convAuthor') or 'comment'}]({d['replyToConv']}):\n\n{d.get('body', '')}"
        try:
            url = run('gh', 'api', f'repos/{SLUG}/issues/{N}/comments', '-f', f'body={body}', '--jq', '.html_url').strip()
            commit_writes([{'op': 'update', 'col': 'comments', 'id': i, 'data': {'status': 'posted', 'githubUrl': url, 'syncPending': DEL}}])
        except Exception as e:
            commit_writes([{'op': 'update', 'col': 'comments', 'id': i, 'data': {'githubError': str(e)[:300]}}])

# ---- the review branch: accepted changes, on the user's own PR -----------------------------------------------------
def wgit(*a, check=True, env=None): return git(*a, cwd=WT, check=check, env=env)

def ensure_worktree():
    if not os.path.isdir(WT):
        git('worktree', 'prune')
        if git('rev-parse', '--verify', '-q', f'refs/heads/{BRANCH}', check=False).strip(): git('worktree', 'add', '-q', WT, BRANCH)
        else: git('worktree', 'add', '-q', '-b', BRANCH, WT, REVIEW['reviewVersion'])
    wgit('rebase', '--abort', check=False)

def series():
    return [(s, wgit('log', '-1', '--format=%s', s).strip()) for s in wgit('rev-list', '--reverse', f"{REVIEW['base']}..HEAD").split()]

def target_of(sha):
    """The review-branch commit standing for the PR commit `sha` (rewritten by earlier accepts): same subject, else same place."""
    commits = REVIEW['data']['commits']
    idx = next((i for i, c in enumerate(commits) if c['sha'] == sha), None)
    if idx is None: raise RuntimeError('the change is on a commit that is no longer in the PR')
    ser = series(); subj = commits[idx]['subject']
    hits = [s for s, t in ser if t == subj]
    if len(hits) == 1: return hits[0], idx
    if idx < len(ser): return ser[idx][0], idx
    raise RuntimeError('cannot find the commit on the review branch')

def editor_env(action, target, msgfile=None):
    env = dict(os.environ, GIT_SEQUENCE_EDITOR=' '.join(map(shlex.quote, [sys.executable, '-I', os.path.join(R, 'local/seqedit.py'), action, target])))
    env['GIT_EDITOR'] = ('cp ' + shlex.quote(msgfile)) if msgfile else 'true'
    return env

def replace_block(path, old, new, near):
    full = os.path.join(WT, path); lines = open(full).read().split('\n')
    k = len(old); hits = [i for i in range(len(lines) - k + 1) if lines[i:i + k] == old] if k else []
    if not hits: raise RuntimeError('the lines to change are no longer there')
    i = min(hits, key=lambda h: abs(h + 1 - (near or 0)))
    lines[i:i + k] = new; open(full, 'w').write('\n'.join(lines))

def accept_change(cid):
    ch = DB['docs']['changes'].get(cid)
    if not ch or ch.get('applied') or ch.get('status') not in ('accepted', 'accepting'): return
    if not REVIEW['data']['mine']:
        if not ch.get('commentId'): to_claude(None, f'[accept change {cid}] someone else\'s PR, change accepted without a suggestion comment')
        return
    keep = None
    try:
        ensure_worktree()
        k = 1
        while git('rev-parse', '--verify', '-q', f'refs/heads/{BRANCH}-v{k}', check=False).strip(): k += 1
        keep = f'{BRANCH}-v{k}'; git('branch', keep, BRANCH)
        target, idx = target_of(ch['commit'])
        if ch.get('op') in ('drop', 'reword'):
            msg = None
            if ch['op'] == 'reword':
                msg = os.path.join(STATE, f'msg-{cid}.txt'); open(msg, 'w').write(ch.get('message', '').rstrip() + '\n')
            wgit('rebase', '-q', '-i', REVIEW['base'], env=editor_env(ch['op'], target, msg))
        else:
            replace_block(ch['path'], ch.get('old') or [], ch.get('new') or [], ch.get('startLine') or ch.get('line'))
            wgit('add', '--', ch['path'])
            wgit('commit', '-q', f'--fixup={target}')
            wgit('rebase', '-q', '-i', '--autosquash', '--empty=drop', REVIEW['base'], env=dict(os.environ, GIT_SEQUENCE_EDITOR='true', GIT_EDITOR='true'))
        ser = series()
        new_commit = next((s for s, t in ser if t == (ch.get('message', '').split('\n')[0] if ch.get('op') == 'reword' else REVIEW['data']['commits'][idx]['subject'])), None)
        data = {'applied': True, 'status': 'accepted', 'branch': BRANCH, 'error': DEL}
        if new_commit and ch.get('op') != 'drop': data['newCommit'] = new_commit
        if FORK and not NO_PUSH:
            git('fetch', '-q', FORK, f'+refs/heads/{BRANCH}:refs/remotes/{FORK}/{BRANCH}', check=False)  # the lease compares with what the fork has now
            git('push', '-q', '--force-with-lease', FORK, f'{BRANCH}:{BRANCH}')
            if new_commit and ch.get('op') != 'drop': data['commitUrl'] = f'https://github.com/{LOGIN}/{NAME}/commit/{new_commit}'
            data['compareUrl'] = f"https://github.com/{SLUG}/compare/{REVIEW['headRef']}...{LOGIN}:{BRANCH}"
        commit_writes([{'op': 'update', 'col': 'changes', 'id': cid, 'data': data}])
        log('accepted', cid, 'on', BRANCH)
    except Exception as e:
        wgit('rebase', '--abort', check=False)
        if keep: wgit('reset', '-q', '--hard', keep, check=False)
        commit_writes([{'op': 'update', 'col': 'changes', 'id': cid, 'data': {'status': 'failed', 'error': str(e)[:300]}}])
        log('accept failed', cid, e)

def push_review_branch(rest):
    ids = re.findall(r'[\w-]+', rest.split('(', 1)[1]) if '(' in rest else []
    repo = REVIEW.get('headRepo') or ''
    if not FORK or repo.lower() != f'{LOGIN}/{NAME}'.lower():
        to_claude(None, f'[push review branch refused] the PR head branch is on {repo or "an unknown repository"}, not on the fork {LOGIN}/{NAME}; tell the user')
        return
    if NO_PUSH: log('--no-push: not pushing', BRANCH); return
    git('push', '-q', f"--force-with-lease={REVIEW['headRef']}:{REVIEW['reviewVersion']}", FORK, f"{BRANCH}:{REVIEW['headRef']}")
    log('pushed', BRANCH, 'onto', REVIEW['headRef'])
    commit_writes([{'op': 'update', 'col': 'changes', 'id': i, 'data': {'status': 'landed'}} for i in ids if i in DB['docs']['changes']])

# ---- HTTP ----------------------------------------------------------------------------------------------------------
TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8'}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, code, body, ctype='application/json'):
        b = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(code); self.send_header('content-type', ctype); self.send_header('cache-control', 'no-cache'); self.send_header('cache-control', 'no-store')
        self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def local_host(self): return (self.headers.get('host') or '').split(':')[0] in ('127.0.0.1', 'localhost')
    def do_GET(self):
        if not self.local_host(): return self.send(403, {'error': 'bad host'})
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == '/api/ping': return self.send(200, {'pr': f'{SLUG}#{N}', 'pid': os.getpid()})
        if u.path == '/api/review': return self.send(200, dict(REVIEW['data'], reviewVersion=REVIEW['reviewVersion'], appVersion=app_version()))
        if u.path == '/api/db':
            since = int((q.get('since') or ['-1'])[0])
            with lock:
                lock.wait_for(lambda: DB['version'] > since, timeout=25)
                return self.send(200, snapshot())
        name = 'index.html' if u.path in ('/', '/index.html') else u.path.lstrip('/')
        if name in ('index.html', 'app.js', 'loader.js'):
            return self.send(200, open(os.path.join(APP, name), 'rb').read(), TYPES[os.path.splitext(name)[1]])
        self.send(404, {'error': 'not found'})
    def do_POST(self):
        if not self.local_host() or not self.headers.get('x-review'): return self.send(403, {'error': 'forbidden'})
        body = json.loads(self.rfile.read(int(self.headers.get('content-length') or 0)) or b'{}')
        try:
            if self.path == '/api/db':
                writes = body['writes'] if body.get('op') == 'batch' else [body]
                ok = commit_writes(writes)
                with lock: return self.send(200, dict(snapshot(), ok=ok))
            if self.path == '/api/inbox':
                return self.send(200, take_inbox(float(body.get('wait') or 0)))
            if self.path == '/api/claude':
                return self.send(200, {'threadId': route(body.get('threadId'), body.get('text') or '')})
        except Exception as e:
            return self.send(400, {'error': str(e)[:300], 'code': 'bad_request'})
        self.send(404, {'error': 'not found'})

def bind():
    for port in ([int(PORT_OPT)] if PORT_OPT else range(8765, 8800)):
        try: return ThreadingHTTPServer(('127.0.0.1', port), H), port
        except OSError:
            if PORT_OPT: raise
    sys.exit('no free port between 8765 and 8799')

if __name__ == '__main__':
    build()
    srv, port = bind()
    for t in (watch_head, watch_app, worker): threading.Thread(target=t, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    url = f'http://127.0.0.1:{port}/'
    info = {'url': url, 'port': port, 'pid': os.getpid(), 'state': STATE, 'inbox': INBOX, 'login': LOGIN, 'fork': FORK, 'mine': REVIEW['data']['mine']}
    tmp = INFO + '.tmp'; json.dump(info, open(tmp, 'w')); os.replace(tmp, INFO)
    print(json.dumps(info), flush=True); log('listening on', url)
    if '--open' in argv: open_tab(url)
    srv.serve_forever()
