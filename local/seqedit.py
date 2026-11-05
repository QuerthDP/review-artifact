"""Git sequence editor for the review branch: seqedit.py <action> <commit sha> <todo file>.
Turns the todo line that picks that commit into <action> (drop, reword, edit)."""
import sys
action, sha, path = sys.argv[1:4]
lines = open(path).read().split('\n')
out = [action + l[4:] if l.startswith('pick ') and len(l.split()) > 1 and sha.startswith(l.split()[1]) else l for l in lines]
if out == lines: sys.exit(f'seqedit: no pick line for {sha}')
open(path, 'w').write('\n'.join(out))
