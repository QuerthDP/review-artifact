"""Mirror one comment doc into the user's pending GitHub review: ghsync.py <config.json> <comment.json>
config.json: {"repo_dir", "head": "<PR head sha>", "review_id": "<PRR_... node id of the user's PENDING review>", "diff": "<diff.json>"}
comment.json: the doc as ArtifactData get/out_dir saved it. Queued -> add/update; not queued but in draft -> delete.
Prints the ArtifactData "update" data to write back (always clears syncPending)."""
import json, os, re, subprocess, sys
CFG = json.load(open(sys.argv[1])); REPO = CFG["repo_dir"]; HEAD = CFG["head"]; REVIEW = CFG["review_id"]
# Badges are a per-user choice: ~/.config/review-artifact/badges.json {"claude": html, "human": html}; none without it.
try: BADGES = json.load(open(os.path.expanduser('~/.config/review-artifact/badges.json')))
except FileNotFoundError: BADGES = {}
CLAUDE, HUMAN = BADGES.get('claude', ''), BADGES.get('human', '')
# Commit-level comments become file-level comments on the commit's most-changed file (GitHub has no commit-level review comments).
MAIN = {c["sha"][:7]: max(c["files"], key=lambda f: f["add"] + f["del"])["path"] for c in json.load(open(CFG["diff"])) if c["files"]}
def git(*a): return subprocess.run(['git', '-C', REPO, *a], capture_output=True, text=True, check=True).stdout
def gql(q, **v):
    a = ['gh', 'api', 'graphql', '-f', 'query=' + q]
    for k, x in v.items(): a += (['-F', f'{k}={x}'] if isinstance(x, int) else ['-f', f'{k}={x}'])
    r = json.loads(subprocess.run(a, capture_output=True, text=True).stdout or '{}')
    if r.get('errors'): raise SystemExit(json.dumps(r['errors']))
    return r['data']
def map_line(sha, path, line):
    off = 0
    for m in re.finditer(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@', git('diff', '-U0', sha, HEAD, '--', path), re.M):
        os_, oc = int(m[1]), int(m[2] if m[2] is not None else 1); nc = int(m[4] if m[4] is not None else 1)
        if line < (os_ if oc else os_ + 1): break
        if oc and line < os_ + oc: return None
        off += nc - oc
    return line + off
def body_of(c):
    b = c['body']
    if not c.get('path') and not c.get('replyTo'): b = '> ' + git('log', '-1', '--format=%s', c['commit']).strip() + '\n\n' + b
    if c['author'] == 'claude' and CLAUDE: b += '\n\n' + CLAUDE + (' ' + HUMAN if c.get('humanReviewed') and HUMAN else '')
    return b
c = json.load(open(sys.argv[2])); upd = {'syncPending': {'__delete__': True}}
want = c.get('status') == 'queued' and c.get('source') != 'github'
node = None
if c.get('githubCommentId'):
    ns = gql('query{node(id:"%s"){...on PullRequestReview{comments(first:100){nodes{id databaseId}}}}}' % REVIEW)['node']['comments']['nodes']
    node = next((n['id'] for n in ns if n['databaseId'] == c['githubCommentId']), None)
if want and node:
    gql('mutation($i:ID!,$b:String!){updatePullRequestReviewComment(input:{pullRequestReviewCommentId:$i,body:$b}){clientMutationId}}', i=node, b=body_of(c)); print('updated', file=sys.stderr)
elif want and c.get('replyTo'):  # reply into another reviewer's thread, inside the pending review
    q = 'mutation($t:ID!,$r:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,pullRequestReviewId:$r,body:$b}){comment{databaseId}}}'
    cm = gql(q, t=c['replyTo'], r=REVIEW, b=body_of(c))['addPullRequestReviewThreadReply']['comment']
    upd.update(inDraft=True, githubThreadId=c['replyTo'], githubCommentId=cm['databaseId']); print('replied', file=sys.stderr)
elif want:
    q = 'mutation($r:ID!,$p:String!,$b:String!,$l:Int,$s:DiffSide,$t:PullRequestReviewThreadSubjectType){addPullRequestReviewThread(input:{pullRequestReviewId:$r,path:$p,body:$b,line:$l,side:$s,subjectType:$t}){thread{id comments(first:1){nodes{databaseId}}}}}'
    line = map_line(c['commit'], c['path'], c['line']) if c.get('path') and c.get('line') and (c.get('side') or 'RIGHT') == 'RIGHT' else None
    path = c.get('path') or MAIN[c['commit'][:7]]
    v = dict(r=REVIEW, p=path, b=body_of(c), t='LINE' if line else 'FILE')
    if line: v.update(l=line, s='RIGHT')
    th = gql(q, **v)['addPullRequestReviewThread']['thread']
    upd.update(inDraft=True, githubThreadId=th['id'], githubCommentId=th['comments']['nodes'][0]['databaseId'], githubPath=path); print('added', line, file=sys.stderr)
elif node:
    gql('mutation($i:ID!){deletePullRequestReviewComment(input:{id:$i}){clientMutationId}}', i=node); print('removed', file=sys.stderr)
    upd.update(inDraft={'__delete__': True}, githubThreadId={'__delete__': True}, githubCommentId={'__delete__': True}, githubPath={'__delete__': True})
print(json.dumps(upd))
