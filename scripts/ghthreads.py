"""Other reviewers' threads + PR conversation for the page: ghthreads.py <repo_dir> <owner/repo> <N> <diff.json> <out.json>
REST only (GraphQL is blocked in some sessions). Each review thread is anchored to the PR commit that last changed its
line (git blame at the PR head, or at the comment's original commit when outdated) and carries rootCommentId, the
numeric id of its first comment, which replies are posted to. The viewer's pending comments are not listed by REST.
REST has no resolved state: one GraphQL read fills it in when it is reachable, otherwise resolved is null (unknown)."""
import json, re, subprocess, sys
repo_dir, slug, num, diff, out = sys.argv[1:6]
owner, name = slug.split('/')
def git(*a): return subprocess.run(['git', '-C', repo_dir, *a], capture_output=True, text=True, errors='replace').stdout
def api(path):  # every page, with rendered HTML bodies (body_html)
    r = subprocess.run(['gh', 'api', '--paginate', '--slurp', '-H', 'Accept: application/vnd.github.full+json', f'repos/{slug}/{path}'],
                       capture_output=True, text=True, check=True)
    return [x for page in json.loads(r.stdout) for x in page]
me = subprocess.run(['gh', 'api', 'user', '--jq', '.login'], capture_output=True, text=True, check=True).stdout.strip()
head = json.loads(subprocess.run(['gh', 'api', f'repos/{slug}/pulls/{num}'], capture_output=True, text=True, check=True).stdout)['head']['sha']
rc = api(f'pulls/{num}/comments?per_page=100')
resolved = {}  # root comment id -> isResolved
try:
    q = '''query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){
     reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{databaseId}}}}}}}'''
    r = subprocess.run(['gh', 'api', 'graphql', '-f', 'query=' + q, '-f', f'o={owner}', '-f', f'n={name}', '-F', f'p={num}'], capture_output=True, text=True, timeout=30)
    for t in json.loads(r.stdout)['data']['repository']['pullRequest']['reviewThreads']['nodes']:
        if t['comments']['nodes']: resolved[t['comments']['nodes'][0]['databaseId']] = t['isResolved']
except Exception as e: print('resolved state unknown (GraphQL unavailable):', type(e).__name__, file=sys.stderr)
commits = json.load(open(diff)); shas = {c['sha'] for c in commits}
touch = {}  # path -> last PR commit touching it
for c in commits:
    for f in c['files']: touch[f['path']] = c['sha']
def anchor(rev, path, line):
    if line:
        m = re.match(r'([0-9a-f]{40}) (\d+) \d+', git('blame', '--porcelain', '-L', f'{line},{line}', rev, '--', path))
        if m and m[1] in shas: return {'commit': m[1], 'path': path, 'line': int(m[2]), 'side': 'RIGHT'}
    return {'commit': touch.get(path) or commits[-1]['sha'], 'path': path if path in touch else None, 'line': None, 'side': None}
byid = {c['id']: c for c in rc}
def root(c):
    while c.get('in_reply_to_id') in byid: c = byid[c['in_reply_to_id']]
    return c
groups = {}
for c in sorted(rc, key=lambda c: c['id']): groups.setdefault(root(c)['id'], []).append(c)
threads = []
for rid, cs in groups.items():
    r0 = byid[rid]; outdated = r0.get('position') is None and r0.get('subject_type') != 'file'
    line = r0.get('line'); side = r0.get('side') or 'RIGHT'
    if line and not outdated and r0.get('subject_type') != 'file' and side == 'RIGHT': a = anchor(head, r0['path'], line)
    elif r0.get('subject_type') != 'file' and r0.get('original_line'): a = anchor(r0['original_commit_id'], r0['path'], r0['original_line'])
    else: a = anchor(None, r0['path'], None)
    threads.append(dict(a, id=r0['node_id'], rootCommentId=rid, resolved=resolved.get(rid), outdated=outdated, ghPath=r0['path'], ghLine=line or r0.get('original_line'),
                        comments=[{'author': (c['user'] or {}).get('login', 'ghost'), 'html': c.get('body_html') or '', 'at': c['created_at'], 'url': c['html_url']} for c in cs]))
conv = [{'author': (r['user'] or {}).get('login', 'ghost'), 'html': r.get('body_html') or '', 'at': r.get('submitted_at'), 'url': r['html_url'], 'kind': 'review ' + r['state'].lower()}
        for r in api(f'pulls/{num}/reviews?per_page=100') if (r.get('body') or '').strip() and r['state'] != 'PENDING' and (r['user'] or {}).get('login') != me]
conv += [{'author': (c['user'] or {}).get('login', 'ghost'), 'html': c.get('body_html') or '', 'at': c['created_at'], 'url': c['html_url'], 'kind': 'comment'} for c in api(f'issues/{num}/comments?per_page=100')]
conv.sort(key=lambda x: x['at'] or '')
json.dump({'threads': threads, 'conversation': conv}, open(out, 'w'))
for t in threads: print(t['rootCommentId'], t['commit'][:7], t['path'], t['line'], {True: 'resolved', False: 'open', None: '?'}[t['resolved']], len(t['comments']), 'comments')
print(len(conv), 'conversation items')
