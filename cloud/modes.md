<!-- build -->
Build a new review page: follow sections 1 and 2 of the workflow (build, publish, seed Claude's review). Publish with the capabilities section 1 lists; for the GitHub server name use the connector this session has (load `pull_request_review_write` with ToolSearch and take the server part of its tool name), and confirm it against what the publish result names. Import any existing pending GitHub review comments as section 2 says. Your first message after the watch names the page url.
<!-- adopt -->
Adopt the existing review page {{ADOPT_URL}}; do not build a new one.
- Read it with the `Artifact` tool (`action: "read"`), and list its `comments` and `threads` collections with `ArtifactData` to learn its state. Do not republish it, and do not reset, reseed or rewrite its database: its documents stay as they are unless a page request asks for a change.
- Build `$S/diff.json`, `$S/gh.json` and `$S/ghsync.json` (workflow steps 1 to 3 and the ghsync config) so later requests can be answered, but do not run steps 5 to 7 and do not seed.
- Make no GitHub writes during this setup.
- Republish only if a page request needs new page code. Then write `$S/meta.json` with exactly these values, build from `$R/template.html` as in step 5, and publish to the same url without `capabilities` (they carry forward): {{ADOPT_META}}
