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
