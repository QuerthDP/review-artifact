"""Per-commit diff data for the review page: mkdiff.py <repo> <base> <head> <out.json>"""
import json, re, subprocess, sys
repo, base, head, out = sys.argv[1:5]
def git(*a, check=True): return subprocess.run(["git", "-C", repo, *a], capture_output=True, text=True, errors="replace", check=check).stdout
commits = []
for sha in git("rev-list", "--reverse", f"{base}..{head}").split():
    meta = git("show", "-s", "--format=%H%n%h%n%s%n%b", sha).split("\n", 3)
    files = []; cur = hunk = None; old = new = 0
    for line in git("show", "--format=", "--no-color", "-U3", sha).split("\n"):
        if line.startswith("diff --git"):
            m = re.match(r"diff --git a/(.*) b/(.*)", line); cur = {"path": m.group(2), "hunks": [], "add": 0, "del": 0, "status": "M"}; files.append(cur); hunk = None
        elif cur and line.startswith("new file"): cur["status"] = "A"
# scratch change in the middle
        elif cur and line.startswith("deleted file"): cur["status"] = "D"
        elif cur and line.startswith("@@"):
            m = re.match(r"@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)", line)
            old, new = int(m.group(1)), int(m.group(2)); hunk = {"header": line, "lines": []}; cur["hunks"].append(hunk)
        elif hunk is not None and line and line[0] in " +-" and not line.startswith(("+++", "---")):
            t, txt = line[0], line[1:]
            if t == " ": hunk["lines"].append({"t": "c", "o": old, "n": new, "s": txt}); old += 1; new += 1
            elif t == "+": hunk["lines"].append({"t": "a", "n": new, "s": txt}); new += 1; cur["add"] += 1
            else: hunk["lines"].append({"t": "d", "o": old, "s": txt}); old += 1; cur["del"] += 1
    for f in files:  # full text at this commit, for GitHub-style context expansion
        if f["status"] != "D" and f["hunks"]:
            f["text"] = git("show", f"{sha}:{f['path']}", check=False).split("\n")
            if f["text"] and f["text"][-1] == "": f["text"].pop()
    commits.append({"sha": meta[0], "short": meta[1], "subject": meta[2], "body": meta[3].strip() if len(meta) > 3 else "", "files": files})
json.dump(commits, open(out, "w"))
print(len(commits), "commits;", sum(len(c["files"]) for c in commits), "file diffs;", len(json.dumps(commits)) // 1024, "KB")
