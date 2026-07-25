import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { AgentRelay } from '@agent-relay/sdk';

import {
  loadRoomConfig,
  pluginPaths,
  PublicWorkspaceIdSchema,
} from './config.mjs';
import {
  redactSensitiveText,
  sanitizeCliJson,
} from './command-runner.mjs';
import {
  isRoomInvitationToken,
  parseRoomOperation,
  tokenizeRoomCommand,
} from './room-commands.mjs';
import { FeatureDetectedRoomCli } from './room-cli.mjs';
import { RelayEventDeduper } from './room-events.mjs';
import { invokeRelaySdk, RELAY_SDK_OPERATIONS } from './room-sdk.mjs';
import {
  acquireRoomLock,
  bindRoomWorkspace,
  claimRoomMount,
  clearRoomSessionCleanup,
  clearRoomSessionIntent,
  deactivateRoomMount,
  loadRoomState,
  markRoomSessionCleanup,
  setRoomSessionIntent,
} from './state.mjs';

export { RelayEventDeduper, relayEventIdentity } from './room-events.mjs';
export { tokenizeRoomCommand } from './room-commands.mjs';

const INTEGRATIONS_DIRECTORY = '.integrations';

function isChildPath(root, target) {
  const offset = relative(root, target);
  return Boolean(offset) && !offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset);
}

function parseContext(environment) {
  const source = environment.HERDR_PLUGIN_CONTEXT_JSON;
  if (!source) throw new Error('Relayfile setup requires Herdr workspace worktree context');
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid context');
    return parsed;
  } catch {
    throw new Error('Relayfile setup requires valid Herdr workspace worktree context');
  }
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function sameGeneration(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    (!left.birthtimeMs ||
      !right.birthtimeMs ||
      left.birthtimeMs === right.birthtimeMs)
  );
}

async function requirePlainDirectory(path, label, filesystem) {
  const metadata = await filesystem.lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a file or symlink`);
  }
  return metadata;
}

async function canonicalHerdrCheckout(environment, filesystem) {
  const context = parseContext(environment);
  const configured = context?.worktree?.checkout_path;
  if (typeof configured !== 'string' || !isAbsolute(configured)) {
    throw new Error('Relayfile setup requires WorkspaceWorktreeInfo.checkout_path');
  }
  const checkoutPath = await filesystem.realpath(configured).catch(() => {
    throw new Error('Relayfile setup requires a live Herdr checkout');
  });
  const checkoutIdentity = await requirePlainDirectory(
    checkoutPath,
    'Herdr checkout',
    filesystem
  );
  const gitMetadata = await filesystem.lstat(join(checkoutPath, '.git')).catch(() => {
    throw new Error('Relayfile setup requires a live Herdr Git checkout');
  });
  if (gitMetadata.isSymbolicLink() || (!gitMetadata.isDirectory() && !gitMetadata.isFile())) {
    throw new Error('Herdr checkout .git metadata must not be a symlink');
  }
  return { checkoutPath, checkoutIdentity };
}

/**
 * Reserve only <checkout>/.integrations. A non-empty directory is accepted
 * solely when private plugin state proves this exact room previously owned it.
 */
export async function prepareHerdrIntegrationsMount(
  environment = process.env,
  existingMount,
  filesystem = { lstat, mkdir, readdir, realpath }
) {
  const { checkoutPath, checkoutIdentity } = await canonicalHerdrCheckout(
    environment,
    filesystem
  );
  const mountPath = join(checkoutPath, INTEGRATIONS_DIRECTORY);
  let created = false;
  try {
    await filesystem.mkdir(mountPath, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw new Error('Cannot create the Relayfile integration mount');
  }
  const mountIdentity = await requirePlainDirectory(
    mountPath,
    'Relayfile integration mount',
    filesystem
  );
  const canonicalMount = await filesystem.realpath(mountPath);
  if (canonicalMount !== mountPath || !isChildPath(checkoutPath, canonicalMount)) {
    throw new Error('Relayfile integration mount failed canonical path validation');
  }
  const entries = await filesystem.readdir(mountPath);
  const owned =
    existingMount?.checkoutPath === checkoutPath &&
    existingMount?.mountPath === mountPath;
  if (entries.length > 0 && !owned) {
    throw new Error('Relayfile refuses to mount over a non-empty source directory');
  }
  const preparedCheckoutIdentity = await requirePlainDirectory(
    checkoutPath,
    'Herdr checkout',
    filesystem
  );
  if (!sameGeneration(checkoutIdentity, preparedCheckoutIdentity)) {
    throw new Error('Herdr checkout changed during Relayfile mount preparation');
  }
  return {
    checkoutPath,
    mountPath,
    created,
    checkoutIdentity: preparedCheckoutIdentity,
    mountIdentity,
  };
}

export async function revalidateHerdrIntegrationsMount(
  prepared,
  filesystem = { lstat, realpath }
) {
  const checkoutIdentity = await requirePlainDirectory(
    prepared.checkoutPath,
    'Herdr checkout',
    filesystem
  );
  const mountIdentity = await requirePlainDirectory(
    prepared.mountPath,
    'Relayfile integration mount',
    filesystem
  );
  if (
    !sameIdentity(prepared.checkoutIdentity, checkoutIdentity) ||
    !sameIdentity(prepared.mountIdentity, mountIdentity) ||
    (await filesystem.realpath(prepared.mountPath)) !== prepared.mountPath
  ) {
    throw new Error('Relayfile integration mount changed during validation');
  }
}

function secureRelayUrl(value) {
  if (typeof value !== 'string') throw new Error('Room session did not return a Relaycast base URL');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Room session returned an invalid Relaycast base URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new Error('Room session returned an unsafe Relaycast base URL');
  }
  return url.toString().replace(/\/+$/, '');
}

function hardenRelayClient(relay) {
  // SDK 11.1 stores transport credentials in enumerable own fields. Relay Room
  // never serializes its client, but make accidental logging safe while users
  // roll forward to the SDK release that enforces this itself.
  for (const property of Object.keys(relay)) {
    Object.defineProperty(relay, property, { enumerable: false });
  }
  if (typeof relay.toJSON !== 'function') {
    Object.defineProperty(relay, 'toJSON', {
      enumerable: false,
      value: () => ({ type: 'AgentRelay', authenticated: true }),
    });
  }
  const inspect = Symbol.for('nodejs.util.inspect.custom');
  if (typeof relay[inspect] !== 'function') {
    Object.defineProperty(relay, inspect, {
      enumerable: false,
      value: () => relay.toJSON(),
    });
  }
  return relay;
}

export function scopedRelaySession(payload, AgentRelayCtor = AgentRelay) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Room session returned an invalid response');
  }
  if (
    payload.role !== 'participant' ||
    typeof payload.agentToken !== 'string' ||
    !payload.agentToken.startsWith('at_live_') ||
    payload.observerToken !== undefined
  ) {
    throw new Error('Room session did not return a full room-participant credential');
  }
  const relaycastBaseUrl = secureRelayUrl(payload.relaycastBaseUrl);
  let relay;
  try {
    relay = new AgentRelayCtor({
      agentToken: payload.agentToken,
      baseUrl: relaycastBaseUrl,
    });
  } catch (error) {
    // Agent Relay SDK 11.1 requires the transport credential in workspaceKey
    // even when the same scoped agentToken is supplied. This compatibility
    // path never reads an ambient owner key and becomes unnecessary once the
    // agent-token-only SDK constructor ships.
    if (!/requires workspaceKey/i.test(error?.message ?? '')) throw error;
    relay = new AgentRelayCtor({
      workspaceKey: payload.agentToken,
      agentToken: payload.agentToken,
      baseUrl: relaycastBaseUrl,
    });
  }
  return {
    role: 'participant',
    agentName:
      typeof payload.agentName === 'string' && payload.agentName
        ? payload.agentName
        : 'workspace-participant',
    relay: hardenRelayClient(relay),
  };
}

export function agentDiscoveryGuidance() {
  return [
    'Relay Room agent discovery guidance',
    '',
    '- Invited people are trusted full room participants in v1.',
    '- They can use ordinary agent-level collaboration actions; owner-key administration stays owner-only.',
    '- Chat uses @agent-relay/sdk directly with the participant credential.',
    '- The Relayfile mirror is exactly <Herdr checkout>/.integrations.',
    '- Discover providers with `integration available` or `integration search`; never guess one.',
    '- Inspect each provider `.adapter.md`, `.schema.json`, and `.create.example.json` before writing.',
    '- Never write the reserved `.integrations/.relay/` directory.',
    '- Check `integration writeback-status` after any provider write.',
  ].join('\n');
}

function formatResult(value) {
  try {
    return redactSensitiveText(
      JSON.stringify(sanitizeCliJson(value ?? { ok: true }), null, 2)
    );
  } catch {
    return JSON.stringify(
      {
        type:
          typeof value?.type === 'string'
            ? redactSensitiveText(value.type)
            : 'unserializable-result',
        detail: 'Relay returned a result that could not be rendered safely',
      },
      null,
      2
    );
  }
}

export class RelayRoomController {
  static async create({
    environment = process.env,
    runner,
    operations,
    AgentRelayCtor = AgentRelay,
    onEvent,
  } = {}) {
    const { configDir, stateDir } = pluginPaths(environment);
    const lock = await acquireRoomLock(stateDir);
    try {
      const config = await loadRoomConfig(configDir, { optional: true });
      const existingState = await loadRoomState(stateDir);
      const state = config.workspaceId
        ? await bindRoomWorkspace(stateDir, config.workspaceId)
        : existingState;
      const workspaceId = config.workspaceId ?? state?.workspaceId;
      const cli = new FeatureDetectedRoomCli({
        runner,
        operations,
        apiUrl: config.apiUrl,
      });
      const controller = new RelayRoomController({
        environment,
        cli,
        workspaceId,
        relayfileWorkspace: config.relayfileWorkspace ?? workspaceId,
        stateDir,
        sessionIntent: state?.sessionIntent,
        sessionCleanup: state?.sessionCleanup,
        relayfileMount: state?.relayfileMount,
        AgentRelayCtor,
        onEvent,
        lock,
      });
      await controller.recoverPersistedMount();
      await controller.recoverPendingSessionCleanup();
      await controller.renewPersistedSession();
      return controller;
    } catch (error) {
      await lock.release().catch(() => undefined);
      throw error;
    }
  }

  constructor({
    environment,
    cli,
    workspaceId,
    relayfileWorkspace,
    stateDir,
    sessionIntent,
    sessionCleanup,
    relayfileMount,
    AgentRelayCtor,
    onEvent,
    lock,
  }) {
    this.environment = environment;
    this.cli = cli;
    this.workspaceId = workspaceId;
    this.relayfileWorkspace = relayfileWorkspace;
    this.stateDir = stateDir;
    this.sessionIntent = sessionIntent;
    this.sessionCleanup = sessionCleanup;
    this.relayfileMount = relayfileMount;
    this.AgentRelayCtor = AgentRelayCtor;
    this.onEvent = onEvent;
    this.lock = lock;
    this.relaySession = undefined;
    this.eventUnsubscribe = undefined;
    this.eventDeduper = new RelayEventDeduper();
    this.eventSubscriptions = new Set();
    this.closed = false;
  }

  async renewPersistedSession() {
    if (!this.sessionIntent?.deviceId) return;
    try {
      await this.#renewRoomSession(this.sessionIntent.deviceId, { persistIntent: false });
    } catch (error) {
      this.relaySession = undefined;
      throw new Error(`Relay Room could not renew its persisted chat session: ${error.message}`);
    }
  }

  async recoverPendingSessionCleanup() {
    if (!this.sessionCleanup?.needed) return;
    const { deviceId } = this.sessionCleanup;
    try {
      await this.#revokeRoomSession(deviceId);
      await this.#clearPersistedRoomSession(deviceId);
    } catch (error) {
      throw new Error(`Relay Room could not finish pending session cleanup: ${error.message}`);
    }
  }

  async recoverPersistedMount() {
    if (!this.relayfileMount?.active) return;
    try {
      await this.#invokeIntegration(
        'integration.stop',
        [this.relayfileMount.relayfileWorkspace]
      );
      await deactivateRoomMount(this.stateDir, this.relayfileMount);
      this.relayfileMount = { ...this.relayfileMount, active: false };
    } catch {
      throw new Error('Relay Room could not stop the previously active Relayfile mount');
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.#disconnectRelayEvents();
      this.relaySession = undefined;
    } finally {
      await this.lock?.release();
    }
  }

  async execute(line) {
    const [command, ...args] = tokenizeRoomCommand(line);
    if (!command) return '';
    if (command === 'help') return this.help();
    if (command === 'guide') return agentDiscoveryGuidance();
    const operation = parseRoomOperation(command, args, {
      workspaceId: this.workspaceId,
      relayfileWorkspace: this.relayfileWorkspace,
    });

    if (operation.name === 'room.reset-session') {
      await this.#disconnectRelayEvents();
      this.relaySession = undefined;
      const deviceId = this.sessionIntent?.deviceId;
      if (deviceId) {
        try {
          await this.#revokeRoomSession(deviceId);
          await this.#clearPersistedRoomSession(deviceId);
        } catch {
          const next = await markRoomSessionCleanup(this.stateDir, deviceId, 'reset-session');
          this.sessionCleanup = next.sessionCleanup;
          throw new Error('Room session reset locally, but server-side revocation is pending');
        }
      } else {
        await this.#clearPersistedRoomSession();
      }
      return 'Room session reset. Run room new-session <device-id> to authenticate again.';
    }

    if (operation.name === 'room.session') {
      this.#requireWorkspace();
      await this.#disconnectRelayEvents();
      this.relaySession = undefined;
      const deviceId = operation.args[1];
      const previousDeviceId = this.sessionIntent?.deviceId;
      if (previousDeviceId) {
        try {
          await this.#revokeRoomSession(previousDeviceId);
          await this.#clearPersistedRoomSession(previousDeviceId);
        } catch {
          const next = await markRoomSessionCleanup(
            this.stateDir,
            previousDeviceId,
            'new-session'
          );
          this.sessionCleanup = next.sessionCleanup;
          throw new Error(
            'Relay Room could not revoke the previous device session; cleanup-needed state was saved'
          );
        }
      }
      await this.#renewRoomSession(deviceId, { persistIntent: true });
      return `Full room participant session ready as ${this.relaySession.agentName}.`;
    }

    if (RELAY_SDK_OPERATIONS.has(operation.name)) {
      if (!this.relaySession) {
        throw new Error('Run room new-session <device-id> before using Relay chat');
      }
      if (operation.name === 'events.status') {
        return formatResult({
          connected: Boolean(this.eventUnsubscribe),
          subscriptions: [...this.eventSubscriptions],
        });
      }
      return formatResult(
        await invokeRelaySdk(
          this.relaySession.relay,
          operation,
          this.eventSubscriptions
        )
      );
    }

    if (operation.name === 'room.accept') {
      if (this.workspaceId) {
        throw new Error('Relay Room is already bound; accept invitations only from an unbound Room');
      }
      const result = await this.cli.invoke(operation.name, {
        args: operation.args,
        ...(operation.input !== undefined ? { input: operation.input } : {}),
      });
      const acceptedWorkspace = PublicWorkspaceIdSchema.safeParse(
        result.rawJson?.membership?.workspaceId
      );
      if (!acceptedWorkspace.success) {
        throw new Error('Cloud did not return a valid public room workspace');
      }
      const state = await bindRoomWorkspace(this.stateDir, acceptedWorkspace.data);
      this.workspaceId = state.workspaceId;
      this.relayfileWorkspace ??= state.workspaceId;
      return `Room invitation accepted and bound to ${state.workspaceId}. Run room new-session <device-id>.`;
    }

    if (operation.name === 'room.invite') {
      this.#requireWorkspace();
      const result = await this.cli.invoke(operation.name, {
        args: operation.args,
        workspaceId: this.workspaceId,
      });
      const token = result.rawJson?.invite?.token;
      if (!isRoomInvitationToken(token)) {
        throw new Error('Cloud did not return a valid one-time room invitation token');
      }
      return `Full-participant invitation token (share securely): ${token}`;
    }

    if (operation.name === 'integration.setup' || operation.name === 'integration.mount') {
      return this.#startRelayfile(operation);
    }
    if (operation.name === 'integration.stop') {
      const result = await this.#invokeIntegration(operation.name, operation.args);
      if (this.relayfileMount?.active) {
        await deactivateRoomMount(this.stateDir, this.relayfileMount);
        this.relayfileMount = { ...this.relayfileMount, active: false };
      }
      return result.safeOutput || formatResult(result.rawJson);
    }

    const result = operation.name.startsWith('integration.')
      ? await this.#invokeIntegration(operation.name, operation.args)
      : await this.cli.invoke(operation.name, {
          args: operation.args,
          workspaceId: this.#requireWorkspace(),
          ...(operation.input !== undefined ? { input: operation.input } : {}),
        });
    return result.safeOutput || formatResult(result.rawJson);
  }

  #requireWorkspace() {
    if (!this.workspaceId) {
      throw new Error(
        'Relay Room is not bound yet. Accept an invitation with room accept <token>, or configure workspaceId.'
      );
    }
    return this.workspaceId;
  }

  #connectRelayEvents() {
    if (!this.onEvent || !this.relaySession || this.eventUnsubscribe) return;
    const events = this.relaySession.relay.events;
    this.eventUnsubscribe = events.on('any', (event) => {
      if (this.eventDeduper.isDuplicate(event)) return;
      try {
        this.onEvent(formatResult(event));
      } catch {
        // Realtime display failures must not tear down the Relay SDK stream.
      }
    });
    try {
      events.connect();
    } catch {
      this.eventUnsubscribe?.();
      this.eventUnsubscribe = undefined;
    }
  }

  async #disconnectRelayEvents() {
    const relay = this.relaySession?.relay;
    const wasConnected = Boolean(this.eventUnsubscribe);
    this.eventUnsubscribe?.();
    this.eventUnsubscribe = undefined;
    this.eventSubscriptions.clear();
    this.eventDeduper.clear();
    if (wasConnected && relay?.events?.disconnect) {
      await relay.events.disconnect().catch(() => undefined);
    }
  }

  async #renewRoomSession(deviceId, { persistIntent }) {
    const result = await this.cli.invoke('room.session', {
      args: ['--device-id', deviceId],
      workspaceId: this.workspaceId,
    });
    const relaySession = scopedRelaySession(result.rawJson, this.AgentRelayCtor);
    if (persistIntent) {
      try {
        await setRoomSessionIntent(this.stateDir, deviceId);
      } catch (error) {
        try {
          await this.#revokeRoomSession(deviceId);
        } catch {
          const next = await markRoomSessionCleanup(
            this.stateDir,
            deviceId,
            'persist-failure'
          );
          this.sessionCleanup = next.sessionCleanup;
        }
        throw error;
      }
      this.sessionIntent = { deviceId };
      this.sessionCleanup = undefined;
    }
    this.relaySession = relaySession;
    this.#connectRelayEvents();
  }

  async #revokeRoomSession(deviceId) {
    await this.cli.invoke('room.revoke-session', {
      args: ['--device-id', deviceId],
      workspaceId: this.workspaceId,
    });
  }

  async #clearPersistedRoomSession(deviceId) {
    const current = await clearRoomSessionCleanup(this.stateDir);
    this.sessionCleanup = current?.sessionCleanup;
    if (!deviceId || this.sessionIntent?.deviceId === deviceId) {
      const next = await clearRoomSessionIntent(this.stateDir);
      this.sessionIntent = next?.sessionIntent;
    }
  }

  async #startRelayfile(operation) {
    const prepared = await prepareHerdrIntegrationsMount(
      this.environment,
      this.relayfileMount
    );
    const mount = {
      relayfileWorkspace: this.relayfileWorkspace,
      checkoutPath: prepared.checkoutPath,
      mountPath: prepared.mountPath,
    };
    const claim = await claimRoomMount(this.stateDir, mount);
    this.relayfileMount = claim.state.relayfileMount;
    try {
      await revalidateHerdrIntegrationsMount(prepared);
      if (operation.name === 'integration.setup') {
        await this.#invokeIntegration(
          'integration.login',
          ['--no-open'],
          prepared.mountPath
        );
        await this.#invokeIntegration(
          'integration.connect',
          [
            operation.provider,
            '--workspace',
            this.relayfileWorkspace,
            '--no-open',
            ...operation.backendArgs,
          ],
          prepared.mountPath
        );
      }
      const result = await this.#invokeIntegration(
        'integration.mount',
        [this.relayfileWorkspace, prepared.mountPath, '--background'],
        prepared.mountPath
      );
      return result.safeOutput || formatResult(result.rawJson);
    } catch (error) {
      await deactivateRoomMount(this.stateDir, this.relayfileMount);
      this.relayfileMount = { ...this.relayfileMount, active: false };
      throw error;
    }
  }

  async #invokeIntegration(name, args, mountPath = this.relayfileMount?.mountPath) {
    return this.cli.invoke(name, {
      args,
      environmentOverrides: mountPath ? { RELAYFILE_LOCAL_DIR: mountPath } : {},
    });
  }

  help() {
    return [
      'Session: room accept <token>; room new-session <device-id>; room reset-session.',
      'Channels: channel list|get|create|update|archive|join|leave|invite|members|mute|unmute ...; history <#channel>.',
      'Messages: message send|get|search|mark-read|readers|read-status|reactions ...; thread <id>; thread reply <id> <text>.',
      'Direct: dm send <agent> <text>; dm history <conversation-id>; group create <agent,agent> [name]; group send <conversation-id> <text>.',
      'Live: events status; events subscribe|unsubscribe <#channel...>; reaction add|remove <id> <emoji>; presence.',
      'Membership: room invite <email>; room invites; room members; room revoke-invite <id>; room remove-member <id>; room accept <token>.',
      'Relayfile: integration available [query]; integration search <query>; integration login; integration connect|disconnect <provider>; integration list.',
      'Provider setup: integration adopt <provider> <connection-id>; integration set-metadata <provider> <key=value...>; integration resolve-path <provider> <resource>.',
      'Mounts: integration setup <provider>; integration mount; integration stop; integration status.',
      'Writebacks: integration writeback-status; integration writeback-retry <operation-id>.',
      'The Relayfile mirror is always <Herdr checkout>/.integrations.',
      'Run guide for agent discovery guidance.',
    ].join('\n');
  }
}
