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

### CORRECTION (2026-08-21): opencode does not support Anthropic subscription auth

An earlier version of this note claimed it did, on the strength of these i18n
strings in the 1.3.17 binary:

    dialog.provider.anthropic.note          "Connect with Claude Pro/Max or API key"
    provider.connect.title.anthropicProMax  "Sign in with Claude Pro/Max"

**Those are stale translation entries for a flow that is not implemented.** The
strings exist; the OAuth machinery behind them does not. Grepping the binary for
each provider's actual endpoints settles it:

| | OpenAI | Anthropic |
|---|---|---|
| OAuth host | `auth.openai.com` | none |
| OAuth client id | `app_EMoamEEZ73f0CkXaXp7hrann` | none |
| Subscription endpoint | `chatgpt.com/backend-api/codex/responses` | none |
| API endpoint | — | `api.anthropic.com/v1` only |

ChatGPT Pro/Plus is fully wired. Anthropic has the plain API-key path and nothing
else. Also ruled out: both `claude`-adjacent binaries on the host are the same
1.3.17 build, models.dev provider metadata carries no OAuth fields (only `env`
and `npm`), and there is no plugin cache or lazily-loaded OAuth module.

The likely reason is not an oversight. Anthropic restricts subscription OAuth to
its own first-party clients, so a third-party client offering "Sign in with
Claude Pro/Max" would have to impersonate one. **Claude Code is the sanctioned
path**, which is why the multi-provider workbench design
(`docs/workbench-providers.md`) reaches subscription auth by driving the `claude`
CLI rather than by teaching opencode to log in.

The methodological lesson, since it cost a day: **UI strings are not evidence of
a feature.** The tell was present in the very first search — zero hits for the
Claude OAuth client id and `claude.ai/oauth`, against 18 hits for
`anthropicProMax`. Labels without endpoints meant labels without a flow, and that
mismatch was the answer rather than a curiosity.

Practical consequence: for opencode specifically, an Anthropic API key is the
only option, and it is usage-billed rather than subscription-backed. Users
wanting to spend their Claude subscription need the Claude Code workbench
provider instead.

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

### Decided: owners host and pay; guests advise, never prompt

Settled 2026-08-20. Three rules, and the third is what makes the other two work:

1. **A session belongs to its owner, including when others are invited into it.**
   Inviting someone does not make the session joint property.
2. **The owner hosts and pays for the sessions they invite people into.**
3. **Invited users advise; they do not prompt. Nobody consumes anyone else's
   subscription — in either direction.**

Rule 3 is the constraint that resolves what earlier drafts of this note called an
unresolved tension. A shared session runs as the owner's Linux user reading the
owner's `auth.json`, so *any* model work a guest triggers necessarily spends the
owner's subscription — there is one process with one `HOME` and no way to bill it
elsewhere. Rather than trying to attribute spend per participant, guests simply
do not drive the model. They review, comment, and advise; if the owner acts on
that advice, the owner prompts, on their own subscription, by their own choice.

**This has a direct consequence for the existing pair-prompt feature, and it is
not yet reconciled.** `pairPromptWorkflow` /
`sendWorkbenchPairPromptWorkflow` / `capturePairPromptResponseWorkflow` implement
a guest-drafts-a-prompt, owner-approves-or-rejects flow, and an approved draft
executes inside the owner's session on the owner's subscription. Whether that
satisfies rule 3 turns on a question nobody has answered yet: does owner approval
make the resulting spend the *owner's* action (allowed — the owner consented to
each one), or is a guest composing prompts still "prompting" regardless of who
clicks approve (not allowed — guests should be limited to advisory comments that
the owner may retype or ignore)?

Both readings are defensible and they imply different products. Decide this
before building the credential-precondition work above, because it determines
whether the pair-prompt path needs constraining, reframing as advisory-only, or
leaving exactly as it is.
