# Kiro

T3 Code runs the [Kiro CLI](https://kiro.dev/docs/cli/) as an agent, using your own Kiro account,
custom agents, steering, hooks, and MCP configuration.

## Set Up Kiro

1. Install the Kiro CLI on the machine running the T3 Code server. On macOS or Linux, run
   `curl -fsSL https://cli.kiro.dev/install | bash`. On Windows 11, run
   `irm 'https://cli.kiro.dev/install.ps1' | iex` in PowerShell. Kiro's
   [installation guide](https://kiro.dev/docs/getting-started/installation/) lists other options.
2. Run `kiro-cli login` once in a terminal. Kiro Pro and higher plans can instead set an API key as
   `KIRO_API_KEY` in the Kiro provider's environment variables.
3. Open **Settings → Providers**, enable Kiro, and refresh it.

If `kiro-cli` is not on the server's `PATH`, set its **Binary path**. On macOS and Linux, the
installer usually puts it in `~/.local/bin`. T3 Code starts Kiro's CLI V3 engine, so a Kiro CLI
that cannot run V3 will not start.

## Models

The model picker lists the models your Kiro account can use once Kiro is signed in. New threads
start on your Kiro default model: `auto`, which lets Kiro choose, unless your account or
organization sets another. A model your account cannot use stops the turn with an error instead of
running on another model.

Models with adjustable reasoning effort, such as recent Claude Opus and Sonnet models and GPT-5.6,
show a **Reasoning** setting with only the levels Kiro offers for that model, including a concrete
Kiro default model. You can choose a level before your first message. With no level selected, Kiro
keeps its own setting. The `auto` model has no effort control.

## Agents

The **Agent** setting next to the model picks the
[Kiro agent](https://kiro.dev/docs/custom-agents/) a thread runs as: Kiro's built-in agents such as
Spec and Plan, and active agents in `~/.kiro/agents` and the project's `.kiro/agents`. Kiro's
workspace policy decides which agents are available. Refresh after changing configuration;
live session advertisements update that workspace's choices without affecting other projects.

The thread's model still applies when an agent sets its own `model`. An agent that was removed
leaves the thread on Kiro's current agent.

## MCP Servers

Kiro threads load the MCP servers in your Kiro configuration. Open **MCP servers** in a
conversation's Servers panel to refresh connection and authentication status. When the installed
CLI supports reconnect and a local browser can receive its callback, use **Sign in** there.
For remote connections or CLIs without that capability, sign in through `kiro-cli` on the
server (`/mcp`, then re-authenticate) and reconnect the conversation. Existing sign-ins are reused.

## Skills

Active skills from `~/.kiro/skills` and the project's `.kiro/skills` appear in the `/` and `$`
menus. Choices are scoped to that workspace and follow Kiro's policy. Kiro runs a skill only
when it starts the message, so put the skill first. Refresh workspace configuration after adding
or removing a skill; a live session also replaces its advertised skill list.

## Specs, Powers, and Memory

Choose a project under **Settings → Providers → Kiro → Kiro workspace**. Specs reads and edits
native artifacts in `.kiro/specs`, including task checkboxes. Powers lists active native powers
and installs a catalog name or an absolute directory on the server. Kiro controls managed powers;
user-local powers can be removed when permitted.

Memory searches and edits Kiro's native account memories and supports explicit sync. Its scopes
are Kiro account scopes, even when opened from a project. The provider's **Memory mode** setting
chooses Kiro default, off, recall only, or learn and recall for conversations.

## Native sessions and saved history

Select a project in the provider's Sessions section to import and continue a native CLI session.
Sessions already owned by T3 open their existing conversation. See the
[refinement guide](kiro-refinement.md#keep-conversations-across-updates) for a stable data directory
and access from multiple clients.

## Automatic titles

Kiro can generate thread titles when selected for titles or when no other configured title
provider is available. Each request chooses the lowest advertised credit multiplier among the
signed-in account's explicit models. It skips generation when prices are unavailable or the
environment requires mandatory tools. The title request has no tools, skills, hooks, or memory.
Generated titles consume Kiro credits; fixture tests do not.

## Workflows

Ask Kiro to run a native workflow. Its steps and their status appear in thread details and the
mobile Agents sheet, including parallel groups, repeated steps, and watches. Open a step to read
its conversation. The parent chat stays available while the workflow runs in the background.

**Workflow use** beside the model controls when Kiro chooses a workflow: **When asked**,
**Large tasks only**, or **Delegate all work**. The selection is saved with the thread and applies
when its Kiro agent offers that preference. Refresh Kiro in provider settings if it is missing
after upgrading the CLI.

Paused workflows remain waiting, with Kiro's reason shown. **Stop workflow** cancels that run
through Kiro without stopping another workflow or the parent chat. A server restart ends the
running provider process; the recorded workflow history remains available.

## Permission Modes

Kiro asks before tool calls such as writes and commands, and T3 Code answers by the permission mode:

- **Supervised** sends those requests to you. Kiro's Autopilot is off, so Kiro also asks you to
  review the turn's file changes before it finishes.
- **Full access** approves them without asking you. Autopilot stays on, so there is no review step.

Kiro offers no **Auto** or **Auto-accept edits**. Approvals offer only the choices Kiro sends. Kiro's
**Always allow** saves a rule for the whole workspace, so T3 Code shows it only when Kiro offers no
one-time choice.

## Steering, Forks and Compaction

- A message you send while Kiro is working joins the running turn. Kiro reads it once its current
  step or tool call finishes. A message with images stops the turn and starts a new one with it.
- Forking a thread from a message gives the fork Kiro's own copy of the conversation up to that
  message.
- `/compact` uses Kiro's own compaction. Kiro also compacts on its own as the conversation fills its
  context.
