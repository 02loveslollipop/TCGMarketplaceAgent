# TCG Manager integration

The Marketplace Agent provides the login and administration portal for the combined Pokémon TCG workspace. The integration is available on the [shared-auth branch](https://github.com/02loveslollipop/TCGMarketplaceAgent/tree/codex/tcg-manager-shared-auth). The default branch runs the standalone Marketplace Agent.

## Shared sign-in

TCG Manager web, desktop and mobile clients use an OAuth authorization code with S256 PKCE. The portal verifies the account and either an authenticator code or a registered security key. The collection client exchanges the one-time code for a token scoped to TCG Manager.

On the shared-auth branch, configure `TCG_OAUTH_PORTAL_URL` with the public portal origin. Set `TCG_OAUTH_CLIENTS` to a JSON mapping of client IDs and exact callback URLs. Add the collection web origin to the auth service's CORS allowlist. Set `TCG_OAUTH_DATABASE_URL` to a scoped PostgreSQL grant-store login after applying the collection service's migrations. Keep the identity and collection schemas under separate database permissions.

## Shared administration

Set `TCG_MANAGER_URL` on the Marketplace admin API and `VITE_TCG_MANAGER_WEB_URL` when building the admin frontend. The admin portal checks access before showing collection operations. The underlying collection service authorizes the configured owner and handles its own inventory writes.

## Development

Use this repository's [local setup](../README.md#commands-and-instructions-to-run-and-test-locally) for standalone Marketplace Agent development. For changes that span the auth portal and the collection clients, use the combined repository's `marketplace/` source and its shared OAuth integration tests. Those tests expect a separate, migrated PostgreSQL fixture database and synthetic accounts.
