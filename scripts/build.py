"""Fill the template: build.py <template.html> <diff.json> <meta.json> <out.html> [gh.json from ghthreads.py]
meta.json: {"title", "repo": "owner/name", "pr": 123, "pr_title", "mine": true|false (viewer authored the PR), "collapsed": ["Cargo.lock", ...]}"""
import json, sys
tpl, diff, meta, out = sys.argv[1:5]
gh = open(sys.argv[5]).read() if len(sys.argv) > 5 else '{"threads": [], "conversation": []}'
m = json.load(open(meta)); esc = lambda s: s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
t = open(tpl).read()
t = (t.replace("__TITLE__", esc(m["title"])).replace("__REPO_SLUG__", m["repo"]).replace("__PR_NUMBER__", str(m["pr"]))
      .replace("__PR_TITLE__", esc(m["pr_title"])).replace("__PR_MINE__", "true" if m.get("mine") else "false").replace("__COLLAPSED_JSON__", json.dumps(m.get("collapsed", ["Cargo.lock", "package-lock.json", "yarn.lock", "go.sum"])))
      .replace("__GH_JSON__", gh.replace("<", "\\u003c"))
      .replace("__DIFF_JSON__", json.dumps(json.load(open(diff)), separators=(",", ":")).replace("<", "\\u003c")))
open(out, "w").write(t); print("wrote", out, len(t) // 1024, "KB")
