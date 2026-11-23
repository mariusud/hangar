# Single sign-on

Devicepool signs people in through your identity provider with OpenID Connect (the authorization
code flow with PKCE). Any provider that speaks OIDC works: Google Workspace, Okta, Entra ID,
Keycloak, Authentik and others.

Register Devicepool with the provider as a web application with this redirect URI:

```
https://devicepool.example.com/v1/oidc/callback
```

Use the address Devicepool gives out (`--url`). Then start Devicepool with:

```bash
DEVICEPOOL_OIDC_ISSUER=https://accounts.example.com \
DEVICEPOOL_OIDC_CLIENT_ID=devicepool \
DEVICEPOOL_OIDC_CLIENT_SECRET=... \
devicepool up --url https://devicepool.example.com
```

The sign-in page gets a "Sign in with your company account" button. Someone who signs in for the
first time gets a member account named after their email. Invite links and passwords keep
working next to it; set `DEVICEPOOL_OIDC_ONLY=1` to turn passwords off once everyone has signed in
through the provider.

## Who can sign in

Without a restriction, every account the identity provider authenticates can sign in and becomes a
member. With a provider that serves many organizations, such as Google, that is anyone with an
account. Devicepool prints one warning at startup while neither setting below is set.

To admit only your own domain, list the email domains:

```bash
DEVICEPOOL_OIDC_DOMAINS=example.com,example.org
```

The ID token must carry an `email` at one of those domains and `email_verified` set to true.
Anyone else gets a message that says which domains are accepted. A group mapping (below) also
counts as a restriction for the startup warning, but it only sets teams and roles. It does not turn
people away, so use the domain list for that.

The browser that starts a sign-in must be the one that finishes it. Devicepool sets a short-lived
cookie at the start and checks it when the provider sends the person back. The sign-in start is
limited to 30 attempts per address in 10 minutes.

## Teams and roles from groups

If the provider puts a `groups` claim in the ID token, map groups to teams:

```bash
DEVICEPOOL_OIDC_GROUPS='{"mobile-qa":"QA","app-team":"App","platform":"operator"}'
```

A person's team and role follow their groups on every sign-in: the first mapped team that is not
`operator` is their team (created if it does not exist yet), and a group mapped to `operator`
makes them an operator. Without a mapping, people stay in the team and role an operator gives
them on the People page.

Devicepool only talks to the issuer you set. It checks the ID token's signature against the
provider's published keys, its issuer, audience, expiry and nonce.
