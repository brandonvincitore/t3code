# Kiro refinement

This is Brandon's opt-in refinement branch of Kiro in T3 Code. It combines existing contributor work for
testing before upstream merges it. It is intended for a small pilot using test projects, with
your organization's approval for the Kiro account, tools, and repositories you use.

## Start a separate installation

Install [Vite+](https://github.com/pingdotgg/t3code#install-vp), which supplies the required Node
version, then build the refinement build on the machine where Kiro will run:

```bash
git clone --branch codex/kiro-refinement https://github.com/brandonvincitore/t3code.git t3code-kiro-refinement
cd t3code-kiro-refinement
vp i
vp run --filter t3 build
node apps/server/dist/bin.mjs serve --base-dir "$HOME/.t3-kiro-refinement"
```

Keep using that separate data directory for the pilot. Add test projects and connect through the
web app served by this installation. To return to your normal installation, stop this server and
open your normal app; its T3 data directory has not been replaced. A source installation updates
through this branch and a rebuild, rather than `t3 update`. Record `git rev-parse HEAD` when
reporting a problem so another tester can run the same version.

For another device, follow [remote access](remote-access.md) using this server's pairing flow.
Use its bundled web client for the first pass; separately installed desktop and mobile clients
may run a different client version.

## Keep conversations across updates

Stop this server before rebuilding, then launch it again with the same `--base-dir` path.
The directory holds T3 projects, conversation history, and provider-session links independently
of the source checkout. Keep it outside the checkout and back it up while the server is stopped.
Development mode uses a different, worktree-local directory unless explicitly configured; use
the built-server command above for the pilot. Run one server against a data directory at a time.

Other web, desktop, or mobile clients access those conversations by pairing with this same
server. Independent T3 servers have independent histories; connecting to another server does
not copy or synchronize them. Native Kiro sessions on the server can be imported through
Settings → Providers → Kiro → Sessions for a selected project. Imported conversations retain
their existing T3 owner when one exists.

New local Kiro conversations receive a meaningful existing T3 title before the first message
runs when the CLI advertises native renaming. Normal first-message title seeds are available
immediately; this does not wait for or call a title model. If no meaningful T3 title is available,
native naming is skipped. Provider-facing handoff or setup text is never used as a title. Existing native names and imported or resumed conversations are left alone. Later T3
title generation and manual renaming change the T3 name only, so the two names can differ.
Rename the native conversation in Kiro CLI when needed. An unsupported or failed native
rename does not prevent your message from running. A simultaneous CLI rename during initial
creation can still race with the initial name.

## Connect an organization's Kiro account

Install and sign in to Kiro CLI on the **server machine**, using your organization's existing
sign-in process. Enable Kiro in Settings → Providers. Your browser or phone does not need a copy
of the server's credentials. See [Kiro setup](providers-kiro.md) for models, agents, and permission
modes.

Open MCP servers in a Kiro conversation's Servers panel to refresh connection status. Browser
sign-in is available from a local T3 browser when Kiro supports reconnect and can complete its
server-local callback. Choose Sign in / reconnect, then open or copy the fresh sign-in link.
Kiro CLI 3.2.1 supports this even though it omits reconnect from its advertised methods; T3
attempts it only when you request sign-in. Unsupported connections stop and require a CLI update
and a new session. T3 stores MCP credentials separately from the native CLI, so signing in with
`kiro-cli` does not sign this T3 session in. Sign-in URLs are transient and belong to the initiating
client. For a remote connection, open this T3 server through localhost in a browser on the Kiro
machine and sign in there; remote callback forwarding is unsupported. Dismissal closes the local
flow without revoking access or cancelling Kiro's underlying connection attempt.

Administrators can use the existing [managed policy](managed-policy.md) to restrict providers,
permission modes, clients, and telemetry. The same server policy applies to connected clients.
Start with Supervised mode when checking approvals, including approval requests from workflow
steps. This branch does not add a separate organization account or administration service.

## What to try

- Run a [native Kiro workflow](providers-kiro.md#workflows), open its step conversations,
  continue chatting, and stop an individual workflow. This reuses Brandon's
  [workflow implementation](https://github.com/pingdotgg/t3code/discussions/32345).
- Select the project in Settings → Providers → Kiro. Inspect its active agents, skills,
  model choices and reasoning options, then refresh after changing native Kiro configuration.
  Available choices come from the signed-in account and workspace.
- Answer native Kiro questions in the question card, using a choice or your own text.
  Dismissing a question skips it; Stop ends the turn. After a server restart, an open
  question continues through a new message rather than the original live callback.
- Import an existing native CLI session and continue it. Check history recovery after
  reopening a conversation or using Edit from here.
- Open Specs to read and edit requirements, bugfix notes, designs, and tasks under `.kiro/specs`.
  Task checkboxes update the native tasks file. These panels do not emulate native spec execution.
- Open Powers to refresh installed powers or install a catalog name or a server-local directory.
  Removal is available for user-local powers when Kiro permits it.
- Open Memory to inspect, search, edit, delete, or explicitly synchronize native memories.
  Memory scopes are Kiro account scopes, not a separate T3 project database. Provider settings
  control whether conversations use Kiro's default, disabled, recall-only, or learning mode.
- Inspect Kiro credits in Usage. Credits are separate from token counts and USD; token and
  dollar charts cannot describe credit-only usage.

## Current verification limits

Automated fixture checks and a production build have passed. Release validation and an
organization-account pilot are still pending. Use test projects until the interactive web,
desktop, mobile, and remote/relay/tunnel pilot is complete. No paid Kiro turns are required for
the automated fixture tests.

A server restart ends its running provider process. Saved T3 conversation history remains in
its data directory, but automatic reattachment to workflows surviving outside that process is
not provided. Browser OAuth requires reconnect support in the installed Kiro CLI and a browser
on the Kiro machine. Native CLI MCP credentials are not imported into T3.

Share refinement problems with the person coordinating your pilot, including the commit, operating
system, Kiro CLI version, connection mode, and minimal steps.
Say whether the problem also happens on upstream T3 Code or in Kiro CLI alone when you can check.
Remove credentials, sign-in links, private prompts, and repository contents from shared evidence.
