# Kiro preview

This is Brandon's opt-in preview of Kiro in T3 Code. It combines existing contributor work for
testing before upstream merges it. It is intended for a small pilot using test projects, with
your organization's approval for the Kiro account, tools, and repositories you use.

## Start a separate installation

Install [Vite+](https://github.com/pingdotgg/t3code#install-vp), which supplies the required Node
version, then build the preview on the machine where Kiro will run:

```bash
git clone --branch codex/kiro-preview https://github.com/brandonvincitore/t3code.git t3code-kiro-preview
cd t3code-kiro-preview
vp i
vp run --filter t3 build
node apps/server/dist/bin.mjs serve --base-dir "$HOME/.t3-kiro-preview"
```

Keep using that separate data directory for the pilot. Add test projects and connect through the
web app served by this installation. To return to your normal installation, stop this server and
open your normal app; its T3 data directory has not been replaced. A source installation updates
through this branch and a rebuild, rather than `t3 update`. Record `git rev-parse HEAD` when
reporting a problem so another tester can run the same version.

For another device, follow [remote access](remote-access.md) using this server's pairing flow.
Use its bundled web client for the first pass; separately installed desktop and mobile clients
may run a different client version.

## Connect an organization's Kiro account

Install and sign in to Kiro CLI on the **server machine**, using your organization's existing
sign-in process. Enable Kiro in Settings → Providers. Your browser or phone does not need a copy
of the server's credentials. See [Kiro setup](providers-kiro.md) for models, agents, and permission
modes.

For an OAuth MCP server, complete its sign-in in `kiro-cli` first. This preview reuses the stored
sign-in; starting a new MCP browser sign-in inside T3 is not supported. T3 and Kiro CLI share
Kiro's secrets file, so avoid changing the same MCP sign-in concurrently in both applications.
If an MCP server needs authentication again, re-authenticate in the CLI and start a new Kiro
session.

Administrators can use the existing [managed policy](managed-policy.md) to restrict providers,
permission modes, clients, and telemetry. The same server policy applies to connected clients.
Start with Supervised mode when checking approvals, including approval requests from workflow
steps. This preview does not add a separate organization account or administration service.

## What to try

- Run a [native Kiro workflow](providers-kiro.md#workflows), open its step conversations, continue
  chatting while it works, and stop an individual workflow. Your Workflow use preference stays
  with the thread. This uses Brandon's [existing workflow implementation](https://github.com/pingdotgg/t3code/discussions/32345).
- Use a previously authenticated OAuth MCP server, including after session recovery
  ([credential reuse](https://github.com/pingdotgg/t3code/pull/31019)).
- Reopen a settled conversation and use Edit from here. Check that retained conversation remains
  available and instructions are not repeatedly injected
  ([history recovery](https://github.com/pingdotgg/t3code/pull/30188),
  [instruction recovery](https://github.com/pingdotgg/t3code/pull/24740)).
- Select a global Kiro skill from `/` or `$` after a session starts, select Haiku 5.5 reasoning
  effort, and inspect context usage through a resume and model switch
  ([skills](https://github.com/pingdotgg/t3code/pull/31700),
  [reasoning](https://github.com/pingdotgg/t3code/pull/30935),
  [context usage](https://github.com/pingdotgg/t3code/pull/30566)).

## Known limits

Project-local agents and skills are not listed. Global skills appear after a Kiro session reports
them; removed skills can remain listed until the server restarts. Additional models' reasoning
levels are not dynamically discovered. Context reporting does not calculate Kiro credits, and
saved readings cannot distinguish models with equal context windows after a restart.

A server restart ends its running provider process. Workflow history remains recorded; automatic
reattachment to a workflow surviving outside that process is not provided. The combined preview's
web, native desktop/mobile, and remote/relay flows still need interactive pilot verification.

Share preview problems with the person coordinating your pilot, including the commit, operating
system, Kiro CLI version, connection mode, and minimal steps.
Say whether the problem also happens on upstream T3 Code or in Kiro CLI alone when you can check.
Remove credentials, sign-in links, private prompts, and repository contents from shared evidence.
