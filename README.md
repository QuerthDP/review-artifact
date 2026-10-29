# review-artifact

A [Claude Code](https://claude.com/claude-code) skill that turns a GitHub pull request into an interactive, per-commit review page (a claude.ai Artifact).

- Step through the PR commit by commit, in split or unified view, with syntax highlighting, intra-line change marks and GitHub-style "expand context".
- Review with the keyboard only: `[` `]` commit, `j` `l` move, PgUp/PgDn screen, `n` `p` next/previous comment, `k` comment, `i` ask Claude, `m` ask Claude to change the line, Enter expand.
- Claude proposes review comments; you queue, revise ("Ask Claude to revise"), mark as reviewed or reject them.
- Ask Claude about any line or commit; the conversation stays on the page.
- Other reviewers' threads appear on their lines; reply to them in place.
- Everything you queue is mirrored into **your pending GitHub review**, which stays private until you submit it yourself.
- On your own PR, `m` makes Claude edit and commit locally (previous version kept on a `review/pr-<N>-v<k>` branch); on someone else's it drafts a ```` ```suggestion ```` comment.

## Install

```sh
git clone https://github.com/QuerthDP/review-artifact ~/.claude/skills/review-artifact
```

Then, in a Claude Code session inside a clone of the repository under review:

```
/review-artifact https://github.com/<owner>/<repo>/pull/<N>
```

Requirements: `gh` (authenticated), `git`, `python3`, and a claude.ai account with Artifacts. `node` is used for a syntax check.

Optional badges: put `{"claude": "<html>", "human": "<html>"}` in `~/.config/review-artifact/badges.json` to sign what Claude posts (and comments you mark "Reviewed by Human"). Without it nothing is signed.

## Feedback

Use the **Feedback** button (or `f`) on any review page: tell Claude what bothers you and it files the issue. Or [open one directly](https://github.com/QuerthDP/review-artifact/issues/new).

<a href="https://claude.com/claude-code"><img alt="Generated with Claude Code" src="https://img.shields.io/badge/Generated%20with-Claude%20Code-D97757?style=for-the-badge&logo=claude&logoColor=white"></a>
