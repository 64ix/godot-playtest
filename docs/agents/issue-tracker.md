# Issue tracker

- **Tracker**: this repository's GitHub Issues (`gh issue ...`).
- **Wayfinder**: the map carries the `wayfinder:map` label; child tickets use
  the appropriate wayfinder role label. One ticket represents one decision or
  investigation. Note blockers at the top of the body.
- **Specs and tickets**: a spec carries the `spec` label and acts as a
  container. Implementation tickets carry `ready-for-agent`, link to the spec,
  and record blockers with native relationships when available.
- **Session convention**: resolve at most one wayfinder ticket per session and
  put the detailed answer in a resolution comment.
- **Spec implementation**: the validation gate and conventions live in
  [implement-spec.md](implement-spec.md). Read it instead of reconstructing the
  gate from workflow files.

## Standing preferences

- Durable technical decisions live in `docs/adr/`, named
  `NNNN-kebab-case-title.md` and numbered sequentially.
- Use English for code, comments, documentation, and file names.
