"""Body for a RemoteTrigger create that runs the review of one PR in a persistent cloud session.
routine.py <PR url | owner/repo#N> [--adopt <artifact url>] [--collapsed a,b] [--pr-title T] [--note TEXT] [--model M] [--env ENV_ID] [--connector UUID]
Prints the JSON body. Reads the viewer's login with gh and the badges from ~/.config/review-artifact/badges.json."""
import argparse, datetime, json, os, re, subprocess, uuid
HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument('pr'); ap.add_argument('--adopt'); ap.add_argument('--collapsed'); ap.add_argument('--pr-title'); ap.add_argument('--note')
ap.add_argument('--model', default='claude-opus-5-5')
ap.add_argument('--env', default='env_01LoSNPDYjEzh2KCSugLp3Za')
ap.add_argument('--connector', default='40b59e0e-7524-4f19-b410-028de6a85e78')
a = ap.parse_args()
m = re.search(r'github\.com/([^/]+/[^/]+)/pull/(\d+)', a.pr) or re.fullmatch(r'([^/\s]+/[^#\s]+)#(\d+)', a.pr)
if not m: raise SystemExit('expected a PR url or owner/repo#N')
repo, pr = m.group(1), int(m.group(2))
gh = lambda *x: subprocess.run(['gh', 'api', *x], capture_output=True, text=True, check=True).stdout
login = gh('user', '--jq', '.login').strip()
info = json.loads(gh(f'repos/{repo}/pulls/{pr}'))
try: badges = json.load(open(os.path.expanduser('~/.config/review-artifact/badges.json')))
except FileNotFoundError: badges = {}
modes = dict(re.findall(r'<!-- (\w+) -->\n(.*?)(?=\n<!-- |\Z)', open(f'{HERE}/modes.md').read(), re.S))
meta = {'repo': repo, 'pr': pr, 'pr_title': a.pr_title or info['title'], 'author': info['user']['login'], 'mine': info['user']['login'] == login}
if a.collapsed: meta['collapsed'] = a.collapsed.split(',')
mode = (modes['adopt'].replace('{{ADOPT_URL}}', a.adopt).replace('{{ADOPT_META}}', json.dumps(meta)) if a.adopt else modes['build']) + (f'\n\nWhat the user says about the current state: {a.note}' if a.note else '')
prompt = open(f'{HERE}/prompt.md').read()
for k, v in {'MODE': mode.strip(), 'REPO': repo, 'REPO_NAME': repo.split('/')[1], 'PR': str(pr),
             'PR_URL': f'https://github.com/{repo}/pull/{pr}', 'LOGIN': login, 'BADGES_JSON': json.dumps(badges)}.items():
    prompt = prompt.replace('{{%s}}' % k, v)
sources = [{'git_repository': {'url': f'https://github.com/{r}'}} for r in dict.fromkeys([repo, 'QuerthDP/review-artifact'])]
when = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)).strftime('%Y-%m-%dT%H:%M:%SZ')
print(json.dumps({
    'name': f'review {repo}#{pr}', 'run_once_at': when, 'enabled': True, 'persist_session': True,
    'mcp_connections': [
        {'connector_uuid': a.connector, 'name': 'Github-CoPilot', 'url': 'https://api.githubcopilot.com/mcp'},
        # the session registers its durable page watch through this one
        {'connector_uuid': 'bf7c680d-5fdc-5ef4-b4a0-abadb619bf0a', 'name': 'Claude_Code_Remote',
         'url': 'https://api.anthropic.com/v1/code/mcp/meta'}],
    'job_config': {'ccr': {'environment_id': a.env, 'session_context': {
        'model': a.model, 'sources': sources,
        'allowed_tools': ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'ToolSearch', 'Agent', 'Artifact', 'ArtifactComments', 'ArtifactData']},
        'events': [{'data': {'uuid': str(uuid.uuid4()), 'session_id': '', 'type': 'user', 'parent_tool_use_id': None,
                             'message': {'role': 'user', 'content': prompt}}}]}}}, indent=1))
