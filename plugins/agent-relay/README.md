# Agent Relay bridge and Relay Room plugin

This optional Herdr plugin runs a Node 22+ sidecar in an explicitly opened tab.
It includes two independently opened terminal panes:

- **Agent Relay bridge** forwards agent status changes for configured workspaces
  to one Agent Relay channel and exposes a read-only `herdr.session_summary`
  Relay action.
- **Relay Room** is a local control client for Relay channel history, messages,
  threads, reactions, presence, room membership, and Relayfile integrations.

The bridge never reads pane output, cwd, environment, or terminal titles. It
does not expose prompt, key-send, shell, or raw-socket controls.
It discovers pane membership from periodic session snapshots rather than
replaying Herdr's retained lifecycle-event history.

## Setup

Install dependencies when authoring a linked checkout:

```bash
npm ci --omit=dev
herdr plugin link /path/to/agent-relay
```

Herdr runs the same `npm ci --omit=dev` command automatically for GitHub
installs. The plugin requires Node 22 or newer.

Install the plugin from this public fork with:

```bash
herdr plugin install AgentWorkforce/herdr/plugins/agent-relay
```

Copy `config.example.json` to the directory reported by:

```bash
herdr plugin config-dir agent-relay.herdr-bridge
```

For the status bridge, name the copied file `agent-relay.json`, replace `workspaceKey`, and list only
the Herdr workspace IDs that may be forwarded. The configured Relay channel
must already exist; the bridge joins it before forwarding any status. Keep the
workspace key private:

```bash
chmod 600 "$(herdr plugin config-dir agent-relay.herdr-bridge)/agent-relay.json"
```

Custom Relay endpoints must use HTTPS, except for loopback addresses used in
local development. Then open the sidecar:

```bash
herdr plugin pane open --plugin agent-relay.herdr-bridge --entrypoint bridge
```

Closing that pane stops the bridge. It does not run from a startup hook.

## Relay Room setup

Relay Room has its own configuration and does not read the bridge's Relay
workspace key. Copy `room.config.example.json` to the plugin configuration
directory as `relay-room.json`, then replace the public workspace binding:

```bash
cp /path/to/agent-relay/room.config.example.json \
  "$(herdr plugin config-dir agent-relay.herdr-bridge)/relay-room.json"
chmod 600 "$(herdr plugin config-dir agent-relay.herdr-bridge)/relay-room.json"
herdr plugin pane open --plugin agent-relay.herdr-bridge --entrypoint room --placement tab
```

`workspaceId` and optional `relayfileWorkspace` accept only a public `rw_…` ID
or Cloud workspace UUID, never an `rk_live_...` workspace key. The first Room
start persists that one binding in private plugin state and refuses an
accidental switch to another Room.

Production leaves `apiUrl` out and uses the CLI's default Cloud endpoint. For a
local or self-hosted proof, set a credential-free HTTPS endpoint (or loopback
HTTP) as `apiUrl`; Relay Room forwards it as `--api-url` to `agent-relay`
commands only. It never forwards an API URL to Relayfile.

The installed Agent Relay CLI must support the participant-only Cloud Room
command family:

```text
agent-relay cloud room invite --workspace <public-id> --email <email> --json
agent-relay cloud room invites|members --workspace <public-id> --json
agent-relay cloud room revoke-invite|remove-member <id> --workspace <public-id> --json
agent-relay cloud room session --workspace <public-id> --device-id <device-id> --json
agent-relay cloud room revoke-session --workspace <public-id> --device-id <device-id> --json
agent-relay cloud room accept --token-stdin --json
```

Every invited person is a trusted full room participant in v1. Cloud
returns an ordinary Relaycast human agent token for the device. Relay Room
constructs `AgentRelay` from `@agent-relay/sdk` with that token and calls the SDK
directly for chat, threads, reactions, and presence. It does not shell out for
chat and does not need any Relaycast or Relaycast Cloud change.

The participant credential lives only in memory. The non-secret device ID is
saved so reopening the Room renews the session. Replacing or resetting the
device first revokes the prior credential; a failed revocation remains as
non-secret cleanup state and blocks renewal.

## Room controls

Type `help` in the Room pane. Start an explicit device session before using
chat. Participants may take all ordinary agent-level collaboration actions;
owner-key administration remains owner-only. There is no viewer/read-only role
in v1.

```text
room new-session <device-id>
room reset-session
history #channel
thread <message-id>
presence

message send #channel "text"
thread reply <message-id> "text"
reaction add|remove <message-id> <emoji>
room invite <email>
room invites|members
room revoke-invite|remove-member|accept <value>

integration available [query] [--backend nango|composio] [--refresh]
integration search <query> [--backend nango|composio] [--refresh]
integration login
integration connect|disconnect <provider> [--backend nango|composio]
integration list
integration setup <provider> [--backend nango|composio]
integration mount
integration stop
integration status
integration writeback-status
integration writeback-retry <operation-id>
guide
```

`room invite` displays a one-time email-bound participant token for secure
sharing. The invitee accepts it through stdin at the CLI boundary; the token is
never placed in child-process argv.

Integrations use Relayfile's existing Cloud login, live catalog, OAuth/backend
selection, mounts, and durable writeback queue. There are no room-specific
grants, credential leases, provider manifests, or integration proxy endpoints.
`integration setup <provider>` is the one-command path: it refreshes Relayfile
from the current Agent Relay Cloud login, connects the provider, and starts the
workspace mount. The explicit commands expose each stage for diagnosis.

The only mount target is the canonical
`WorkspaceWorktreeInfo.checkout_path/.integrations`; the command takes no path.
Herdr pane cwd is never an authority. The plugin rejects missing or stale
worktrees, symlinked Git metadata, symlink replacement races, and non-empty
source directories it does not already own. Relayfile is always launched with
`--background`. A mount that was still marked active after a crash is stopped
before the Room proceeds. `guide` explains adapter/schema discovery, writeback
verification, and the reserved `.relay/` rule.

## State and safety

The Relay agent token and status-transition dedupe state are stored only in
`HERDR_PLUGIN_STATE_DIR`. The state file is mode 0600 on POSIX; on Windows it
inherits the account-scoped ACL of Herdr's plugin state directory. Subsequent
starts reconnect with that token rather than registering another Relay agent.
An exclusive state-directory lock prevents two bridge panes from racing to
rotate that token. A later start removes the lock automatically when its owner
PID is no longer running; live or unidentifiable lock owners still fail closed.
The configuration file belongs in `HERDR_PLUGIN_CONFIG_DIR`; do not commit a
real workspace key.

Relay Room has its own exclusive process lock. Its private state stores only
the public workspace binding, the non-secret Room device ID, the ownership and
active status of the dedicated `.integrations` mount, and cleanup-needed state
when a device credential could not be revoked. It stores no Relay agent token,
Cloud token, session credential, provider credential, OAuth callback, or mount
secret. Cloud and Relayfile control commands use the user's existing
account-scoped configuration. Ambient Relay workspace and agent credentials are
not forwarded to Relayfile. All child commands have bounded runtime and output;
bounded stderr details are redacted before display.
