# Issue tracker: GitHub

Issues and specs live in https://github.com/tiagoguerreirodev/learnharness/issues.

Use `gh` for tracker operations. Every issue or label command must include
`--repo tiagoguerreirodev/learnharness`. Scope API paths to
`repos/tiagoguerreirodev/learnharness/`.

Before the first tracker write in a session, verify the target:
`gh repo view tiagoguerreirodev/learnharness --json nameWithOwner,viewerPermission`.

Reference related work in `amosblomqvist/learnharness` using full URLs.
Publishing or changing anything upstream requires separate user approval.

## Operations

The commands below also require the explicit repository argument above.

- Publish a spec or ticket: `gh issue create`; supply a title and use
  `--body-file -` with a heredoc for multiline content.
- Fetch a ticket: `gh issue view NUMBER --json number,title,body,labels,comments`.
- List tickets: `gh issue list`, with appropriate state and label filters.
- Comment: `gh issue comment NUMBER --body-file -`.
- Apply/remove labels: `gh issue edit NUMBER --add-label NAME`
  or `--remove-label NAME`. Use `triage-labels.md` for triage roles.
- Close: post an explanatory comment, then `gh issue close NUMBER`.
- Sub-issues: use `gh issue create --parent NUMBER` or
  `gh issue edit PARENT --add-sub-issue CHILD`.
- Dependencies: use `gh issue edit CHILD --add-blocked-by BLOCKER`.
  A ticket is unblocked when all blockers are closed.

If native relationships are unavailable, record `Part of #NUMBER` and
`Blocked by: #NUMBER` in ticket bodies and maintain the parent's task list.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Wayfinding

- Map: one issue labelled `wayfinder:map`, containing Notes,
  Decisions-so-far, and Fog.
- Children: sub-issues labelled `wayfinder:research`, `wayfinder:prototype`,
  `wayfinder:grilling`, or `wayfinder:task`.
- Frontier: open, unblocked, unassigned children, selected in map order.
- Claim: assign yourself before starting work.
- Resolve: comment with the answer, close the child, and update the map
  with a concise decision and link.
