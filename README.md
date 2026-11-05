# review-artifact

A [Claude Code](https://claude.com/claude-code) skill that turns a GitHub pull request into an interactive, per-commit review page: a local web app on your machine, or a claude.ai Artifact run by a cloud session.

- Step through the PR commit by commit, in split or unified view, with syntax highlighting, intra-line change marks and GitHub-style "expand context".
- Review with the keyboard only: `[` `]` commit, `j` `l` move, PgUp/PgDn screen, `n` `p` next/previous comment, `k` comment, `i` ask Claude, `m` ask Claude to change the line, Enter expand.
- Claude proposes review comments; you queue, revise ("Ask Claude to revise"), mark as reviewed or reject them.
- Ask Claude about any line or commit; the conversation stays on the page.
- Other reviewers' threads appear on their lines; reply to them in place.
- Everything you queue is mirrored into **your pending GitHub review**, which stays private until you submit it yourself.
- `m` makes Claude propose the change as a card with Accept / Decline. On your own PR, Accept folds it into its commit on a `review/pr-<N>` branch pushed to your fork (the previous version kept as `review/pr-<N>-v<k>`); "Push to the PR" moves it onto your PR branch. Nothing is ever pushed to the upstream repository and the page shows the new lines in amber over the diff; on someone else's PR, Accept queues it as a ```` ```suggestion ```` comment.

## Install

```sh
git clone https://github.com/QuerthDP/review-artifact ~/.claude/skills/review-artifact
ln -s review-artifact/remote ~/.claude/skills/review-artifact-remote
```

The clone gives two skills:

- `/review-artifact <PR>` runs the page as a local web app (`local/server.py`) and opens it in a browser tab; run it inside a clone of the repository under review. Accepting changes, GitHub sync and submitting run on your machine at once. A background Claude agent answers questions and change requests, so the session you started it from stays free. `--stop` stops the app; it also stops by itself once the PR is closed.
- `/review-artifact-remote <PR>` builds the page as a claude.ai Artifact, usable from anywhere, and starts a persistent claude.ai/code cloud session (a routine) that keeps answering it, so your machine does not have to stay on. `--adopt <artifact url>` hands an existing page over to the cloud. The cloud session reaches GitHub over REST only, through the repositories attached to it.

```
/review-artifact https://github.com/<owner>/<repo>/pull/<N>
```

Requirements: `gh` (authenticated), `git`, `python3`, a browser; a claude.ai account with Artifacts and cloud sessions for `/review-artifact-remote`. `node` is used for a syntax check.

Optional badges: put `{"claude": "<html>", "human": "<html>"}` in `~/.config/review-artifact/badges.json` to sign what Claude posts (and comments you mark "Reviewed by Human"). Without it nothing is signed.

## Feedback

Use the **Feedback** button (or `f`) on any review page: tell Claude what bothers you: it files the issue and, when it can push to this repo, fixes the tool and pushes the fix. Or [open one directly](https://github.com/QuerthDP/review-artifact/issues/new).

<a href="https://claude.com/claude-code"><img alt="Generated with Claude Code" src="https://img.shields.io/badge/Generated%20with-Claude%20Code-D97757?style=for-the-badge&logo=claude&logoColor=white"></a>
