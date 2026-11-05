"""Anchor Claude's findings to diff lines: seeds.py <diff.json> <findings.json> <out-writes.json> [--mine]
findings.json: [{"commit": "<short sha>", "path": "<file>" | null, "snippet": "<text on the line>" | null, "side": "RIGHT"|"LEFT", "body": "..."}]
path null = commit-level; snippet null = file-level. Output is a list of ArtifactData batch writes (collection "comments", status "proposed").
--mine (the viewer's own PR): every finding is a proposed change instead (collection "changes"), never a comment for GitHub. Each needs
"old" (the exact RIGHT-side lines at the snippet, first line containing it) and "new" (replacement lines, [] deletes), or no path and
"op": "drop" | "reword" (with "message"); "body" becomes the change's reason."""
import datetime, json, sys
diff, findings, out = sys.argv[1:4]
mine = "--mine" in sys.argv[4:]
by = {c["sha"][:7]: c for c in json.load(open(diff))}
def find(c, path, snip, side):
    for f in c["files"]:
        if f["path"] != path: continue
        for h in f["hunks"]:
            for l in h["lines"]:
                if snip in l["s"] and ((side == "RIGHT" and l["t"] != "d") or (side == "LEFT" and l["t"] == "d")):
                    return l["o"] if side == "LEFT" else l["n"]
    raise SystemExit(f"not found in diff: {c['short']} {path} {snip!r}")
writes = []
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
for i, x in enumerate(json.load(open(findings)), 1):
    c = by[x["commit"][:7]]; side = x.get("side") or "RIGHT"
    line = find(c, x["path"], x["snippet"], side) if x.get("path") and x.get("snippet") else None
    if mine:
        if x.get("path"):
            if line is None or "old" not in x or "new" not in x: raise SystemExit(f"finding {i}: on the viewer's own PR a line finding needs snippet, old and new")
            d = {"commit": c["sha"], "path": x["path"], "startLine": line if len(x["old"]) > 1 else None, "line": line + len(x["old"]) - 1, "side": "RIGHT", "old": x["old"], "new": x["new"]}
        elif x.get("op") in ("drop", "reword"):
            d = {"commit": c["sha"], "path": None, "line": None, "startLine": None, "side": "RIGHT", "op": x["op"], "oldMessage": "\n\n".join(p for p in (c.get("subject"), c.get("body")) if p)}
            if x["op"] == "reword": d["message"] = x["message"]
        else: raise SystemExit(f"finding {i}: on the viewer's own PR a commit-level finding needs op drop or reword")
        d.update({"reason": x["body"], "status": "proposed", "author": "claude", "at": now()})
        writes.append({"op": "set", "collection": "changes", "doc_id": f"claude_chg_{i:02d}", "data": d}); continue
    writes.append({"op": "set", "collection": "comments", "doc_id": f"claude_{i:02d}", "data": {
        "commit": c["sha"], "path": x.get("path"), "line": line, "side": side if line else None, "body": x["body"],
        "author": "claude", "status": "proposed", "createdAt": now()}})
json.dump(writes, open(out, "w"), indent=1)
for w in writes: print(w["collection"], w["doc_id"], w["data"]["commit"][:7], w["data"]["path"], w["data"]["line"])
