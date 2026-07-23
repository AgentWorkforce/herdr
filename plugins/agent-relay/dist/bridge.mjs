import { createHash } from 'node:crypto';
import { hostname } from 'node:os';

import { AgentRelay } from '@agent-relay/sdk';
import { z } from 'zod';

import { loadBridgeConfig, pluginPaths } from './config.mjs';
import { requestHerdr, subscribeToBridgeEvents } from './herdr-socket.mjs';
import { acquireBridgeLock, loadBridgeState, saveBridgeState } from './state.mjs';

const SUMMARY_INPUT = z.object({}).strict();
const SUMMARY_OUTPUT = z
  .object({
    workspaceIds: z.array(z.string()),
    agents: z.number().int().nonnegative(),
    statuses: z
      .object({
        idle: z.number().int().nonnegative(),
        working: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        done: z.number().int().nonnegative(),
        unknown: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
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
    previousTransition: previous,
    transitionFingerprint: fingerprint,
    transitionSequence: sequence,
    idempotencyKey: `herdr-status-${hash(`${event.paneId}\u0000${sequence}\u0000${fingerprint}`)}`,
  };
}

export function rollbackTransition(state, transition) {
  const current = state.transitions[transition.paneId];
  if (
    current?.fingerprint !== transition.transitionFingerprint ||
    current.sequence !== transition.transitionSequence
  ) {
    return;
  }
  if (transition.previousTransition) state.transitions[transition.paneId] = transition.previousTransition;
  else delete state.transitions[transition.paneId];
}

export function formatStatusMessage(event) {
  return `Herdr agent status: ${event.workspaceId}/${event.paneId} ${event.agent} is ${event.status}.`;
}

function stateWriter(stateDir, state) {
  let pending = Promise.resolve();
  const write = () => {
    pending = pending.catch(() => undefined).then(() => saveBridgeState(stateDir, state));
    return pending;
  };
  write.flush = () => pending;
  return write;
}

function createSubscriptionManager({ socketPath, workspaceIds, onStatus, logger }) {
  let active;
  let activePaneKey;
  let stopped = false;
  let pending = Promise.resolve();
  let refreshTimer;

  // Generic Herdr lifecycle subscriptions replay retained events from sequence
  // zero. Snapshot polling avoids treating that history as a fresh pane change.
  const scheduleRefresh = () => {
    if (stopped || refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void rebuild().catch(() => {
        logger.warn('Agent Relay bridge could not refresh its Herdr subscriptions');
        scheduleRefresh();
      });
    }, 1_000);
  };

  const rebuild = () => {
    pending = pending.catch(() => undefined).then(async () => {
      if (stopped) return;
      const snapshot = sessionSnapshotFrom(await requestHerdr(socketPath, 'session.snapshot'));
      const paneIds = snapshot.panes
        .filter((pane) => workspaceIds.has(pane.workspace_id))
        .map((pane) => pane.pane_id)
        .sort();
      const paneKey = paneIds.join('\u0000');
      if (active && !active.closed && paneKey === activePaneKey) {
        scheduleRefresh();
        return;
      }
      const next = await subscribeToBridgeEvents(socketPath, paneIds, onStatus);
      if (stopped) {
        next.close();
        return;
      }
      const previous = active;
      active = next;
      activePaneKey = paneKey;
      next.once('closed', () => {
        if (active === next && !stopped) scheduleRefresh();
      });
      if (next.closed) scheduleRefresh();
      previous?.close();
      scheduleRefresh();
    });
    return pending;
  };

  return {
    async start() {
      await rebuild();
    },
    stop() {
      stopped = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      active?.close();
    },
  };
}

async function connectRelay(config, state, socketPath, AgentRelayCtor) {
  const options = { workspaceKey: config.workspaceKey };
  if (config.baseUrl) options.baseUrl = config.baseUrl;
  const relay = new AgentRelayCtor(options);
  let agent;
  if (state.apiToken) {
    agent = await relay.workspace.reconnect({ apiToken: state.apiToken });
  } else {
    agent = await relay.workspace.register({
      name: bridgeName(socketPath),
      type: 'agent',
      metadata: { integration: 'herdr' },
    });
    if (!agent.token) throw new Error('Agent Relay registration did not return an agent token');
    state.apiToken = agent.token;
  }
  await agent.channels.join(config.channel);
  return { agent };
}

export function registerSessionSummaryAction(agent, socketPath, workspaceIds) {
  return agent.registerAction({
    name: 'herdr.session_summary',
    description: 'Return aggregate Herdr agent status counts for the configured workspaces.',
    input: SUMMARY_INPUT,
    output: SUMMARY_OUTPUT,
    handler: async () => {
      const snapshot = sessionSnapshotFrom(await requestHerdr(socketPath, 'session.snapshot'));
      return summarizeSnapshot(snapshot, workspaceIds);
    },
  });
}

export function installStopHandlers(target, stop) {
  target.once('SIGINT', stop);
  target.once('SIGTERM', stop);
  if (target.platform !== 'win32') target.once('SIGHUP', stop);
}

export async function startBridge({
  environment = process.env,
  AgentRelayCtor = AgentRelay,
  logger = console,
} = {}) {
  const { configDir, stateDir } = pluginPaths(environment);
  const socketPath = environment.HERDR_SOCKET_PATH;
  if (!socketPath) throw new Error('Herdr did not provide HERDR_SOCKET_PATH');

  const lock = await acquireBridgeLock(stateDir);
  let action;
  let subscriptions;
  let persistState;
  const deliveries = new Set();
  const cleanup = async () => {
    const errors = [];
    for (const step of [
      () => subscriptions?.stop(),
      // Herdr escalates pane shutdown quickly after SIGHUP. Release the local
      // singleton lock before any remote unregister or delivery can delay it.
      () => lock.release(),
      () => action?.unregister(),
      () => Promise.allSettled(deliveries),
      () => persistState?.flush(),
    ]) {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Agent Relay bridge cleanup failed');
  };
  try {
    const config = await loadBridgeConfig(configDir);
    const workspaceIds = new Set(config.workspaceIds);
    const state = await loadBridgeState(stateDir);
    persistState = stateWriter(stateDir, state);

    await requestHerdr(socketPath, 'ping');

    const { agent } = await connectRelay(config, state, socketPath, AgentRelayCtor);
    await persistState();
    action = registerSessionSummaryAction(agent, socketPath, config.workspaceIds);
    subscriptions = createSubscriptionManager({
      socketPath,
      workspaceIds,
      logger,
      onStatus(message) {
        const event = normalizeStatusEvent(message, workspaceIds);
        if (!event) return;
        const transition = prepareTransition(state, event);
        if (!transition) return;
        const delivery = agent
          .sendMessage({
            to: config.channel,
            text: formatStatusMessage(transition),
            idempotencyKey: transition.idempotencyKey,
          })
          .then(
            () =>
              persistState().catch(() =>
                logger.warn('Agent Relay bridge forwarded a status update but could not persist its dedupe state')
              ),
            () => {
              rollbackTransition(state, transition);
              logger.warn('Agent Relay bridge could not forward a Herdr status update');
            }
          );
        deliveries.add(delivery);
        void delivery.finally(() => deliveries.delete(delivery));
      },
    });
    await subscriptions.start();
  } catch (error) {
    await cleanup().catch(() => logger.warn('Agent Relay bridge cleanup failed during startup'));
    throw error;
  }

  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      await cleanup();
    },
  };
}

async function main() {
  const bridge = startBridge();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void bridge.then((active) => active.stop()).then(
      () => process.exit(0),
      (error) => {
        console.error(`Agent Relay bridge failed to stop cleanly: ${error.message}`);
        process.exit(1);
      }
    );
  };
  installStopHandlers(process, stop);
  await bridge;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Agent Relay bridge failed: ${error.message}`);
    process.exitCode = 1;
  });
}
