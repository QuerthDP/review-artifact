"""Claude's access to a running local review app (server.py): read and write the page's docs.

  store.py [--port 8765] list <comments|threads|changes> [--out DIR]   docs as JSON ({id: doc}); --out saves each as DIR/<id>.json
  store.py [--port 8765] get <collection> <id>
  store.py [--port 8765] set|update <collection> <id> <json | @file>   update merges fields; {"__delete__": true} removes one
  store.py [--port 8765] delete <collection> <id>
  store.py [--port 8765] batch <json | @file>                         [{op, collection, doc_id, data}], as seeds.py writes them

The page shows every write at once."""
import json, os, sys, urllib.request
a = sys.argv[1:]
port = 8765
if a[:1] == ['--port']: port, a = int(a[1]), a[2:]
BASE = f'http://127.0.0.1:{port}/api/'
def call(path, body=None):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={'content-type': 'application/json', 'x-review': '1'})
    with urllib.request.urlopen(req, timeout=60) as r: return json.load(r)
def arg(s): return json.load(open(s[1:])) if s.startswith('@') else json.loads(s)
cmd = a[0] if a else ''
if cmd in ('list', 'get'):
    snap = call('db?since=-1'); docs = snap['docs'][a[1]]
    if cmd == 'get': print(json.dumps(docs.get(a[2]), indent=1)); sys.exit(0 if a[2] in docs else 1)
    if '--out' in a:
        d = a[a.index('--out') + 1]; os.makedirs(d, exist_ok=True)
        for i, doc in docs.items(): json.dump({'data': doc, 'version': snap['docVersions'][a[1]].get(i)}, open(os.path.join(d, i + '.json'), 'w'))
        print(len(docs), 'docs saved to', d)
    else: print(json.dumps(docs, indent=1))
elif cmd in ('set', 'update', 'delete'):
    r = call('db', {'op': cmd, 'col': a[1], 'id': a[2], 'data': arg(a[3]) if cmd != 'delete' else None}); print('ok' if all(r['ok']) else 'version conflict')
elif cmd == 'batch':
    r = call('db', {'op': 'batch', 'writes': arg(a[1])}); print(sum(r['ok']), 'of', len(r['ok']), 'writes applied')
else: sys.exit(__doc__)
