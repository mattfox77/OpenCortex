# Per-user workbench provider subscriptions

**Status:** not started. Captures findings from 2026-08-20 so the investigation
does not have to be repeated.

**Decision: each user authenticates their own provider subscription.** We are not
routing workbench model traffic through one shared OpenCortex-side account.

## What already works

Nothing in this repository restricts workbench provider auth. `packages/workbench`
sets `HOME` and the XDG dirs and points `OPENCODE_CONFIG` at the user's config;
there is no provider list, no key handling, and no auth code anywhere in the tree.
Provider credentials belong entirely to opencode, which stores them in
`$XDG_DATA_HOME/opencode/auth.json` — i.e. `/home/<linuxUser>/.local/share/opencode/auth.json`
given the environment `opencodeRuntimeEnvironment()` builds.

opencode 1.3.17 already supports Anthropic subscription auth, symmetrically with
the OpenAI equivalent people compare it to:

    dialog.provider.anthropic.note          "Connect with Claude Pro/Max or API key"
    dialog.provider.openai.note             "Connect with ChatGPT Pro/Plus or API key"
    provider.connect.title.anthropicProMax  "Sign in with Claude Pro/Max"

So "the workbench only offers an API key" is not a missing capability. A user with
no `auth.json` is simply unauthenticated, and the Pro/Max flow is an OAuth
browser round-trip that wants a real terminal rather than the embedded web
workbench. Running `opencode auth login` once as the workbench's Linux user and
choosing Anthropic → Claude Pro/Max writes the file, and the workbench picks it
up with no service restart and no code change.

## The actual gap

That credential is per Linux user, and **provisioning never seeds one**.
`packages/runtime/src/system/provisioning.ts` creates
`/home/<user>/.local/share/opencode` and leaves it empty, so every newly
provisioned user reaches a workbench with zero credentials and no in-product path
to fix it — the one flow that works is a CLI command on a host they may not have
shell access to.

Note this is invisible to the first user on a fresh install, who is usually the
operator, already has shell access, and may already have logged in as themselves.
It only shows up with the second user.

## What to build

An onboarding path that gets a user through their own provider OAuth without
requiring host shell access. Sketch, not a design:

1. Detect the empty-credential state per user (`auth.json` absent or has no entry
   for the configured default provider) and surface it in the UI rather than
   letting the workbench open in a dead state.
2. Drive `opencode auth login` for that user's Linux account from the runtime,
   brokering the OAuth redirect back through the OpenCortex origin — the flow
   needs a browser round-trip, which is why it does not work in the embedded
   workbench today.
3. Keep the credential per user at its existing path. Do not centralize it: the
   subscription belongs to the person, and a shared credential would also pool
   everyone's rate limits.

Worth confirming before building step 2: whether the web workbench hides the
OAuth method because of a missing browser/callback, or for some other reason.
That was not established — the CLI path was verified to work and the web path
was not investigated further.

## Related

`OPENCORTEX_LINUX_USER_OVERRIDES` maps a federated identity onto an existing
Linux account. It is why the operator's own workbench finds a credential at all:
`matt.fox@techsupportcomputerservices.com` resolves to `mfox` rather than
provisioning a fresh `matt-fox` with an empty home.
