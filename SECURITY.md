# Security

The threat model in one paragraph: the grok plugin executes the local Grok CLI with your credentials. Consult mode combines an OS level workspace sandbox with explicit tool denies, but write mode and best-of-n auto approve everything outside a short deny list, so treat them as giving Grok your own shell inside the workspace and run them on a clean branch or a disposable worktree. Job briefs and logs are stored in plain text under `~/.claude/plugins/data/grok-claude-code-fusion/`. The routing policy, panel blindness, and circuit breaker are prompt level conventions, not runtime enforcement; see the Safety model section of the README for the full split between what code enforces and what prompts request.

Report vulnerabilities to hi@okis.dev or through a GitHub security advisory on this repository. Please do not open public issues for exploitable problems before contact.
