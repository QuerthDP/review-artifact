---
name: review-artifact
description: Build an interactive per-commit review page (claude.ai Artifact) for a GitHub PR — commit stepper, split/unified diff with GitHub-style context expansion, keyboard-only review, Claude's proposed comments, other reviewers' threads with queued replies, in-page conversations and change requests to Claude, and a queue that mirrors into the user's pending GitHub review. Use when the user asks to review a PR "in an artifact", runs /review-artifact <PR>, or wants a review page for a PR.
---

# /review-artifact <PR>

Argument: a PR URL or `owner/repo#N` (or `N` in the current repo). The page is the review workspace: the user reads commits, asks Claude questions in place, asks Claude for changes, approves/rejects/revises Claude's comments, replies to other reviewers, and only what they **queue** lands in their pending GitHub review.

Files in this skill dir: `template.html` (the page), `scripts/mkdiff.py`, `scripts/ghthreads.py`, `scripts/build.py`, `scripts/seeds.py`, `scripts/ghsync.py`. Work in the session scratchpad (`$S` below), never in the repo. Run the session from a local clone of the PR's repo (the scripts use `git`).

## 1. Build

1. Fetch the PR: `gh pr view <N> -R <repo> --json number,title,author,headRefOid,baseRefOid,id`. Fetch the head locally (`git fetch <remote> pull/<N>/head:pr-<N>`); base = merge-base with the base branch.
2. `python3 -I scripts/mkdiff.py <repo_dir> <base> pr-<N> $S/diff.json`
3. `python3 -I scripts/ghthreads.py <repo_dir> <owner/repo> <N> $S/diff.json $S/gh.json` — other reviewers' review threads (anchored with `git blame` to the PR commit that last changed their line) and the PR conversation.
4. `$S/meta.json`: `{"title": "PR <N> Commit Review", "repo": "<owner/repo>", "pr": <N>, "pr_title": "...", "mine": <PR author == gh api user>, "collapsed": ["Cargo.lock", ...]}` (lockfiles/generated files start collapsed).
5. `python3 -I scripts/build.py template.html $S/diff.json $S/meta.json $S/pr<N>-review.html $S/gh.json`
6. Syntax-check: `node -e` with `new Function` over each `<script>` body.
7. Publish with the Artifact tool, `capabilities: {"db": {}, "user": {}, "comments": {}}`, icon `code`. Republish the same file path for every later change (same URL). Rerun steps 3 and 5 to refresh reviewer threads.

## 2. Seed Claude's review

Review commit by commit (correctness first; verify claims by running code where possible). Write findings to `$S/findings.json` — `[{"commit": "<short>", "path": "<file>"|null, "snippet": "<exact text on the line>"|null, "side": "RIGHT", "body": "..."}]` (path null = commit-level; snippet null = file-level). Bodies: **2–3 sentences, concise**, problem then suggestion; no headings.

`python3 -I scripts/seeds.py $S/diff.json $S/findings.json $S/writes.json`, then one `ArtifactData` `batch` with those writes. Never hardcode comments into the HTML.

Also import the user's existing pending GitHub review comments (if any) as docs with `author: "user", source: "github", status: "queued", githubCommentId`, so the page shows them as "in your GitHub draft".

## 3. Data model (db collections)

- `comments/<id>`: `commit, path, line, side (LEFT|RIGHT), body, author (claude|user), status (proposed|queued|rejected|revise|posted), replyTo (review thread node id, for replies to other reviewers), humanReviewed, discussion[{role,text,at}], note, prevStatus, editedByUser, revisedAt, inDraft, githubCommentId, githubThreadId, githubPath, syncPending, shellThreadId, source`.
- `threads/<id>`: in-page conversations with Claude — `kind (question|modify|feedback), commit, path, line, side, status (asked|answered), dismissed (viewer hid an answered one; restorable from the queue), messages[{role,text,at}], shellThreadId`.
- Reviewer threads are not in the db: they are snapshotted into the page from `gh.json` at build time.

Claude's comments start **proposed**. Nothing reaches GitHub until the user clicks **Queue → GitHub draft** (or writes their own comment/reply, which is queued) — never queue on their behalf, never bulk-queue.

## 4. Respond to the page (automatic — the page pings this session)

The page sends a shell comment via `sendToClaude` for every action that needs Claude; it arrives as an artifact comment notification. The text prefix says what to do:

- `[page question <threadId>] ...` → answer in `threads/<id>`: append `{role:"claude", text, at}` to `messages`, set `status: "answered"`. Concise.
- `[revision request <commentId>] <note>` → rewrite `comments/<id>.body`, append `{role:"claude", text: "<one line: what changed / answer>", at}` to `discussion` (the page already appended the user's note), set `status` back to `prevStatus` (or `proposed`), set `revisedAt`, delete `note`/`noteAt`/`prevStatus`. If it was in the draft, run ghsync to update GitHub. If the note is a question ("do these really need…?"), answer it in `discussion` and revise accordingly.
- `[modify request <threadId>] <what to change>` (thread `kind: "modify"`, anchored to a line):
  - **PR authored by the user** (`mine`): before touching anything, keep the current version: `git branch review/pr-<N>-v<k> <current head>` (next free k). Make the change in the commit that introduced the line: commit it with `git commit --fixup=<that sha>` and fold it with `GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <base>`; resolve conflicts carefully. Never push. Rebuild diff.json from the new head and republish. Answer in the thread: one line naming the new local commit and the kept `review/pr-<N>-v<k>` branch. This explicit `m` request is the commit authorization; it covers only that change.
  - **Someone else's PR:** don't touch the code. Create a Claude comment doc on that line (`author: "claude", status: "proposed"`) whose body is a short reason plus a GitHub suggestion block (three backticks + `suggestion`, the full replacement for the anchored line(s), closing backticks) — exact indentation, only the anchored RIGHT-side line(s). Answer in the thread with one line pointing to the new comment. The user queues it like any other.
- `[feedback request <threadId>] <feedback>` (thread `kind: "feedback"`, shown only in the panel by the Feedback button, never in the diff) → feedback about this tool, not the PR. Write a concise issue (title + what happened / what's expected, plus the page context: PR, commit) and file it with `gh issue create -R QuerthDP/review-artifact`, ending the body with the "Generated with Claude Code" badge (no `ai-assisted` label on issues). Answer in the thread with one line and the issue link. If the feedback is a clear, small fix and you maintain the skill repo, also fix it.
- `[post conversation replies <id>] <comment ids>` → the user clicked "Post queued conversation replies" (a deliberate, two-click action). For each listed doc still `queued` with `replyToConv`: `gh pr comment <N> -R <repo> --body-file -` with `In reply to [<convAuthor>](<replyToConv>):` + blank line + the body (the user's own text: no badge). Then update the doc: `status: "posted"`, `githubUrl`, delete `syncPending`.
- `[submit review <id>] event=<COMMENT|APPROVE|REQUEST_CHANGES> postConversationReplies=<yes|no>` + optional summary on the next lines → the user clicked "Submit review" twice (`u` opens the panel), so submitting is authorized. First apply any docs still `syncPending`. If `postConversationReplies=yes`, post queued `replyToConv` docs as above. Then GraphQL `submitPullRequestReview(input:{pullRequestReviewId:<review_id>, event:<event>, body:<summary>})` (the user's text: no badge). Mark every doc that was in the draft `status: "posted"`. Never submit without this request.
- `[github sync <commentId>] ...` → `ArtifactData get` the doc with `out_dir`, run `python3 -I scripts/ghsync.py $S/ghsync.json <doc.json>`, then `ArtifactData update` with the printed JSON (pin `if_version`). Replies (`replyTo`) go into the pending review as thread replies.

Then resolve the shell comment thread (`ArtifactComments resolve`). An auto-reply from the harness ("On it…") does NOT mean the work was done — always do the work. When the user asks "are you responding?", query **all** pending state: comments with `status: revise`, threads with `status: asked`, docs with `syncPending`, and open shell threads.

`$S/ghsync.json`: `{"repo_dir": "...", "head": "<PR head sha>", "review_id": "<PRR_… node id>", "diff": "$S/diff.json"}`. Find the user's pending review via GraphQL `pullRequest.reviews(states: PENDING)`; if none exists, create one with `addPullRequestReview` (no `event`) — it stays private until the user submits it. Never submit the review.

## 5. GitHub rules

- Claude-written comments end (after a blank line) with the "Generated with Claude Code" shields.io badge; a "Reviewed by Human" badge is added next to it only when `humanReviewed` is true (the user clicked "Add Reviewed by Human"). The badge HTML lives in `scripts/ghsync.py` (`CLAUDE`, `HUMAN`). No prefixes like `**[Claude]**`. No Claude session links anywhere. The user's own comments and replies get no badge.
- Line comments are mapped from the commit's line to the PR head (ghsync's `map_line`); lines changed later fall back to a file-level comment. Commit-level comments become file-level comments on the commit's most-changed file, quoting the commit subject (`> subject`).
- PR conversation (issue comments, review bodies) can't be part of a pending review, so replies to it (`replyToConv`, `convAuthor`) stay queued on the page and are never synced to the draft. They are posted only when the user clicks "Post queued conversation replies".

## 6. Page features (keep when editing the template)

Commit stepper; split (default) / unified toggle; highlight.js 11.9.0 + intra-line change marks (pure insertions/deletions always marked); GitHub-style "↑ 20 / ↓ 20 / ↕ all" context expansion from each file's full text; viewed checkboxes (localStorage); sticky file header; hide/show queue; **Feedback** button / `f` (opens the feedback panel: the viewer tells Claude, which files the issue on `QuerthDP/review-artifact`); full keyboard review with an always-selected cursor (commit-level items / file header / expander / line): `[` `]` commit, `j`/`l` up/down, PgUp/PgDn a screen with the cursor following, `n`/`p` next/previous comment, `k` comment, `u` submit review, `f` feedback, `h` show/hide the queue, `i` ask Claude, `m` ask Claude to change the line, Enter expand gap / toggle file or thread, Ctrl+Enter save, Esc cancel — hidden alternatives, never shown in the help: ↑/↓ = `j`/`l`, ←/→ = `p`/`n`; the per-line `+` `✎` `?` toolbar shows only on mouse hover; reviewer threads (resolved ones collapsed) with "Reply (queue to your GitHub draft)"; Claude comment cards with Queue / Add Reviewed by Human / Ask Claude to revise / Reject, a persistent discussion log, and "in your GitHub draft" / "syncing to GitHub…" pills. When the user reports a UI problem via a page comment, fix `template.html` in this skill too, not only the scratch copy.
