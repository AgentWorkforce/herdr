import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { AgentRelay } from '@agent-relay/sdk';

import { loadRoomConfig, pluginPaths } from './config.mjs';
import { redactSensitiveText, rejectCredentialInput } from './command-runner.mjs';
import { FeatureDetectedRoomCli } from './room-cli.mjs';
import {
  acquireRoomLock,
  bindRoomWorkspace,
  claimRoomMount,
  clearRoomSessionCleanup,
  clearRoomSessionIntent,
  deactivateRoomMount,
  markRoomSessionCleanup,
  setRoomSessionIntent,
} from './state.mjs';

const INTEGRATIONS_DIRECTORY = '.integrations';
const CHAT_OPERATIONS = new Set([
  'channel.history',
  'message.send',
  'thread.get',
  'thread.reply',
  'reaction.add',
  'reaction.remove',
  'presence',
]);

function isChildPath(root, target) {
  const offset = relative(root, target);
  return Boolean(offset) && !offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset);
}

function safeScalar(value, label) {
  if (!value || typeof value !== 'string' || value.includes('\0') || value.startsWith('-')) {
    throw new Error(`${label} must be a non-option value`);
  }
  rejectCredentialInput(value);
  return value;
}

function privateInvitationToken(value) {
  if (
    typeof value !== 'string' ||
    !/^herdr_inv_[A-Za-z0-9_-]+$/.test(value) ||
    value.length > 2_048
  ) {
    throw new Error('room invitation token is invalid');
  }
  return value;
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
  return left.dev === right.dev && left.ino === right.ino;
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
  return {
    checkoutPath,
    mountPath,
    created,
    checkoutIdentity,
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

export function tokenizeRoomCommand(line) {
  const tokens = [];
  let current = '';
  let quote;
  let escaped = false;
  for (const character of String(line ?? '').trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }
  if (escaped || quote) throw new Error('Unclosed quote or escape in Relay Room command');
  if (current) tokens.push(current);
  return tokens;
}

function parseBackend(args) {
  let backend;
  const values = [];
  let refresh = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--backend') {
      if (backend || index + 1 >= args.length) throw new Error('Use at most one --backend value');
      backend = safeScalar(args[index + 1], 'backend');
      if (!['nango', 'composio'].includes(backend)) {
        throw new Error('backend must be nango or composio');
      }
      index += 1;
    } else if (args[index] === '--refresh') {
      refresh = true;
    } else {
      values.push(args[index]);
    }
  }
  return {
    values,
    backendArgs: backend ? ['--backend', backend] : [],
    refreshArgs: refresh ? ['--refresh'] : [],
  };
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
  return redactSensitiveText(JSON.stringify(value ?? { ok: true }, null, 2));
}

export class RelayRoomController {
  static async create({
    environment = process.env,
    runner,
    operations,
    AgentRelayCtor = AgentRelay,
  } = {}) {
    const { configDir, stateDir } = pluginPaths(environment);
    const lock = await acquireRoomLock(stateDir);
    try {
      const config = await loadRoomConfig(configDir);
      const state = await bindRoomWorkspace(stateDir, config.workspaceId);
      const cli = new FeatureDetectedRoomCli({
        runner,
        operations,
        apiUrl: config.apiUrl,
      });
      const controller = new RelayRoomController({
        environment,
        cli,
        workspaceId: config.workspaceId,
        relayfileWorkspace: config.relayfileWorkspace ?? config.workspaceId,
        stateDir,
        sessionIntent: state.sessionIntent,
        sessionCleanup: state.sessionCleanup,
        relayfileMount: state.relayfileMount,
        AgentRelayCtor,
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
    this.lock = lock;
    this.relaySession = undefined;
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
      await this.#invokeIntegration('integration.stop', [this.relayfileWorkspace]);
      await deactivateRoomMount(this.stateDir, this.relayfileMount);
      this.relayfileMount = { ...this.relayfileMount, active: false };
    } catch {
      throw new Error('Relay Room could not stop the previously active Relayfile mount');
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.relaySession = undefined;
    await this.lock?.release();
  }

  async execute(line) {
    const [command, ...args] = tokenizeRoomCommand(line);
    if (!command) return '';
    if (command === 'help') return this.help();
    if (command === 'guide') return agentDiscoveryGuidance();
    const operation = this.#operationFor(command, args);

    if (operation.name === 'room.reset-session') {
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

    if (CHAT_OPERATIONS.has(operation.name)) {
      if (!this.relaySession) {
        throw new Error('Run room new-session <device-id> before using Relay chat');
      }
      return formatResult(await this.#invokeSdk(operation));
    }

    if (operation.name === 'room.invite') {
      const result = await this.cli.invoke(operation.name, {
        args: operation.args,
        workspaceId: this.workspaceId,
      });
      const token = result.rawJson?.invite?.token;
      if (typeof token !== 'string' || !/^herdr_inv_[A-Za-z0-9_-]+$/.test(token)) {
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
          workspaceId: this.workspaceId,
          ...(operation.input !== undefined ? { input: operation.input } : {}),
        });
    return result.safeOutput || formatResult(result.rawJson);
  }

  async #invokeSdk(operation) {
    const relay = this.relaySession.relay;
    switch (operation.name) {
      case 'channel.history':
        return relay.messages.list(operation.channel);
      case 'message.send':
        return relay.messages.send({ channel: operation.channel, text: operation.text });
      case 'thread.get':
        return relay.messages.thread(operation.messageId);
      case 'thread.reply':
        return relay.messages.reply({
          messageId: operation.messageId,
          text: operation.text,
        });
      case 'reaction.add':
        return relay.messages.react(operation.messageId, operation.emoji);
      case 'reaction.remove':
        await relay.messages.unreact(operation.messageId, operation.emoji);
        return { ok: true };
      case 'presence':
        return relay.agents.presence();
      default:
        throw new Error('Unknown Relay SDK operation');
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

  #operationFor(command, args) {
    if (command === 'history' && args.length === 1) {
      return { name: 'channel.history', channel: safeScalar(args[0], 'channel') };
    }
    if (command === 'presence' && args.length === 0) return { name: 'presence' };
    if (command === 'thread') {
      if (args[0] === 'reply' && args.length >= 3) {
        return {
          name: 'thread.reply',
          messageId: safeScalar(args[1], 'message id'),
          text: args.slice(2).join(' '),
        };
      }
      if (args.length === 1) {
        return { name: 'thread.get', messageId: safeScalar(args[0], 'message id') };
      }
    }
    if (command === 'message' && args[0] === 'send' && args.length >= 3) {
      return {
        name: 'message.send',
        channel: safeScalar(args[1], 'channel'),
        text: args.slice(2).join(' '),
      };
    }
    if (command === 'reaction' && ['add', 'remove'].includes(args[0]) && args.length === 3) {
      return {
        name: `reaction.${args[0]}`,
        messageId: safeScalar(args[1], 'message id'),
        emoji: safeScalar(args[2], 'emoji'),
      };
    }
    if (command === 'room') return this.#roomOperation(args);
    if (command === 'integration') return this.#integrationOperation(args);
    throw new Error('Unknown Relay Room command. Run help for the supported controls.');
  }

  #roomOperation(args) {
    const [verb, ...values] = args;
    if (['invites', 'members'].includes(verb) && values.length === 0) {
      return { name: `room.${verb}`, args: [] };
    }
    if (verb === 'reset-session' && values.length === 0) {
      return { name: 'room.reset-session', args: [] };
    }
    if (verb === 'new-session' && values.length === 1) {
      return {
        name: 'room.session',
        args: ['--device-id', safeScalar(values[0], 'device id')],
      };
    }
    if (verb === 'accept' && values.length === 1) {
      return {
        name: 'room.accept',
        args: ['--token-stdin'],
        input: privateInvitationToken(values[0]),
      };
    }
    if (verb === 'invite' && values.length === 1) {
      return {
        name: 'room.invite',
        args: ['--email', safeScalar(values[0], 'email')],
      };
    }
    if (['revoke-invite', 'remove-member'].includes(verb) && values.length === 1) {
      return { name: `room.${verb}`, args: [safeScalar(values[0], verb)] };
    }
    throw new Error(
      'usage: room invite <email> | room revoke-invite|remove-member|accept <value> | room invites|members | room new-session <device-id> | room reset-session'
    );
  }

  #integrationOperation(args) {
    const [verb, ...rawValues] = args;
    if (verb === 'available') {
      const { values, backendArgs, refreshArgs } = parseBackend(rawValues);
      if (values.length > 1) {
        throw new Error('usage: integration available [query] [--backend name] [--refresh]');
      }
      return {
        name: 'integration.available',
        args: [
          ...backendArgs,
          ...refreshArgs,
          ...(values.length ? ['--search', safeScalar(values[0], 'query')] : []),
        ],
      };
    }
    if (verb === 'search') {
      const { values, backendArgs, refreshArgs } = parseBackend(rawValues);
      if (values.length !== 1) {
        throw new Error('usage: integration search <query> [--backend name] [--refresh]');
      }
      return {
        name: 'integration.search',
        args: [safeScalar(values[0], 'query'), ...backendArgs, ...refreshArgs],
      };
    }
    if (verb === 'connect') {
      const { values, backendArgs } = parseBackend(rawValues);
      if (values.length !== 1) {
        throw new Error('usage: integration connect <provider> [--backend name]');
      }
      return {
        name: 'integration.connect',
        args: [
          safeScalar(values[0], 'provider'),
          '--workspace',
          this.relayfileWorkspace,
          '--no-open',
          ...backendArgs,
        ],
      };
    }
    if (verb === 'login' && rawValues.length === 0) {
      return {
        name: 'integration.login',
        args: ['--no-open'],
      };
    }
    if (verb === 'list' && rawValues.length === 0) {
      return {
        name: 'integration.list',
        args: ['--workspace', this.relayfileWorkspace],
      };
    }
    if (verb === 'disconnect' && rawValues.length === 1) {
      return {
        name: 'integration.disconnect',
        args: [
          safeScalar(rawValues[0], 'provider'),
          '--workspace',
          this.relayfileWorkspace,
          '--yes',
        ],
      };
    }
    if (verb === 'setup') {
      const { values, backendArgs } = parseBackend(rawValues);
      if (values.length !== 1) {
        throw new Error('usage: integration setup <provider> [--backend name]');
      }
      return {
        name: 'integration.setup',
        provider: safeScalar(values[0], 'provider'),
        backendArgs,
      };
    }
    if (verb === 'mount' && rawValues.length === 0) {
      return { name: 'integration.mount' };
    }
    if (verb === 'stop' && rawValues.length === 0) {
      return { name: 'integration.stop', args: [this.relayfileWorkspace] };
    }
    if (verb === 'status' && rawValues.length === 0) {
      return { name: 'integration.status', args: [this.relayfileWorkspace] };
    }
    if (verb === 'writeback-status' && rawValues.length === 0) {
      return {
        name: 'integration.writeback-status',
        args: [this.relayfileWorkspace],
      };
    }
    if (verb === 'writeback-retry' && rawValues.length === 1) {
      return {
        name: 'integration.writeback-retry',
        args: ['--opId', safeScalar(rawValues[0], 'operation id'), this.relayfileWorkspace],
      };
    }
    throw new Error(
      'usage: integration available|search|connect|disconnect|list|setup|mount|stop|status|writeback-status|writeback-retry ...'
    );
  }

  help() {
    return [
      'Session: room new-session <device-id>; room reset-session.',
      'Chat: history <#channel>; message send <#channel> <text>; thread <id>; thread reply <id> <text>; reaction add|remove <id> <emoji>; presence.',
      'Membership: room invite <email>; room invites; room members; room revoke-invite <id>; room remove-member <id>; room accept <token>.',
      'Relayfile: integration available [query]; integration search <query>; integration login; integration connect|disconnect <provider>; integration list.',
      'Mounts: integration setup <provider>; integration mount; integration stop; integration status.',
      'Writebacks: integration writeback-status; integration writeback-retry <operation-id>.',
      'The Relayfile mirror is always <Herdr checkout>/.integrations.',
      'Run guide for agent discovery guidance.',
    ].join('\n');
  }
}
