# staging-dex Profile

Deployment profile for the MacBook staging host. The default identity issuer
is Dex running in the OpenCortex stack, with Tailscale serving HTTPS. The
bundled Dex config enables the OAuth device-code grant for the public
`opencortex-cli` client so Phase 7 CLI login can use the same issuer.
