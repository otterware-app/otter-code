# Otter Connect account setup

Otter Code signs in through Otter Accounts, the same identity used by Mail and Drive.
Production public client configuration lives in [.env.example](../../.env.example); source
builds use those defaults. No identity-provider secret belongs in a client build or the relay.

## Account service

Apply the Code client migration in `otterware-app/otter-accounts` before deploying the clients.
The issuer is `https://accounts.otterware.app/v1/auth`, and the OAuth resource is
`https://relay.code.otterware.app`. Accounts registers separate public clients for web,
desktop, mobile and CLI. Browser and installed-client authorization requires S256 PKCE.

The hosted callback is `https://code.otterware.app/account/callback`. Local and remote web
clients redirect through that callback and return to the originating server with a one-time PKCE code in the URL fragment.
Desktop uses the system browser with a temporary `127.0.0.1` listener. Mobile callbacks use
`ottercode://account/callback`, `ottercode-dev://account/callback` and
`ottercode-preview://account/callback`. SSH and headless hosts use the device approval page at
`https://accounts.otterware.app/otter/device`.

Accounts verifies the active grant, Code client and relay audience at `/code/session`. The
relay uses the canonical Otter user ID for environment and notification ownership. Tokens
from Mail's native session adapter or an unrelated OAuth client do not grant Code access.

Desktop credentials use Electron safeStorage; mobile uses the device Keychain/SecureStore.
A native client signs out by revoking its own grant. Browser Code sign-out also starts the
suite logout chain. Ending a browser session invalidates Code authorization grants sourced
from that session; independently approved headless servers remain connected.

Account deletion calls the relay's `/v1/identity/delete` with a short-lived signed Accounts
event. Code releases tunnels and removes cloud links, mobile registrations and personal
Linear links before Accounts deletes the identity. Local projects and conversations stay on
their machines. Shared Linear workspace installations remain available to other members.

## Existing installations

This migration does not transfer ownership by email or accept the previous provider's tokens.
Update clients, sign in to Otter Accounts, and reconnect each host. A host with an old cloud
link can clear it with `otter-code connect logout --base-dir ~/.otter-code`, then run
`otter-code connect`. The local database and environment key stay in place.

Keep the existing relay database, mint keys, tunnel credentials and Linear sealing keys when
deploying. Change domains through retained zone resources; never destroy the production stack.

Remote and local browser clients use the fixed hosted callback. Before returning a grant to a server outside the hosted Code origins, that callback shows its origin and asks for confirmation. Uploaded content on Drive cannot silently obtain a Code identity.
