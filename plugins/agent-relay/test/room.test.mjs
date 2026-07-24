import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RoomConfigSchema, loadRoomConfig } from '../dist/config.mjs';
import {
  minimalChildEnvironment,
  parseCliOutput,
  redactSensitiveText,
} from '../dist/command-runner.mjs';
import {
  RelayRoomController,
  RelayEventDeduper,
  agentDiscoveryGuidance,
  prepareHerdrIntegrationsMount,
  revalidateHerdrIntegrationsMount,
  scopedRelaySession,
  tokenizeRoomCommand,
} from '../dist/room-client.mjs';
import {
  bindRoomWorkspace,
  claimRoomMount,
  loadRoomState,
  roomStatePath,
} from '../dist/state.mjs';

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'herdr-relay-room-'));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeRoomConfig(
  configDir,
  config = { workspaceId: 'rw_7ccfea89', relayfileWorkspace: 'rw_7ccfea89' }
) {
  await mkdir(configDir, { recursive: true });
  const target = join(configDir, 'relay-room.json');
  await writeFile(target, JSON.stringify(config), { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(target, 0o600);
}

function commandBase(args) {
  if (args[0] === 'cloud') return args.slice(0, 3).join(' ');
  if (args[0] === 'integration') return args.slice(0, 2).join(' ');
  if (args[0] === 'writeback') return args.slice(0, 2).join(' ');
  return args[0] ?? '';
}

function fakeCli({ supported, responses = {} } = {}) {
  const calls = [];
  const counts = new Map();
  const available = new Set(
    supported ?? [
      'cloud room invite',
      'cloud room invites',
      'cloud room revoke-invite',
      'cloud room members',
      'cloud room remove-member',
      'cloud room accept',
      'cloud room revoke-session',
      'cloud room session',
      'integration available',
      'integration search',
      'integration connect',
      'integration disconnect',
      'integration adopt',
      'integration set-metadata',
      'integration resolve-path',
      'integration list',
      'login',
      'mount',
      'stop',
      'status',
      'writeback status',
      'writeback retry',
    ]
  );
  return {
    calls,
    async run(options) {
      const { args } = options;
      calls.push(options);
      const base = commandBase(args);
      if (args.at(-1) === '--help') {
        return { exitCode: available.has(base) ? 0 : 2, stdout: '', stderr: '' };
      }
      const index = counts.get(base) ?? 0;
      counts.set(base, index + 1);
      let payload = responses[base];
      if (Array.isArray(payload)) payload = payload[Math.min(index, payload.length - 1)];
      if (typeof payload === 'function') payload = await payload(options, index);
      if (payload?.exitCode !== undefined) return payload;
      payload ??= { ok: true, operation: base };
      return {
        exitCode: 0,
        stdout: typeof payload === 'string' ? payload : JSON.stringify(payload),
        stderr: '',
      };
    },
  };
}

function fakeRelayConstructor() {
  const instances = [];
  class FakeAgentRelay {
    constructor(options) {
      this.options = options;
      this.calls = [];
      this.messages = {
        list: async (channel) => this.#record('messages.list', { channel }),
        send: async (input) => this.#record('messages.send', input),
        get: async (messageId) => this.#record('messages.get', { messageId }),
        search: async (query) => this.#record('messages.search', { query }),
        direct: async (input) => this.#record('messages.direct', input),
        listDirect: async (input) => this.#record('messages.listDirect', input),
        createGroupDirect: async (input) =>
          this.#record('messages.createGroupDirect', input),
        groupDirect: async (input) => this.#record('messages.groupDirect', input),
        markRead: async (messageId) => this.#record('messages.markRead', { messageId }),
        readers: async (messageId) => this.#record('messages.readers', { messageId }),
        readStatus: async (channel) => this.#record('messages.readStatus', { channel }),
        reactions: async (messageId) => this.#record('messages.reactions', { messageId }),
        react: async (messageId, emoji) =>
          this.#record('messages.react', { messageId, emoji }),
        unreact: async (messageId, emoji) =>
          this.#record('messages.unreact', { messageId, emoji }),
      };
      this.threads = {
        get: async (messageId) => this.#record('threads.get', { messageId }),
        reply: async (input) => this.#record('threads.reply', input),
      };
      this.channels = Object.fromEntries(
        ['list', 'get', 'create', 'update', 'archive', 'join', 'leave', 'invite', 'members', 'mute', 'unmute'].map(
          (name) => [name, async (...args) => this.#record(`channels.${name}`, args)]
        )
      );
      this.agents = {
        presence: async () => this.#record('agents.presence', {}),
      };
      this.eventHandlers = new Set();
      this.events = {
        connect: () => this.#record('events.connect', {}),
        disconnect: async () => this.#record('events.disconnect', {}),
        subscribe: (channels) => this.#record('events.subscribe', { channels }),
        unsubscribe: (channels) => this.#record('events.unsubscribe', { channels }),
        on: (type, handler) => {
          assert.equal(type, 'any');
          this.eventHandlers.add(handler);
          return () => this.eventHandlers.delete(handler);
        },
      };
      instances.push(this);
    }

    emit(event) {
      for (const handler of this.eventHandlers) handler(event);
    }

    #record(name, input) {
      this.calls.push({ name, input });
      return { ok: true, name, input };
    }
  }
  return { FakeAgentRelay, instances };
}

const participantSession = {
  role: 'participant',
  relaycastBaseUrl: 'https://relay.example',
  agentName: 'human-herdr-device',
  agentToken: 'at_live_participant_scoped_value',
};

async function createRoom(
  directory,
  { runner, config, context, AgentRelayCtor, onEvent } = {}
) {
  const configDir = join(directory, 'config');
  const stateDir = join(directory, 'state');
  if (config !== null) await writeRoomConfig(configDir, config);
  else await mkdir(configDir, { recursive: true });
  const environment = {
    HERDR_PLUGIN_CONFIG_DIR: configDir,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    HOME: '/Users/example',
    PATH: process.env.PATH ?? '',
    ...(context ? { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(context) } : {}),
  };
  const relay = AgentRelayCtor ? { AgentRelayCtor } : fakeRelayConstructor();
  return {
    room: await RelayRoomController.create({
      environment,
      runner: runner ?? fakeCli({ responses: { 'cloud room session': participantSession } }),
      AgentRelayCtor: relay.AgentRelayCtor ?? relay.FakeAgentRelay,
      onEvent,
    }),
    environment,
    stateDir,
    relay,
  };
}

async function makeCheckout(directory) {
  const checkout = join(directory, 'checkout');
  await mkdir(join(checkout, '.git'), { recursive: true });
  return checkout;
}

test('accepts only public workspace bindings and permits invite-first bootstrap', async () => {
  assert.equal(RoomConfigSchema.safeParse({ workspaceId: 'rk_live_secret' }).success, false);
  assert.equal(RoomConfigSchema.safeParse({ workspaceId: 'rw_7ccfea89' }).success, true);
  assert.equal(RoomConfigSchema.safeParse({}).success, true);
  assert.equal(
    RoomConfigSchema.safeParse({ relayfileWorkspace: 'rw_7ccfea89' }).success,
    false
  );
  await withTemporaryDirectory(async (directory) => {
    const configDir = join(directory, 'config');
    await mkdir(configDir);
    assert.deepEqual(await loadRoomConfig(configDir, { optional: true }), {});
    await writeRoomConfig(configDir);
    assert.equal((await loadRoomConfig(configDir)).workspaceId, 'rw_7ccfea89');
    if (process.platform !== 'win32') {
      await chmod(join(configDir, 'relay-room.json'), 0o644);
      await assert.rejects(loadRoomConfig(configDir), /must not be accessible/);
    }
  });
});

test('constructs Agent Relay SDK directly from a participant credential', () => {
  const relay = fakeRelayConstructor();
  const session = scopedRelaySession(participantSession, relay.FakeAgentRelay);
  assert.equal(session.role, 'participant');
  assert.deepEqual(relay.instances[0].options, {
    agentToken: 'at_live_participant_scoped_value',
    baseUrl: 'https://relay.example',
  });
  assert.throws(
    () =>
      scopedRelaySession(
        {
          role: 'viewer',
          relaycastBaseUrl: 'https://relay.example',
          observerToken: 'ot_live_read_only',
        },
        relay.FakeAgentRelay
      ),
    /full room-participant/
  );
});

test('supports the installed Agent Relay SDK 11.1 without an ambient owner key', () => {
  const options = [];
  class LegacyAgentRelay {
    constructor(input) {
      options.push(input);
      if (!input.workspaceKey) {
        throw new Error('RelaycastMessagingClient requires workspaceKey');
      }
    }
  }
  scopedRelaySession(participantSession, LegacyAgentRelay);
  assert.deepEqual(options, [
    {
      agentToken: 'at_live_participant_scoped_value',
      baseUrl: 'https://relay.example',
    },
    {
      workspaceKey: 'at_live_participant_scoped_value',
      agentToken: 'at_live_participant_scoped_value',
      baseUrl: 'https://relay.example',
    },
  ]);
  assert.equal(options.some((input) => String(input.workspaceKey).startsWith('rk_live_')), false);
});

test('redacts participant credentials from legacy SDK serialization', () => {
  class EnumerableLegacyAgentRelay {
    constructor(input) {
      if (!input.workspaceKey) {
        throw new Error('RelaycastMessagingClient requires workspaceKey');
      }
      this.workspaceKey = input.workspaceKey;
      this.messagingOptions = { agentToken: input.agentToken, baseUrl: input.baseUrl };
    }
  }
  const session = scopedRelaySession(participantSession, EnumerableLegacyAgentRelay);
  const rendered = JSON.stringify(session.relay);
  assert.equal(rendered, '{"type":"AgentRelay","authenticated":true}');
  assert.doesNotMatch(rendered, /at_live_|relay\.example/);
});

test('routes chat entirely through the Agent Relay SDK', async () => {
  await withTemporaryDirectory(async (directory) => {
    const runner = fakeCli({ responses: { 'cloud room session': participantSession } });
    const created = await createRoom(directory, { runner });
    try {
      await assert.rejects(created.room.execute('history #general'), /new-session/);
      assert.match(
        await created.room.execute('room new-session herdr-device'),
        /Full room participant/
      );
      await created.room.execute('history #general');
      await created.room.execute('message send #general "hello team"');
      await created.room.execute('thread message-1');
      await created.room.execute('thread reply message-1 "on it"');
      await created.room.execute('reaction add message-1 eyes');
      await created.room.execute('reaction remove message-1 eyes');
      await created.room.execute('presence');

      assert.deepEqual(
        created.relay.instances[0].calls.map((call) => call.name),
        [
          'messages.list',
          'messages.send',
          'threads.get',
          'threads.reply',
          'messages.react',
          'messages.unreact',
          'agents.presence',
        ]
      );
      const commandExecutions = runner.calls.filter((call) => !call.args.includes('--help'));
      assert.equal(commandExecutions.length, 1);
      assert.deepEqual(commandExecutions[0].args, [
        'cloud',
        'room',
        'session',
        '--device-id',
        'herdr-device',
        '--workspace',
        'rw_7ccfea89',
        '--json',
      ]);
    } finally {
      await created.room.close();
    }
  });
});

test('exposes trusted participant channels, DMs, search, reads, and live events', async () => {
  await withTemporaryDirectory(async (directory) => {
    const delivered = [];
    const created = await createRoom(directory, {
      onEvent: (event) => delivered.push(event),
    });
    try {
      await created.room.execute('room new-session multiplayer-device');
      await created.room.execute('channel list');
      await created.room.execute('channel create #planning "Launch planning"');
      await created.room.execute('channel join #planning');
      await created.room.execute('channel invite #planning api-worker');
      await created.room.execute('channel members #planning');
      await created.room.execute('dm send api-worker "take the API"');
      await created.room.execute('dm history dm-conversation');
      await created.room.execute('group create api-worker,ui-worker delivery');
      await created.room.execute('group send group-conversation "ship together"');
      await created.room.execute('message get message-1');
      await created.room.execute('message search "workspace handoff"');
      await created.room.execute('message mark-read message-1');
      await created.room.execute('message readers message-1');
      await created.room.execute('message read-status #planning');
      await created.room.execute('message reactions message-1');
      await created.room.execute('events subscribe #planning #general');
      await created.room.execute('events unsubscribe #general');

      const relay = created.relay.instances[0];
      assert.deepEqual(
        relay.calls.map((call) => call.name),
        [
          'events.connect',
          'channels.list',
          'channels.create',
          'channels.join',
          'channels.invite',
          'channels.members',
          'messages.direct',
          'messages.listDirect',
          'messages.createGroupDirect',
          'messages.groupDirect',
          'messages.get',
          'messages.search',
          'messages.markRead',
          'messages.readers',
          'messages.readStatus',
          'messages.reactions',
          'events.subscribe',
          'events.unsubscribe',
        ]
      );

      relay.emit({
        type: 'messageCreated',
        channel: '#planning',
        message: { id: 'message-2', text: 'first' },
      });
      relay.emit({
        type: 'messageCreated',
        channel: '#planning',
        message: { id: 'message-2', text: 'first' },
      });
      relay.emit({
        type: 'messageCreated',
        channel: '#planning',
        message: { id: 'message-2', text: 'edited' },
      });
      assert.equal(delivered.length, 2);
      assert.match(delivered[1], /edited/);
      assert.match(await created.room.execute('events status'), /#planning/);
    } finally {
      await created.room.close();
    }
  });
});

test('event dedupe drops only identical stable events and delivers uncertain events', () => {
  const dedupe = new RelayEventDeduper(2);
  const original = {
    type: 'dmReceived',
    conversationId: 'conversation-1',
    message: { id: 'message-1', text: 'hello' },
  };
  assert.equal(dedupe.isDuplicate(original), false);
  assert.equal(dedupe.isDuplicate(structuredClone(original)), true);
  assert.equal(
    dedupe.isDuplicate({
      ...original,
      message: { id: 'message-1', text: 'changed' },
    }),
    false
  );
  assert.equal(dedupe.isDuplicate({ type: 'connected' }), false);
  assert.equal(dedupe.isDuplicate({ type: 'connected' }), false);
  const cyclic = { type: 'messageCreated', message: { id: 'cyclic-message' } };
  cyclic.self = cyclic;
  assert.equal(dedupe.isDuplicate(cyclic), false);
});

test('persists only device intent and renews it into memory on restart', async () => {
  await withTemporaryDirectory(async (directory) => {
    const first = await createRoom(directory);
    await first.room.execute('room new-session durable-device');
    const persisted = await readFile(roomStatePath(first.stateDir), 'utf8');
    assert.match(persisted, /durable-device/);
    assert.doesNotMatch(persisted, /at_live_|agentToken|credential/);
    await first.room.close();

    const runner = fakeCli({ responses: { 'cloud room session': participantSession } });
    const restarted = await createRoom(directory, { runner });
    try {
      await restarted.room.execute('presence');
      assert.equal(restarted.relay.instances.length, 1);
      assert.deepEqual(
        runner.calls.find((call) => !call.args.includes('--help')).args,
        [
          'cloud',
          'room',
          'session',
          '--device-id',
          'durable-device',
          '--workspace',
          'rw_7ccfea89',
          '--json',
        ]
      );
    } finally {
      await restarted.room.close();
    }
  });
});

test('revokes the previous device before changing or resetting sessions', async () => {
  await withTemporaryDirectory(async (directory) => {
    const runner = fakeCli({ responses: { 'cloud room session': participantSession } });
    const created = await createRoom(directory, { runner });
    try {
      await created.room.execute('room new-session device-one');
      await created.room.execute('room new-session device-two');
      await created.room.execute('room reset-session');
      const executions = runner.calls
        .filter((call) => !call.args.includes('--help'))
        .map((call) => call.args);
      assert.equal(
        executions.filter((args) => commandBase(args) === 'cloud room revoke-session').length,
        2
      );
      assert.equal((await loadRoomState(created.stateDir)).sessionIntent, undefined);
    } finally {
      await created.room.close();
    }
  });
});

test('saves failed session revocation for next-start recovery', async () => {
  await withTemporaryDirectory(async (directory) => {
    const runner = fakeCli({
      responses: {
        'cloud room session': participantSession,
        'cloud room revoke-session': {
          exitCode: 1,
          stdout: '',
          stderr: 'temporarily unavailable',
        },
      },
    });
    const created = await createRoom(directory, { runner });
    await created.room.execute('room new-session device-one');
    await assert.rejects(
      created.room.execute('room new-session device-two'),
      /cleanup-needed/
    );
    assert.deepEqual((await loadRoomState(created.stateDir)).sessionCleanup, {
      needed: true,
      deviceId: 'device-one',
      reason: 'new-session',
    });
    await created.room.close();
  });
});

test('uses the participant-only manual room invite contract', async () => {
  await withTemporaryDirectory(async (directory) => {
    const runner = fakeCli({
      responses: {
        'cloud room invite': {
          invite: {
            id: 'invite-1',
            email: 'person@example.com',
            role: 'participant',
            token: 'herdr_inv_share_once',
            expiresAt: '2026-07-30T00:00:00.000Z',
            createdAt: '2026-07-23T00:00:00.000Z',
          },
        },
      },
    });
    const created = await createRoom(directory, { runner });
    try {
      assert.match(
        await created.room.execute('room invite person@example.com'),
        /Full-participant invitation token/
      );
      const execution = runner.calls.find(
        (call) => commandBase(call.args) === 'cloud room invite' && !call.args.includes('--help')
      );
      assert.deepEqual(execution.args, [
        'cloud',
        'room',
        'invite',
        '--email',
        'person@example.com',
        '--workspace',
        'rw_7ccfea89',
        '--json',
      ]);
      assert.equal(execution.args.includes('--role'), false);
      assert.equal(execution.args.includes('--email-delivery'), false);
    } finally {
      await created.room.close();
    }
  });
});

test('keeps invitation tokens out of argv when accepting', async () => {
  await withTemporaryDirectory(async (directory) => {
    const runner = fakeCli({
      responses: {
        'cloud room accept': {
          membership: {
            id: 'member-1',
            workspaceId: 'rw_7ccfea89',
            role: 'participant',
          },
        },
      },
    });
    const created = await createRoom(directory, { runner, config: null });
    try {
      const token = 'herdr_inv_private_accept_value';
      await created.room.execute(`room accept ${token}`);
      const execution = runner.calls.find(
        (call) => commandBase(call.args) === 'cloud room accept' && !call.args.includes('--help')
      );
      assert.deepEqual(execution.args, ['cloud', 'room', 'accept', '--token-stdin', '--json']);
      assert.equal(execution.input, token);
      assert.equal(execution.args.includes(token), false);
    } finally {
      await created.room.close();
    }
  });
});

test('accepts an invite before local workspace configuration and persists the returned binding', async () => {
  await withTemporaryDirectory(async (directory) => {
    const runner = fakeCli({
      responses: {
        'cloud room accept': {
          membership: {
            id: 'member-1',
            workspaceId: 'rw_7ccfea89',
            role: 'participant',
          },
        },
        'cloud room session': participantSession,
      },
    });
    const created = await createRoom(directory, { runner, config: null });
    try {
      await assert.rejects(
        created.room.execute('room new-session invitee-device'),
        /not bound yet/
      );
      assert.match(
        await created.room.execute('room accept herdr_inv_private_bootstrap'),
        /accepted and bound to rw_7ccfea89/
      );
      await assert.rejects(
        created.room.execute('room accept herdr_inv_would_be_consumed'),
        /already bound/
      );
      await created.room.execute('room new-session invitee-device');
      assert.equal((await loadRoomState(created.stateDir)).workspaceId, 'rw_7ccfea89');
      const acceptance = runner.calls.find(
        (call) => commandBase(call.args) === 'cloud room accept' && !call.args.includes('--help')
      );
      assert.deepEqual(acceptance.args, ['cloud', 'room', 'accept', '--token-stdin', '--json']);
      assert.equal(acceptance.input, 'herdr_inv_private_bootstrap');
      assert.equal(
        runner.calls.filter(
          (call) =>
            commandBase(call.args) === 'cloud room accept' && !call.args.includes('--help')
        ).length,
        1
      );
    } finally {
      await created.room.close();
    }
  });
});

test('rejects non-public workspace IDs returned by invite acceptance', async () => {
  await withTemporaryDirectory(async (directory) => {
    const runner = fakeCli({
      responses: {
        'cloud room accept': {
          membership: {
            id: 'member-1',
            workspaceId: 'rk_live_owner_secret',
            role: 'participant',
          },
        },
      },
    });
    const created = await createRoom(directory, { runner, config: null });
    try {
      await assert.rejects(
        created.room.execute('room accept herdr_inv_untrusted_response'),
        /valid public room workspace/
      );
      assert.equal(await loadRoomState(created.stateDir), undefined);
    } finally {
      await created.room.close();
    }
  });
});

test('stale mount recovery stops its recorded Relayfile workspace', async () => {
  await withTemporaryDirectory(async (directory) => {
    const stateDir = join(directory, 'state');
    await bindRoomWorkspace(stateDir, 'rw_7ccfea89');
    await claimRoomMount(stateDir, {
      relayfileWorkspace: 'rw_oldspace',
      checkoutPath: '/checkout',
      mountPath: '/checkout/.integrations',
    });
    const runner = fakeCli();
    const created = await createRoom(directory, {
      runner,
      config: {
        workspaceId: 'rw_7ccfea89',
        relayfileWorkspace: 'rw_newspace',
      },
    });
    try {
      const stop = runner.calls.find(
        (call) => commandBase(call.args) === 'stop' && !call.args.includes('--help')
      );
      assert.deepEqual(stop.args, ['stop', 'rw_oldspace']);
      assert.equal((await loadRoomState(stateDir)).relayfileMount.active, false);
    } finally {
      await created.room.close();
    }
  });
});

test('uses Relayfile live catalog and connections without room grants or leases', async () => {
  await withTemporaryDirectory(async (directory) => {
    const runner = fakeCli();
    const created = await createRoom(directory, { runner });
    try {
      await created.room.execute('integration available notion --backend nango --refresh');
      await created.room.execute('integration search jira --backend composio');
      await created.room.execute('integration login');
      await created.room.execute('integration connect notion --backend nango');
      await created.room.execute('integration list');
      await created.room.execute('integration adopt salesforce connection-123');
      await created.room.execute('integration set-metadata jira site=example.atlassian.net project=ENG');
      await created.room.execute('integration resolve-path jira ENG-123');
      await created.room.execute('integration disconnect notion');
      await created.room.execute('integration writeback-status');
      await created.room.execute('integration writeback-retry op-123');
      const executions = runner.calls
        .filter((call) => !call.args.includes('--help'))
        .map((call) => [call.command, call.args]);
      assert.deepEqual(executions, [
        ['relayfile', ['integration', 'available', '--backend', 'nango', '--refresh', '--search', 'notion', '--json']],
        ['relayfile', ['integration', 'search', 'jira', '--backend', 'composio', '--json']],
        ['relayfile', ['login', '--no-open']],
        ['relayfile', ['integration', 'connect', 'notion', '--workspace', 'rw_7ccfea89', '--no-open', '--backend', 'nango']],
        ['relayfile', ['integration', 'list', '--workspace', 'rw_7ccfea89', '--json']],
        ['relayfile', ['integration', 'adopt', 'salesforce', '--connection-id', 'connection-123', '--workspace', 'rw_7ccfea89', '--yes']],
        ['relayfile', ['integration', 'set-metadata', 'jira', 'site=example.atlassian.net', 'project=ENG', '--workspace', 'rw_7ccfea89', '--yes']],
        ['relayfile', ['integration', 'resolve-path', 'jira', 'ENG-123', '--json']],
        ['relayfile', ['integration', 'disconnect', 'notion', '--workspace', 'rw_7ccfea89', '--yes']],
        ['relayfile', ['writeback', 'status', 'rw_7ccfea89', '--json']],
        ['relayfile', ['writeback', 'retry', '--opId', 'op-123', 'rw_7ccfea89']],
      ]);
      assert.equal(
        JSON.stringify(executions).includes('credential') ||
          JSON.stringify(executions).includes('grant'),
        false
      );
    } finally {
      await created.room.close();
    }
  });
});

test('setup reuses Agent Relay Cloud login, connects, and mounts one exact directory', async () => {
  await withTemporaryDirectory(async (directory) => {
    const checkout = await makeCheckout(directory);
    const canonicalCheckout = await realpath(checkout);
    const runner = fakeCli();
    const created = await createRoom(directory, {
      runner,
      context: { worktree: { checkout_path: checkout } },
    });
    try {
      await created.room.execute('integration setup linear --backend nango');
      const executions = runner.calls.filter((call) => !call.args.includes('--help'));
      assert.deepEqual(
        executions.map((call) => [call.command, call.args]),
        [
          ['relayfile', ['login', '--no-open']],
          ['relayfile', ['integration', 'connect', 'linear', '--workspace', 'rw_7ccfea89', '--no-open', '--backend', 'nango']],
          ['relayfile', ['mount', 'rw_7ccfea89', join(canonicalCheckout, '.integrations'), '--background']],
        ]
      );
      for (const call of executions) {
        assert.equal(call.isolatedConfigRoot, undefined);
        assert.deepEqual(call.environmentOverrides, {
          RELAYFILE_LOCAL_DIR: join(canonicalCheckout, '.integrations'),
        });
      }
      assert.equal((await loadRoomState(created.stateDir)).relayfileMount.active, true);
      await created.room.execute('integration stop');
      assert.equal((await loadRoomState(created.stateDir)).relayfileMount.active, false);
    } finally {
      await created.room.close();
    }
  });
});

test('mount preparation rejects symlinked and unowned non-empty directories', async () => {
  await withTemporaryDirectory(async (directory) => {
    const checkout = await makeCheckout(directory);
    const context = { HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ worktree: { checkout_path: checkout } }) };
    await mkdir(join(checkout, '.integrations'));
    await writeFile(join(checkout, '.integrations', 'user-file'), 'keep');
    await assert.rejects(
      prepareHerdrIntegrationsMount(context),
      /non-empty source directory/
    );
    await rm(join(checkout, '.integrations'), { recursive: true });
    const outside = join(directory, 'outside');
    await mkdir(outside);
    await symlink(outside, join(checkout, '.integrations'));
    await assert.rejects(
      prepareHerdrIntegrationsMount(context),
      /real directory/
    );
  });
});

test('mount revalidation detects path replacement races', async () => {
  await withTemporaryDirectory(async (directory) => {
    const checkout = await makeCheckout(directory);
    const environment = {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ worktree: { checkout_path: checkout } }),
    };
    const prepared = await prepareHerdrIntegrationsMount(environment);
    await rm(prepared.mountPath, { recursive: true });
    await mkdir(prepared.mountPath);
    await assert.rejects(revalidateHerdrIntegrationsMount(prepared), /changed during validation/);
  });
});

test('Relayfile inherits the user Cloud session but never ambient Relay credentials', () => {
  const environment = {
    HOME: '/Users/example',
    XDG_CONFIG_HOME: '/Users/example/.config',
    PATH: '/bin',
    RELAY_WORKSPACE_KEY: 'rk_live_owner_secret',
    RELAY_AGENT_TOKEN: 'at_live_agent_secret',
  };
  const relayfile = minimalChildEnvironment(
    environment,
    { RELAYFILE_LOCAL_DIR: '/checkout/.integrations' },
    { profile: 'relayfile' }
  );
  assert.equal(relayfile.HOME, '/Users/example');
  assert.equal(relayfile.XDG_CONFIG_HOME, '/Users/example/.config');
  assert.equal(relayfile.RELAYFILE_LOCAL_DIR, '/checkout/.integrations');
  assert.equal(relayfile.RELAY_WORKSPACE_KEY, undefined);
  assert.equal(relayfile.RELAY_AGENT_TOKEN, undefined);
});

test('redaction and tokenization keep credentials out of display and argv', () => {
  assert.equal(redactSensitiveText('token=secret-value at_live_private'), '[redacted] [redacted]');
  assert.doesNotMatch(
    parseCliOutput('{"token":"at_live_private","safe":"ok"}').safeOutput,
    /at_live_private/
  );
  assert.deepEqual(tokenizeRoomCommand('message send #general "hello world"'), [
    'message',
    'send',
    '#general',
    'hello world',
  ]);
  assert.throws(() => tokenizeRoomCommand('message send "unterminated'), /Unclosed/);
});

test('guidance describes direct SDK chat and normal Relayfile writebacks', () => {
  const guidance = agentDiscoveryGuidance();
  assert.match(guidance, /@agent-relay\/sdk directly/);
  assert.match(guidance, /full room participants/);
  assert.match(guidance, /owner-key administration stays owner-only/);
  assert.match(guidance, /writeback-status/);
  assert.doesNotMatch(guidance, /grant-scoped|lease|viewer/);
});
