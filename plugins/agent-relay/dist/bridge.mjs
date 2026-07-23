import { createHash } from 'node:crypto';
import { hostname } from 'node:os';

import { AgentRelay } from '@agent-relay/sdk';
import { z } from 'zod';

import { loadBridgeConfig, pluginPaths } from './config.mjs';
import { requestHerdr, subscribeToBridgeEvents } from './herdr-socket.mjs';
import { loadBridgeState, saveBridgeState } from './state.mjs';

const SUMMARY_INPUT = z.object({}).strict();
const STATUS_VALUES = new Set(['idle', 'working', 'blocked', 'done', 'unknown']);

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function bridgeName(socketPath, host = hostname()) {
  const safeHost = host.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'host';
  return `herdr-${safeHost.slice(0, 30)}-${hash(socketPath).slice(0, 12)}`;
}

export function sessionSnapshotFrom(response) {
  const snapshot = response?.result?.snapshot;
  if (!snapshot || !Array.isArray(snapshot.agents) || !Array.isArray(snapshot.panes)) {
    throw new Error('Herdr returned an invalid session snapshot');
  }
  return snapshot;
}

export function summarizeSnapshot(snapshot, workspaceIds) {
  const allowed = new Set(workspaceIds);
  const statuses = { idle: 0, working: 0, blocked: 0, done: 0, unknown: 0 };
  let agents = 0;
  for (const agent of snapshot.agents) {
    if (!allowed.has(agent.workspace_id) || !STATUS_VALUES.has(agent.agent_status)) continue;
    statuses[agent.agent_status] += 1;
    agents += 1;
  }
  return { workspaceIds: [...allowed], agents, statuses };
}

export function formatSessionSummary(summary) {
  const { statuses } = summary;
  return `Herdr summary: ${summary.agents} agents across ${summary.workspaceIds.length} workspaces — working ${statuses.working}, blocked ${statuses.blocked}, idle ${statuses.idle}, done ${statuses.done}, unknown ${statuses.unknown}.`;
}

export function normalizeStatusEvent(message, workspaceIds) {
  const data = message?.data;
  if (
    message?.event !== 'pane.agent_status_changed' ||
    !data ||
    typeof data.pane_id !== 'string' ||
    typeof data.workspace_id !== 'string' ||
    !STATUS_VALUES.has(data.agent_status) ||
    !workspaceIds.has(data.workspace_id)
  ) {
    return undefined;
  }
  return {
    paneId: data.pane_id,
    workspaceId: data.workspace_id,
    agent: typeof data.agent === 'string' && data.agent ? data.agent : 'unknown',
    status: data.agent_status,
  };
}

export function prepareTransition(state, event) {
  const fingerprint = [event.paneId, event.workspaceId, event.agent, event.status].join('\u0000');
  const previous = state.transitions[event.paneId];
  if (previous?.fingerprint === fingerprint) return undefined;
  const sequence = (previous?.sequence ?? 0) + 1;
  state.transitions[event.paneId] = { fingerprint, sequence };
  return {
    ...event,
    idempotencyKey: `herdr-status-${hash(`${event.paneId}\u0000${sequence}\u0000${fingerprint}`)}`,
  };
}

export function formatStatusMessage(event) {
  return `Herdr agent status: ${event.workspaceId}/${event.paneId} ${event.agent} is ${event.status}.`;
}

function stateWriter(stateDir, state) {
  let pending = Promise.resolve();
  return () => {
    pending = pending.catch(() => undefined).then(() => saveBridgeState(stateDir, state));
    return pending;
  };
}

function isPaneLifecycleEvent(message) {
  return ['pane.created', 'pane.closed', 'pane.moved', 'workspace.closed'].includes(message?.event);
}

function createSubscriptionManager({ socketPath, workspaceIds, onStatus, logger }) {
  let active;
  let stopped = false;
  let pending = Promise.resolve();
  let reconnectTimer;

  const scheduleRebuild = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void rebuild().catch(() => {
        logger.warn('Agent Relay bridge could not reconnect to Herdr');
        scheduleRebuild();
      });
    }, 1_000);
  };

  const rebuild = () => {
    pending = pending.catch(() => undefined).then(async () => {
      if (stopped) return;
      const snapshot = sessionSnapshotFrom(await requestHerdr(socketPath, 'session.snapshot'));
      const paneIds = snapshot.panes
        .filter((pane) => workspaceIds.has(pane.workspace_id))
        .map((pane) => pane.pane_id);
      const next = await subscribeToBridgeEvents(socketPath, paneIds, (message) => {
        if (isPaneLifecycleEvent(message)) {
          void rebuild().catch(() => scheduleRebuild());
          return;
        }
        onStatus(message);
      });
      if (stopped) {
        next.close();
        return;
      }
      const previous = active;
      active = next;
      next.once('closed', () => {
        if (active === next && !stopped) scheduleRebuild();
      });
      if (next.closed) scheduleRebuild();
      previous?.close();
    });
    return pending;
  };

  return {
    async start() {
      await rebuild();
    },
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      active?.close();
    },
  };
}

async function connectRelay(config, state, socketPath, AgentRelayCtor) {
  const options = { workspaceKey: config.workspaceKey };
  if (config.baseUrl) options.baseUrl = config.baseUrl;
  const relay = new AgentRelayCtor(options);
  if (state.apiToken) {
    return { agent: await relay.workspace.reconnect({ apiToken: state.apiToken }) };
  }
  const agent = await relay.workspace.register({
    name: bridgeName(socketPath),
    type: 'agent',
    metadata: { integration: 'herdr' },
  });
  if (!agent.token) throw new Error('Agent Relay registration did not return an agent token');
  state.apiToken = agent.token;
  return { agent };
}

export function registerSessionSummaryAction(agent, socketPath, workspaceIds) {
  return agent.registerAction({
    name: 'herdr.session_summary',
    description: 'Return aggregate Herdr agent status counts for the configured workspaces.',
    input: SUMMARY_INPUT,
    handler: async ({ agent: caller }) => {
      const snapshot = sessionSnapshotFrom(await requestHerdr(socketPath, 'session.snapshot'));
      const summary = summarizeSnapshot(snapshot, workspaceIds);
      const recipient = caller.handle ?? caller.name;
      await agent.sendMessage({ to: `@${recipient}`, text: formatSessionSummary(summary) });
      return summary;
    },
  });
}

export async function startBridge({
  environment = process.env,
  AgentRelayCtor = AgentRelay,
  logger = console,
} = {}) {
  const { configDir, stateDir } = pluginPaths(environment);
  const socketPath = environment.HERDR_SOCKET_PATH;
  if (!socketPath) throw new Error('Herdr did not provide HERDR_SOCKET_PATH');

  const config = await loadBridgeConfig(configDir);
  const workspaceIds = new Set(config.workspaceIds);
  const state = await loadBridgeState(stateDir);
  const persistState = stateWriter(stateDir, state);

  await requestHerdr(socketPath, 'ping');

  const { agent } = await connectRelay(config, state, socketPath, AgentRelayCtor);
  await persistState();
  const action = registerSessionSummaryAction(agent, socketPath, config.workspaceIds);
  const subscriptions = createSubscriptionManager({
    socketPath,
    workspaceIds,
    logger,
    onStatus(message) {
      const event = normalizeStatusEvent(message, workspaceIds);
      if (!event) return;
      const transition = prepareTransition(state, event);
      if (!transition) return;
      void agent
        .sendMessage({
          to: config.channel,
          text: formatStatusMessage(transition),
          idempotencyKey: transition.idempotencyKey,
        })
        .then(() => persistState())
        .catch(() => logger.warn('Agent Relay bridge could not forward a Herdr status update'));
    },
  });
  await subscriptions.start();

  return {
    stop() {
      action.unregister();
      subscriptions.stop();
    },
  };
}

async function main() {
  const bridge = await startBridge();
  const stop = () => bridge.stop();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Agent Relay bridge failed: ${error.message}`);
    process.exitCode = 1;
  });
}
