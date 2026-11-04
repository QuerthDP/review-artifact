"""Anchor Claude's findings to diff lines: seeds.py <diff.json> <findings.json> <out-writes.json>
findings.json: [{"commit": "<short sha>", "path": "<file>" | null, "snippet": "<text on the line>" | null, "side": "RIGHT"|"LEFT", "body": "..."}]
path null = commit-level; snippet null = file-level. Output is a list of ArtifactData batch writes (collection "comments", status "proposed")."""
import datetime, json, sys
diff, findings, out = sys.argv[1:4]
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
for i, x in enumerate(json.load(open(findings)), 1):
    c = by[x["commit"][:7]]; side = x.get("side") or "RIGHT"
    line = find(c, x["path"], x["snippet"], side) if x.get("path") and x.get("snippet") else None
    writes.append({"op": "set", "collection": "comments", "doc_id": f"claude_{i:02d}", "data": {
        "commit": c["sha"], "path": x.get("path"), "line": line, "side": side if line else None, "body": x["body"],
        "author": "claude", "status": "proposed", "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat()}})
json.dump(writes, open(out, "w"), indent=1)
for w in writes: print(w["doc_id"], w["data"]["commit"][:7], w["data"]["path"], w["data"]["line"])

def count_open(findings):  # scratch helper for the cloud review test
    return len([f for f in findings if f.get('status') != 'rejected']) + 1
