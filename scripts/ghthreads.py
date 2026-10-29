"""Other reviewers' threads + PR conversation for the page: ghthreads.py <repo_dir> <owner/repo> <N> <diff.json> <out.json>
Each review thread is anchored to the PR commit that last changed its line (git blame at the PR head, or at the
comment's original commit when outdated). The viewer's own PENDING comments are skipped (they are page docs already)."""
import json, re, subprocess, sys
repo_dir, slug, num, diff, out = sys.argv[1:6]
owner, name = slug.split('/')
def git(*a): return subprocess.run(['git', '-C', repo_dir, *a], capture_output=True, text=True, errors='replace').stdout
Q = '''query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){headRefOid
 reviewThreads(first:100){nodes{id isResolved isOutdated path line originalLine diffSide subjectType
  comments(first:100){nodes{id databaseId author{login} bodyHTML createdAt url originalCommit{oid} pullRequestReview{state viewerDidAuthor}}}}}
 reviews(first:100){nodes{author{login} state bodyHTML submittedAt url viewerDidAuthor}}
 comments(first:100){nodes{author{login} bodyHTML createdAt url}}}}}'''
pr = json.loads(subprocess.run(['gh', 'api', 'graphql', '-f', 'query=' + Q, '-f', f'o={owner}', '-f', f'n={name}', '-F', f'p={num}'],
                               capture_output=True, text=True, check=True).stdout)['data']['repository']['pullRequest']
commits = json.load(open(diff)); shas = {c['sha'] for c in commits}
touch = {}  # path -> last PR commit touching it
for c in commits:
    for f in c['files']: touch[f['path']] = c['sha']
def anchor(rev, path, line):
    if line:
        m = re.match(r'([0-9a-f]{40}) (\d+) \d+', git('blame', '--porcelain', '-L', f'{line},{line}', rev, '--', path))
        if m and m[1] in shas: return {'commit': m[1], 'path': path, 'line': int(m[2]), 'side': 'RIGHT'}
    return {'commit': touch.get(path) or commits[-1]['sha'], 'path': path if path in touch else None, 'line': None, 'side': None}
threads = []
for t in pr['reviewThreads']['nodes']:
    cs = [c for c in t['comments']['nodes'] if not (c['pullRequestReview'] and c['pullRequestReview']['state'] == 'PENDING' and c['pullRequestReview']['viewerDidAuthor'])]
    if not cs: continue
    if t['line'] and not t['isOutdated'] and t['subjectType'] == 'LINE' and (t['diffSide'] or 'RIGHT') == 'RIGHT': a = anchor(pr['headRefOid'], t['path'], t['line'])
    elif t['subjectType'] == 'LINE' and t['originalLine']: a = anchor(cs[0]['originalCommit']['oid'], t['path'], t['originalLine'])
    else: a = anchor(None, t['path'], None)
    threads.append(dict(a, id=t['id'], resolved=t['isResolved'], outdated=t['isOutdated'], ghPath=t['path'], ghLine=t['line'] or t['originalLine'],
                        comments=[{'author': (c['author'] or {}).get('login', 'ghost'), 'html': c['bodyHTML'], 'at': c['createdAt'], 'url': c['url']} for c in cs]))
conv = [{'author': (r['author'] or {}).get('login', 'ghost'), 'html': r['bodyHTML'], 'at': r['submittedAt'], 'url': r['url'], 'kind': 'review ' + r['state'].lower()}
        for r in pr['reviews']['nodes'] if r['bodyHTML'].strip() and not r['viewerDidAuthor']]
conv += [{'author': (c['author'] or {}).get('login', 'ghost'), 'html': c['bodyHTML'], 'at': c['createdAt'], 'url': c['url'], 'kind': 'comment'} for c in pr['comments']['nodes']]
conv.sort(key=lambda x: x['at'] or '')
json.dump({'threads': threads, 'conversation': conv}, open(out, 'w'))
for t in threads: print(t['id'][-6:], t['commit'][:7], t['path'], t['line'], 'resolved' if t['resolved'] else 'open', len(t['comments']), 'comments')
print(len(conv), 'conversation items')
