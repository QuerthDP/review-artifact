"""Build the claude.ai artifact page from the web app: build.py <app dir> <diff.json> <meta.json> <out.html> [gh.json from ghthreads.py]
The page is app/index.html with the PR data and app/app.js inlined in place of the local loader (local/server.py serves
the same files on this machine instead). An old path to template.html is taken as the app dir next to it.
meta.json: {"repo": "owner/name", "pr": 123, "pr_title", "author": "<login>", "mine": true|false (viewer authored the PR),
"session": "<url of the Claude Code session answering the page>" (optional), "collapsed": ["Cargo.lock", ...]}"""
import json, os, sys
app, diff, meta, out = sys.argv[1:5]
if not os.path.isdir(app): app = os.path.join(os.path.dirname(os.path.abspath(app)), 'app')
gh = json.load(open(sys.argv[5])) if len(sys.argv) > 5 else {'threads': [], 'conversation': []}
m = json.load(open(meta)); esc = lambda s: s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
title = m.get('title') or '[%s#%s] %s (by %s)' % (m['repo'], m['pr'], m['pr_title'], m['author'])
review = {'cfg': {'repo': m['repo'], 'pr': m['pr'], 'session': m.get('session') or '',
                  'collapsed': m.get('collapsed', ['Cargo.lock', 'package-lock.json', 'yarn.lock', 'go.sum'])},
          'pr': {'title': m['pr_title'], 'author': m['author']}, 'mine': bool(m.get('mine')), 'commits': json.load(open(diff)), 'gh': gh}
data = json.dumps(review, separators=(',', ':')).replace('<', '\\u003c')
code = open(os.path.join(app, 'app.js')).read()
assert '</script' not in code.lower(), 'app.js must not contain a closing script tag'
t = open(os.path.join(app, 'index.html')).read()
loader = '<script src="loader.js"></script>'
assert t.count(loader) == 1 and t.count('<title>PR review</title>') == 1
t = (t.replace('<title>PR review</title>', '<title>' + esc(title) + '</title>')
      .replace(loader, '<script id="reviewdata" type="application/json">' + data + '</script>\n'
               "<script>window.REVIEW = JSON.parse(document.getElementById('reviewdata').textContent);</script>\n<script>\n" + code + '</script>'))
open(out, 'w').write(t); print('wrote', out, len(t) // 1024, 'KB')
