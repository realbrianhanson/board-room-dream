Deploy all existing edge functions in the `supabase/functions/` directory to refresh them in the backend without modifying source code.

Functions to redeploy:
- `alert-scan`
- `audit-runner`
- `boardroom-orchestrator`
- `github-oauth`
- `github-sync`
- `instructor-digest`
- `key-vault`
- `validate-intake`

No code changes will be made. After deployment, I will confirm the deploy succeeded and report the result.

### Technical details
- Tool: `supabase--deploy_edge_functions`
- Scope: all named functions in `supabase/functions/`
- Risk: low; redeploy only refreshes the deployed artifacts, no schema or source edits