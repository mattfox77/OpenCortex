# external-oidc Profile

Deployment profile for clients that bring their own OIDC issuer directly.
OpenCortex sees only standards-based OIDC discovery, JWKS validation, and
claims.

## Google OIDC

Use a Google Cloud OAuth client with application type **Web application**.
For the Tailnet local deployment, configure:

- Authorized JavaScript origin: `https://linux-macbook.tail5861c6.ts.net`
- Authorized redirect URI:
  `https://linux-macbook.tail5861c6.ts.net/auth/callback`
- Issuer: `https://accounts.google.com`

Google OAuth web clients require HTTPS redirect URIs and do not accept raw IP
hosts, except localhost loopback URIs. The Tailnet and LAN IP URLs can be used
for health checks, but browser sign-in should use the HTTPS Tailnet hostname.

Start from [google.env.example](google.env.example) and store the populated
values in the deployment host's local runtime environment file rather than in
the repo.
