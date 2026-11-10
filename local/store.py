"""Claude's access to a running local review app (server.py): read and write the page's docs.

  store.py [--port 8765] list <comments|threads|changes> [--out DIR]   docs as JSON ({id: doc}); --out saves each as DIR/<id>.json
  store.py [--port 8765] get <collection> <id>
  store.py [--port 8765] set|update <collection> <id> <json | @file>   update merges fields; {"__delete__": true} removes one
  store.py [--port 8765] delete <collection> <id>
  store.py [--port 8765] batch <json | @file>                         [{op, collection, doc_id, data}], as seeds.py writes them
  store.py [--port 8765] apply <change id>...                          accepts written changes the user asked for (autoApplied),
                                                                      in order, as the page's Accept does: onto review/pr-<N>
  store.py [--port 8765] next [--wait 540]                            the page's next requests to Claude, one JSON line each;
                                                                      "idle" after the wait, "server stopped" (exit 3) once it is gone
  store.py [--port 8765] wait                                          blocks, taking nothing, until the page has sent requests:
                                                                      "pending <n>", or "server stopped" (exit 3)

The page shows every write at once."""
import json, os, sys, urllib.error, urllib.request
a = sys.argv[1:]
port = 8765
if a[:1] == ['--port']: port, a = int(a[1]), a[2:]
BASE = f'http://127.0.0.1:{port}/api/'
def call(path, body=None, timeout=60):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(),
                                 headers={'content-type': 'application/json', 'x-review': '1'})
    with urllib.request.urlopen(req, timeout=timeout) as r: return json.load(r)
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
elif cmd == 'next':
    wait = int(a[a.index('--wait') + 1]) if '--wait' in a else 540
    try: items = call('inbox', {'wait': wait}, timeout=wait + 60)
    except TimeoutError: items = []
    except (urllib.error.URLError, ConnectionError) as e:
        if isinstance(e, urllib.error.HTTPError): raise
        if isinstance(getattr(e, 'reason', None), TimeoutError): items = []
        else: print('server stopped'); sys.exit(3)
    for it in items: print(json.dumps(it))
    if not items: print('idle')
elif cmd == 'wait':
    while True:
        try: n = call('pending', {'wait': 540}, timeout=600)['pending']
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            if isinstance(e, urllib.error.HTTPError): raise
            if isinstance(e, TimeoutError) or isinstance(getattr(e, 'reason', None), TimeoutError): continue
            print('server stopped'); sys.exit(3)
        if n: print('pending', n); break
elif cmd == 'apply':
    import time
    if not call('review').get('mine'): sys.exit('not the user\'s own PR: leave the changes proposed')
    for i in a[1:]:
        at = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
        r = call('db', {'op': 'update', 'col': 'changes', 'id': i, 'data': {'status': 'accepted', 'applied': False, 'autoApplied': True, 'decidedAt': at, 'error': {'__delete__': True}}})
        if not all(r['ok']): sys.exit(f'{i}: version conflict')
        call('claude', {'threadId': None, 'text': f'[accept change {i}] applied at the user\'s request'}); print('applying', i)
elif cmd == 'batch':
    r = call('db', {'op': 'batch', 'writes': arg(a[1])}); print(sum(r['ok']), 'of', len(r['ok']), 'writes applied')
else: sys.exit(__doc__)
