# Agent Relay bridge plugin

This optional Herdr plugin runs a Node 22+ sidecar in an explicitly opened tab.
It forwards agent status changes for configured workspaces to one Agent Relay
channel and exposes a read-only `herdr.session_summary` Relay action.

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

Name the copied file `agent-relay.json`, replace `workspaceKey`, and list only
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

## State and safety

The Relay agent token and status-transition dedupe state are stored only in
`HERDR_PLUGIN_STATE_DIR`. The state file is mode 0600 on POSIX; on Windows it
inherits the account-scoped ACL of Herdr's plugin state directory. Subsequent
starts reconnect with that token rather than registering another Relay agent.
An exclusive state-directory lock prevents two bridge panes from racing to
rotate that token. If the bridge process crashes, verify that it has stopped
before removing the reported stale `relay-bridge.lock` file.
The configuration file belongs in `HERDR_PLUGIN_CONFIG_DIR`; do not commit a
real workspace key.
