# Configurable approval review verification

This PR is independently based on upstream 0.1.109 (`c5b5343c`). It adds isolated
review for app-owned Auto gates and Claude when its native reviewer explicitly
reports inactive. A native active or unknown reviewer remains authoritative.

Run the unit and isolated HTTP checks:

```sh
node_modules/.bin/vitest run server/approval-review.test.ts server/approval-review.e2e.test.ts server/drivers/openai-chat.test.ts server/drivers/meta.test.ts server/drivers/claude.test.ts server/drivers/claude-accounts.test.ts src/components/ApprovalReviewSettings.test.ts
node_modules/.bin/tsc -b
node_modules/.bin/tsc -p tsconfig.server.json
```

The HTTP test launches a disposable fake-engine server and loopback model/MCP
services. Its tools only write fixed artifacts inside the fixture. It checks
allow, deny, Ask fallback, exact model routing, persisted settings, reasoning
`none`, and stale-review refusal. Working-agent effort remains unchanged.

The separate settings smoke mounts the real settings component in a disposable
Electron profile. These checks establish synthetic behavior only; they make no
live model, Splash, mailbox, or user-workspace calls.

Reviewer reasoning defaults to None whether the configured reviewer omits effort
or follows the session model. An explicit configured effort overrides that
review default. The stable rubric and authorization evidence precede each exact
action, and oversized or incomplete evidence falls back to a human card.
