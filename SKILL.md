---
name: review-artifact
description: Review a GitHub PR on an interactive per-commit review page (claude.ai Artifact) run by a persistent cloud session, so the page keeps answering requests (questions, change requests, GitHub sync, submit) without the user's machine. Use when the user runs /review-artifact <PR>, or wants a PR review page run in the cloud, or wants the cloud to take over an existing review page. For a review run by the local session, use /review-artifact-local.
---

# /review-artifact <PR> [--adopt <artifact url>]

Starts a routine whose cloud session follows the `/review-artifact-local` workflow (`local/SKILL.md` in this repo) for the PR: it builds and publishes the review page, or adopts an existing one, then keeps a durable watch on the page and answers it. Argument: a PR URL or `owner/repo#N`. `$R` below is this skill's directory.

1. Build the routine body: `python3 -I $R/cloud/routine.py <PR> [--adopt <url>] [--collapsed a,b] [--pr-title <title the page was built with>] [--note "<state the session should know>"] > $S/routine.json` ($S = the session scratchpad). It reads the user's login and `~/.config/review-artifact/badges.json` locally and embeds them in the prompt (`cloud/prompt.md` plus a mode from `cloud/modes.md`), attaches the PR's repo and QuerthDP/review-artifact as sources, the GitHub connector, the Claude Code remote connector (the session registers its durable page watch through it; without it the watch fails with `mint_failed`), the Default environment, `persist_session: true`, and a placeholder `run_once_at` an hour ahead (the API needs one; a scheduled one-off may never fire). Defaults: `--model claude-opus-5-5`; `--env` and `--connector` default to the user's Default environment and GitHub connector.
   - `--adopt <url>`: the session reads and watches that page instead of building one; it never republishes it or touches its database during setup and makes no GitHub writes then. When adopting a page whose title differs from the PR's current one, pass the old title with `--pr-title` so a later republish keeps it.
2. Load `RemoteTrigger` (ToolSearch `select:RemoteTrigger`) and call `action: "create"` with the file's JSON as `body`, then `action: "run"` on the new routine at once, then `action: "update"` with `{"enabled": false}` so the placeholder fire does not post the prompt into the session again (a disabled routine's persistent session keeps waking on page comments). Never print the prompt's badge or anything secret back to the user.
3. Print the routine link `https://claude.ai/code/routines/<id>`. After the fire time, `list_runs` gives the session id and `get_run_log` its progress: the session is live once its log shows a "Durable wake subscription" on the page url. Report the page url from the log.

If the create fails because a source repository cannot be attached (the Claude GitHub app has no access to its org), say so and offer `/review-artifact-local` instead; do not work around it.
