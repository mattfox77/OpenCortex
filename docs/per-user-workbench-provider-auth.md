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

## Sessions outlive the identity they launched under

Two behaviors together make identity and credential changes look like they had
no effect. Both were hit on 2026-08-20; neither is a bug, and both cost time to
work out from the outside.

**1. A session bakes its environment in at launch.** `opencodeRuntimeEnvironment()`
computes `HOME` and the XDG dirs from `request.user.linuxUser` when the session
starts, and those become the process environment. Nothing re-reads them. A
running session therefore keeps reading credentials from the home it was
launched with, however the mapping changes afterwards. Observed directly: a
12-day-old workbench process still running as `ada` — launched before
`OPENCORTEX_LINUX_USER_OVERRIDES` existed, and still alive after the `ada`
bootstrap account had been disabled in Dex — alongside a new process correctly
running as `mfox`.

**2. One workbench session per user, keyed on email.**
`reusableWorkspaceSession()` looks up `sessions.findByOwnerEmail(user.email)` and
returns the existing session when `isSessionRestorable()` passes, so
`POST /code/sessions` answers `200 existing: true` rather than launching. There
is no second-session concept, which is why no "new session" control exists to
find. The key is the email, which does not change when the Linux mapping does —
so a stale session stays matched to its owner and keeps being handed back.

The consequence: **changing an identity mapping or writing a credential only
affects newly launched sessions**, and a user with an existing session will never
get one until that session is deleted (`DELETE /code/sessions/:id`) so the next
POST has nothing to reuse. Order matters — authenticate first, then delete, then
reopen; a session launched before `auth.json` exists starts from the empty state.

### One session per user is the feature, not the bug

**Do not "fix" session reuse.** One long-lived session per user is what makes a
session a stable, shareable place: sessions are shared between users for review
and pair programming. The sharing surface is the session's chat channel, which
carries a `members` list with roles (`memberFromUser(owner, 'owner', ...)`), and
pair prompts are a first-class Temporal workflow with an approve/reject review
step (`pairPromptWorkflow`, `sendWorkbenchPairPromptWorkflow`,
`capturePairPromptResponseWorkflow`). A guest joins the owner's session; they do
not get a second one.

An earlier draft of this note suggested treating a session whose `linuxUser` no
longer matches the current mapping as non-restorable. **That is wrong** — it
would tear down a live session out from under collaborators mid-review, for a
condition (an identity remap) that has nothing to do with whether the session is
healthy. Recorded here because it looks reasonable until you know sharing exists.

The legitimate goal is narrower and does not conflict with sharing: **a session
should never launch into a dead state.** Make provider credential state a
launch precondition rather than something discovered after the workbench opens
empty — check at launch, and surface a "connect your provider" path instead of
starting a session that cannot do anything.

### Open question: whose subscription funds a shared session

A shared session runs as the **owner's** Linux user, in the owner's home, reading
the owner's `auth.json`. So a guest doing review or pair programming is spending
the owner's subscription, not their own — their own credential is not consulted
and could not be, since there is one process with one `HOME`.

That is in direct tension with "each user has their own subscription", and it is
unresolved. It does not have an obvious fix: per-guest credentials would mean
per-guest processes, which would mean guests are no longer in the *same* session,
which is the entire point of sharing. Worth deciding deliberately — the likely
answer is that this is acceptable and simply needs to be explicit (the owner
hosts, and pays for, the sessions they invite people into), but it should be a
decision rather than a surprise on someone's usage bill.
