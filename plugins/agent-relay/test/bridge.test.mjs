import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  bridgeName,
  installStopHandlers,
  normalizeStatusEvent,
  prepareTransition,
  rollbackTransition,
  startBridge,
  summarizeSnapshot,
} from '../dist/bridge.mjs';
import { BridgeConfigSchema, loadBridgeConfig, redactConfig } from '../dist/config.mjs';
import { localSocketTarget } from '../dist/herdr-socket.mjs';
import { acquireBridgeLock, loadBridgeState, lockPath } from '../dist/state.mjs';

const snapshot = {
  agents: [
    { workspace_id: 'w1', agent_status: 'working' },
    { workspace_id: 'w1', agent_status: 'blocked' },
    { workspace_id: 'w2', agent_status: 'idle' },
  ],
  panes: [
    { pane_id: 'w1:p1', workspace_id: 'w1' },
    { pane_id: 'w2:p1', workspace_id: 'w2' },
  ],
};

test('installs the pane hangup stop handler on Unix', () => {
  const installedSignals = (platform) => {
    const signals = [];
    installStopHandlers(
      {
        platform,
        once(signal) {
          signals.push(signal);
        },
      },
      () => {}
    );
    return signals;
  };

  assert.deepEqual(installedSignals('darwin'), ['SIGINT', 'SIGTERM', 'SIGHUP']);
  assert.deepEqual(installedSignals('win32'), ['SIGINT', 'SIGTERM']);
});

async function eventually(assertion, attempts = 50) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await assertion();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'herdr-agent-relay-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function fakeHerdrServer(
  socketPath,
  { dynamicPane = true, disconnectFirstSubscription = false, replayLifecycle = false } = {}
) {
  const requests = [];
  let currentSnapshot = structuredClone(snapshot);
  let subscriptions = 0;
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        requests.push(request);
        if (request.method === 'ping') {
          socket.write(`${JSON.stringify({ id: request.id, result: { type: 'pong' } })}\n`);
        } else if (request.method === 'session.snapshot') {
          socket.write(`${JSON.stringify({ id: request.id, result: { snapshot: currentSnapshot } })}\n`);
        } else if (request.method === 'events.subscribe') {
          socket.write(`${JSON.stringify({ id: request.id, result: { type: 'subscribed' } })}\n`);
          subscriptions += 1;
          if (replayLifecycle) {
            queueMicrotask(() => {
              socket.write(
                `${JSON.stringify({
                  event: 'pane_created',
                  data: { pane: { pane_id: 'historical:pane', workspace_id: 'w1' } },
                })}\n`
              );
            });
          }
          if (dynamicPane && subscriptions === 1) {
            queueMicrotask(() => {
              currentSnapshot = {
                ...currentSnapshot,
                panes: [...currentSnapshot.panes, { pane_id: 'w1:p2', workspace_id: 'w1' }],
              };
            });
          } else if (dynamicPane && subscriptions === 2) {
            queueMicrotask(() => {
              socket.write(
                `${JSON.stringify({
                  event: 'pane.agent_status_changed',
                  data: { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'codex', agent_status: 'working' },
                })}\n`
              );
            });
          } else if (disconnectFirstSubscription && subscriptions === 1) {
            queueMicrotask(() => socket.end());
          }
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(localSocketTarget(socketPath), resolve));
  return { requests, server };
}

async function writeConfig(configDir) {
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, 'agent-relay.json'),
    JSON.stringify({ workspaceKey: 'rk_live_secret', channel: '#agent-status', workspaceIds: ['w1'] }),
    { mode: 0o600 }
  );
  if (process.platform !== 'win32') await chmod(join(configDir, 'agent-relay.json'), 0o600);
}

test('validates configuration and redacts workspace credentials', async () => {
  await withTemporaryDirectory(async (directory) => {
    await writeConfig(directory);
    const config = await loadBridgeConfig(directory);
    assert.equal(redactConfig(config).workspaceKey, '[redacted]');
    assert.equal(config.channel, '#agent-status');
    assert.equal(
      BridgeConfigSchema.safeParse({
        workspaceKey: 'rk_live_secret',
        baseUrl: 'http://relay.example.com',
        channel: '#agent-status',
        workspaceIds: ['w1'],
      }).success,
      false
    );
    assert.equal(
      BridgeConfigSchema.safeParse({
        workspaceKey: 'rk_live_secret',
        baseUrl: 'http://127.0.0.1:3000',
        channel: '#agent-status',
        workspaceIds: ['w1'],
      }).success,
      true
    );
    assert.equal(
      BridgeConfigSchema.safeParse({
        workspaceKey: 'rk_live_secret',
        baseUrl: 'not-a-url',
        channel: '#agent-status',
        workspaceIds: ['w1'],
      }).success,
      false
    );
  });
});

test('rejects exposed credential files and duplicate bridge processes', async () => {
  await withTemporaryDirectory(async (directory) => {
    const configDir = join(directory, 'config');
    const stateDir = join(directory, 'state');
    await writeConfig(configDir);
    if (process.platform !== 'win32') {
      await chmod(join(configDir, 'agent-relay.json'), 0o644);
      await assert.rejects(loadBridgeConfig(configDir), /must not be accessible/);
      await chmod(join(configDir, 'agent-relay.json'), 0o600);

      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'relay-state.json'), JSON.stringify({ transitions: {} }), { mode: 0o644 });
      await assert.rejects(loadBridgeState(stateDir), /must not be accessible/);
      await chmod(join(stateDir, 'relay-state.json'), 0o600);
    }

    const first = await acquireBridgeLock(stateDir);
    await assert.rejects(acquireBridgeLock(stateDir), /Another Agent Relay bridge holds/);
    await first.release();
    await assert.rejects(stat(lockPath(stateDir)), { code: 'ENOENT' });
  });
});

test('recovers a bridge lock whose owner process has stopped', async () => {
  await withTemporaryDirectory(async (directory) => {
    await mkdir(directory, { recursive: true });
    await writeFile(
      lockPath(directory),
      `${JSON.stringify({ pid: 2_147_483_647, nonce: 'stale' })}\n`,
      { mode: 0o600 }
    );

    const lock = await acquireBridgeLock(directory);
    const owner = JSON.parse(await readFile(lockPath(directory), 'utf8'));
    assert.equal(owner.pid, process.pid);
    await lock.release();
    await assert.rejects(stat(lockPath(directory)), { code: 'ENOENT' });
  });
});

test('uses the interprocess-compatible Windows pipe name', () => {
  assert.equal(localSocketTarget('C:\\Users\\me\\herdr.sock', 'win32'), '\\\\.\\pipe\\C:\\Users\\me\\herdr.sock');
  assert.equal(localSocketTarget('\\\\.\\pipe\\herdr.sock', 'win32'), '\\\\.\\pipe\\herdr.sock');
});

test('deduplicates identical status events while preserving later repeated states', () => {
  const state = { transitions: {} };
  const working = { paneId: 'w1:p1', workspaceId: 'w1', agent: 'codex', status: 'working' };
  const blocked = { ...working, status: 'blocked' };
  assert.match(prepareTransition(state, working).idempotencyKey, /^herdr-status-/);
  assert.equal(prepareTransition(state, working), undefined);
  assert.match(prepareTransition(state, blocked).idempotencyKey, /^herdr-status-/);
  assert.match(prepareTransition(state, working).idempotencyKey, /^herdr-status-/);
  assert.equal(state.transitions['w1:p1'].sequence, 3);
});

test('rolls back a failed transition so the same status can be retried', () => {
  const state = { transitions: {} };
  const event = { paneId: 'w1:p1', workspaceId: 'w1', agent: 'codex', status: 'working' };
  const transition = prepareTransition(state, event);
  rollbackTransition(state, transition);
  assert.deepEqual(state.transitions, {});
  assert.equal(prepareTransition(state, event).idempotencyKey, transition.idempotencyKey);

  const superseded = prepareTransition(state, { ...event, status: 'blocked' });
  rollbackTransition(state, transition);
  assert.equal(state.transitions['w1:p1'].fingerprint, superseded.transitionFingerprint);
  assert.equal(state.transitions['w1:p1'].sequence, superseded.transitionSequence);
});

test('filters status events and summarizes only configured workspaces', () => {
  const allowed = new Set(['w1']);
  assert.equal(
    normalizeStatusEvent(
      { event: 'pane.agent_status_changed', data: { pane_id: 'w2:p1', workspace_id: 'w2', agent_status: 'working' } },
      allowed
    ),
    undefined
  );
  assert.deepEqual(summarizeSnapshot(snapshot, ['w1']), {
    workspaceIds: ['w1'],
    agents: 2,
    statuses: { idle: 0, working: 1, blocked: 1, done: 0, unknown: 0 },
  });
});

test('refreshes per-pane subscriptions without replaying historical lifecycle events', async () => {
  await withTemporaryDirectory(async (directory) => {
    const configDir = join(directory, 'config');
    const stateDir = join(directory, 'state');
    const socketPath = join(directory, 'herdr.sock');
    await writeConfig(configDir);
    const { server, requests } = await fakeHerdrServer(socketPath, { replayLifecycle: true });
    const sent = [];
    const actions = [];
    let registrations = 0;
    const client = {
      token: 'at_live_bridge',
      channels: {
        async join(channel) {
          assert.equal(channel, '#agent-status');
        },
      },
      registerAction(definition) {
        actions.push(definition);
        return { unregister() {} };
      },
      async sendMessage(input) {
        sent.push(input);
      },
    };
    class FakeRelay {
      constructor(options) {
        assert.equal(options.workspaceKey, 'rk_live_secret');
        this.workspace = {
          register: async () => {
            registrations += 1;
            return client;
          },
          reconnect: async () => {
            throw new Error('reconnect should not run without persisted state');
          },
        };
      }
    }

    const bridge = await startBridge({
      environment: { HERDR_PLUGIN_CONFIG_DIR: configDir, HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_SOCKET_PATH: socketPath },
      AgentRelayCtor: FakeRelay,
      logger: { warn() {} },
    });
    await eventually(
      () => assert.equal(requests.filter((request) => request.method === 'events.subscribe').length, 2),
      150
    );
    await eventually(() => assert.equal(sent.length, 1));
    assert.equal(registrations, 1);
    assert.deepEqual(requests.filter((request) => request.method === 'events.subscribe')[0].params.subscriptions, [
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1' },
    ]);
    assert.deepEqual(requests.filter((request) => request.method === 'events.subscribe')[1].params.subscriptions, [
      { type: 'pane.agent_status_changed', pane_id: 'w1:p1' },
      { type: 'pane.agent_status_changed', pane_id: 'w1:p2' },
    ]);
    assert.equal(sent[0].to, '#agent-status');
    assert.match(sent[0].text, /w1\/w1:p2 codex is working/);
    assert.match(sent[0].idempotencyKey, /^herdr-status-/);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(requests.filter((request) => request.method === 'events.subscribe').length, 2);

    // Action results are returned through Relay's invocation output. Do not
    // depend on the transport event's caller label being a routable DM handle.
    const result = await actions[0].handler({ input: {}, agent: { name: 'node' } });
    assert.equal(result.agents, 2);
    assert.equal(actions[0].input.safeParse({ unexpected: true }).success, false);
    assert.equal(actions[0].output.safeParse(result).success, true);
    assert.equal(sent.length, 1);
    await eventually(async () => {
      const contents = await readFile(join(stateDir, 'relay-state.json'), 'utf8');
      assert.match(contents, /at_live_bridge/);
    });
    if (process.platform !== 'win32') {
      const permissions = (await stat(join(stateDir, 'relay-state.json'))).mode & 0o777;
      assert.equal(permissions, 0o600);
    }

    await bridge.stop();
    await new Promise((resolve) => server.close(resolve));
    await unlink(socketPath).catch(() => {});
  });
});

test('reconnects from the persisted bridge token without registering again', async () => {
  await withTemporaryDirectory(async (directory) => {
    const configDir = join(directory, 'config');
    const stateDir = join(directory, 'state');
    const socketPath = join(directory, 'herdr.sock');
    await writeConfig(configDir);
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'relay-state.json'), JSON.stringify({ apiToken: 'at_live_saved', transitions: {} }), {
      mode: 0o600,
    });
    const { server } = await fakeHerdrServer(socketPath, { dynamicPane: false });
    const reconnects = [];
    const client = {
      channels: { join: async () => {} },
      registerAction: () => ({ unregister() {} }),
      sendMessage: async () => {},
    };
    class ReconnectRelay {
      constructor() {
        this.workspace = {
          register: async () => {
            throw new Error('registration must not rotate a persisted token');
          },
          reconnect: async ({ apiToken }) => {
            reconnects.push(apiToken);
            return client;
          },
        };
      }
    }

    const bridge = await startBridge({
      environment: { HERDR_PLUGIN_CONFIG_DIR: configDir, HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_SOCKET_PATH: socketPath },
      AgentRelayCtor: ReconnectRelay,
      logger: { warn() {} },
    });
    assert.deepEqual(reconnects, ['at_live_saved']);
    assert.equal(bridgeName('/tmp/herdr.sock'), bridgeName('/tmp/herdr.sock'));
    assert.notEqual(bridgeName('/tmp/herdr.sock'), bridgeName('/tmp/other.sock'));
    await bridge.stop();
    await new Promise((resolve) => server.close(resolve));
    await unlink(socketPath).catch(() => {});
  });
});

test('resubscribes after its Herdr subscription connection closes', async () => {
  await withTemporaryDirectory(async (directory) => {
    const configDir = join(directory, 'config');
    const stateDir = join(directory, 'state');
    const socketPath = join(directory, 'herdr.sock');
    await writeConfig(configDir);
    const { requests, server } = await fakeHerdrServer(socketPath, {
      dynamicPane: false,
      disconnectFirstSubscription: true,
    });
    const client = {
      token: 'at_live_bridge',
      channels: { join: async () => {} },
      registerAction: () => ({ unregister() {} }),
      sendMessage: async () => {},
    };
    class ReconnectSocketRelay {
      constructor() {
        this.workspace = { register: async () => client };
      }
    }

    const bridge = await startBridge({
      environment: { HERDR_PLUGIN_CONFIG_DIR: configDir, HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_SOCKET_PATH: socketPath },
      AgentRelayCtor: ReconnectSocketRelay,
      logger: { warn() {} },
    });
    await eventually(() => assert.equal(requests.filter((request) => request.method === 'events.subscribe').length, 2), 150);
    await bridge.stop();
    await new Promise((resolve) => server.close(resolve));
    await unlink(socketPath).catch(() => {});
  });
});
