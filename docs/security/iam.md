# IAM roles and managed agent API tokens

Human accounts and API principals each have one IAM role. A role has an optional parent and an inline policy. Policies are reused through inheritance, with no separate reusable-policy resource.

## Authorization and quotas

- Access defaults to Deny. An Allow in any ancestor or the assigned role grants matching operations; a matching explicit Deny anywhere in the chain overrides every Allow.
- Only `*` wildcards are supported. Actions are validated against `/iam/catalog`; resource patterns are case-sensitive. Unknown actions and invalid policies fail closed.
- A role inherits the nearest ancestor’s daily quota unless it sets its own value. Zero blocks model calls. A root without a quota has zero allowance.
- Quotas count provider-reported input + output tokens per identity, reset at midnight Asia/Tokyo, and allow an admitted response to finish. Unverified provider usage blocks further calls until reset.
- Each human account and API principal has its own usage counter. All tokens for a principal share that counter, conversation ownership and executions. Rotating credentials does not reset usage.
- Globally disabled models remain unavailable, regardless of IAM grants. Model invocation requires `agent:models:invoke` on `model:<registry ID>`.
- API tokens have an additional agent-only ceiling: even an Administrator policy cannot grant account, authentication, security or administration operations to API credentials. `/session` only introspects them; tokens cannot be exchanged for a human JWT or portal cookie.
- Ownership is enforced separately: a grant on `*` never gives an API principal access to another principal’s chats or executions.
- Role assignments invalidate existing human sessions. Policy edits and API principal changes apply to subsequent requests; credentials and model permissions are checked again before each model call. Work already admitted may finish.
- Cycles and deletion of assigned/parent roles are rejected. Built-in roles cannot be deleted. At least one active human must retain IAM role-management access.

Example agent-testing policy (replace the registry ID if needed):

```json
{
  "statements": [
    {
      "effect": "Allow",
      "actions": [
        "agent:models:list", "agent:usage:read",
        "agent:conversations:read", "agent:conversations:write",
        "agent:executions:create", "agent:executions:read", "agent:executions:resume",
        "agent:preferences:read", "agent:preferences:write"
      ],
      "resources": ["*"]
    },
    {
      "effect": "Allow",
      "actions": ["agent:models:invoke"],
      "resources": ["model:gpt-6-luna"]
    }
  ]
}
```

Start with an explicit 50,000-token daily testing quota; adjust for the model and workflow under test. IAM and quotas do not guarantee protection against prompt injection. Retrieved content remains untrusted, tool boundaries still apply, and purchase actions still require the normal agent decisions.

## Admin portal flow

1. Open **IAM roles and policies**. Create a role, optionally choose a parent, and configure local Allow/Deny statements and a quota override. Inherited policies and effective quotas are visible in the editor.
2. Assign roles to people through **Accounts → Change role**. The legacy User and Administrator presets remain available.
3. Open **API principals**, create a named identity and assign its role. Disabling the identity blocks all its credentials. Re-enabling restores unexpired, unrevoked credentials.
4. Open the principal’s details and select **Create API token**. The default lifetime is 30 days, configurable from 1 to 365 days.
5. Copy the credential from its one-time modal into a private token file or a local environment variable. Only the hash is stored; subsequent lists show metadata. Use **Revoke** to invalidate a credential. Create a replacement before revoking an old token when uninterrupted automation is needed.

The UI hides operations the session cannot perform, and every API independently authorizes requests. Administration pages generally require the relevant read permission; creating/assigning a principal additionally requires role-catalog read and role-assignment permission in the UI.

## Programmatic testing

Send `Authorization: Bearer <API_TOKEN>` over HTTPS to the chat API. Never put credentials in query parameters, source control, prompts or execution logs.

```bash
# Save the token privately first, outside source control.
chmod 600 /path/to/private-token
.venv/bin/python scripts/agent_cli.py \
  --base-url https://api.chat.tcg-marketplace.02labs.me \
  --token-file /path/to/private-token \
  --prompt 'Price one English Pikachu from a specified set' \
  --model gpt-6-luna --jsonl
```

`TCG_API_TOKEN` is also supported. API credentials are never passed through the CLI’s JWT refresh flow. JSONL writes events to stdout and human status to stderr, retaining execution IDs and processing the full SSE turn before resuming. The CLI pauses for deck approval unless `--approve-deck` explicitly authorizes automatic approval. Use `--auto-clarify` only when the chosen clarification is appropriate for the test.

## HTTP resources

The admin API proxies these paths under `/iam`, forwarding the human bearer session. The auth service validates and enforces every mutation.

| Resource | Methods | Permission |
| --- | --- | --- |
| `/iam/catalog`, `/iam/roles` | GET | `iam:roles:read` |
| `/iam/roles` | POST | `iam:roles:write` |
| `/iam/roles/{id}` | PUT, DELETE | `iam:roles:write` on `role:{id}` |
| `/iam/accounts/{id}/role` | PUT | `admin:accounts:write` on `account:{id}` and `iam:roles:assign` on the destination role |
| `/iam/principals` | GET, POST | `iam:principals:read` / `iam:principals:write` |
| `/iam/principals/{id}` | PUT | `iam:principals:write` on `principal:{id}`; assignment permission when changing role |
| `/iam/principals/{id}/tokens` | GET, POST | `iam:tokens:read` / `iam:tokens:write` on `principal:{id}` |
| `/iam/principals/{id}/tokens/{key_id}` | DELETE | `iam:tokens:write` on `principal:{id}` |

Collection reads and creates require `*` for their resource. Concrete writes accept the resource patterns shown above. Execution and conversation routes accept `execution:<id>` and `conversation:<id>` where an ID exists; ownership remains mandatory. Agent model invocation uses `model:<id>`. Other agent list/usage/preferences actions use `*`.

Credentials use a random UUID reference and a 256-bit random secret, with SHA-256 of the complete high-entropy credential stored for constant-time verification. Auth alone can read or mutate credential hashes. Admin and orchestration DB roles can only read IAM roles. Audit events contain identity/key references, never secrets. Creation responses use `Cache-Control: no-store`; credential usage timestamps are throttled to one write per minute.

## Additive database migration and rollout

For an existing deployment, use the narrow migration rather than full provisioning:

```bash
.venv/bin/python -m scripts.provision --migrate-iam
```

It operates only in `pokemon_tcg_poc`, creates the three IAM tables, adds `users.iam_role_id`, copies the existing User/Administrator model restrictions and quotas into built-in IAM policies, binds accounts with no IAM role, and grants exact runtime permissions. It does not reset accounts, passwords, MFA, JWT keys, usage, chats or service credentials. It is idempotent and does not overwrite edited IAM roles on repeat runs. The old role policies remain for compatibility, but the legacy edit API rejects changes once IAM is seeded.

Validate the migration against a disposable PostgreSQL database first. Deploy the compatible frontend before the new backend: it understands both legacy sessions and IAM session metadata. Run the migration before starting the new backend. The old backend can continue using the preserved legacy role fields and policy tables during this transition. After IAM changes are made, rolling back to the old backend would stop enforcing those changes; treat rollback as a coordinated maintenance operation, not a way to remove the migration.

The Heroku workflow deploys MCP, chat and admin before auth, checking each service before continuing. New consumers accept the legacy session metadata while auth is upgraded last. This prevents older consumers receiving UUID-based IAM roles before they understand them. Record the previous Heroku release versions and Pages production deployment IDs before starting. Keep the additive schema on rollback; avoid changing IAM policies during a partial rollout.
