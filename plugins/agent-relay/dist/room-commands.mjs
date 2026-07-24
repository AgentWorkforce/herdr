import { rejectCredentialInput } from './command-runner.mjs';

function safeScalar(value, label) {
  if (!value || typeof value !== 'string' || value.includes('\0') || value.startsWith('-')) {
    throw new Error(`${label} must be a non-option value`);
  }
  rejectCredentialInput(value);
  return value;
}

function participantList(value) {
  const participants = String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => safeScalar(item, 'participant'));
  if (participants.length < 2 || new Set(participants).size !== participants.length) {
    throw new Error('group participants must contain at least two unique comma-separated names');
  }
  return participants;
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

function requiredWorkspace(workspaceId) {
  if (!workspaceId) {
    throw new Error(
      'Relay Room is not bound yet. Accept an invitation with room accept <token>, or configure workspaceId.'
    );
  }
  return workspaceId;
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

function channelOperation(args) {
  const [verb, ...values] = args;
  if (verb === 'list' && values.length === 0) return { name: 'channel.list' };
  if (['get', 'archive', 'join', 'leave', 'members', 'mute', 'unmute'].includes(verb)) {
    if (values.length !== 1) throw new Error(`usage: channel ${verb} <#channel>`);
    return {
      name: `channel.${verb}`,
      channel: safeScalar(values[0], 'channel'),
    };
  }
  if (verb === 'invite' && values.length === 2) {
    return {
      name: 'channel.invite',
      channel: safeScalar(values[0], 'channel'),
      agent: safeScalar(values[1], 'agent'),
    };
  }
  if (verb === 'create' && values.length >= 1) {
    return {
      name: 'channel.create',
      channel: safeScalar(values[0], 'channel'),
      ...(values.length > 1 ? { topic: values.slice(1).join(' ') } : {}),
    };
  }
  if (verb === 'update' && values.length >= 2) {
    return {
      name: 'channel.update',
      channel: safeScalar(values[0], 'channel'),
      topic: values.slice(1).join(' '),
    };
  }
  throw new Error(
    'usage: channel list|get|create|update|archive|join|leave|invite|members|mute|unmute ...'
  );
}

function roomOperation(args) {
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

function integrationOperation(args, { workspaceId, relayfileWorkspace }) {
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
    const workspace = requiredWorkspace(workspaceId);
    return {
      name: 'integration.connect',
      args: [
        safeScalar(values[0], 'provider'),
        '--workspace',
        relayfileWorkspace ?? workspace,
        '--no-open',
        ...backendArgs,
      ],
    };
  }
  if (verb === 'login' && rawValues.length === 0) {
    return { name: 'integration.login', args: ['--no-open'] };
  }
  if (verb === 'list' && rawValues.length === 0) {
    const workspace = requiredWorkspace(workspaceId);
    return {
      name: 'integration.list',
      args: ['--workspace', relayfileWorkspace ?? workspace],
    };
  }
  if (verb === 'disconnect' && rawValues.length === 1) {
    const workspace = requiredWorkspace(workspaceId);
    return {
      name: 'integration.disconnect',
      args: [
        safeScalar(rawValues[0], 'provider'),
        '--workspace',
        relayfileWorkspace ?? workspace,
        '--yes',
      ],
    };
  }
  if (verb === 'adopt') {
    if (rawValues.length !== 2) {
      throw new Error('usage: integration adopt <provider> <connection-id>');
    }
    const workspace = requiredWorkspace(workspaceId);
    return {
      name: 'integration.adopt',
      args: [
        safeScalar(rawValues[0], 'provider'),
        '--connection-id',
        safeScalar(rawValues[1], 'connection id'),
        '--workspace',
        relayfileWorkspace ?? workspace,
        '--yes',
      ],
    };
  }
  if (verb === 'set-metadata') {
    if (rawValues.length < 2) {
      throw new Error('usage: integration set-metadata <provider> <key=value...>');
    }
    const workspace = requiredWorkspace(workspaceId);
    return {
      name: 'integration.set-metadata',
      args: [
        safeScalar(rawValues[0], 'provider'),
        ...rawValues.slice(1).map((value) => safeScalar(value, 'metadata')),
        '--workspace',
        relayfileWorkspace ?? workspace,
        '--yes',
      ],
    };
  }
  if (verb === 'resolve-path' && rawValues.length === 2) {
    return {
      name: 'integration.resolve-path',
      args: [
        safeScalar(rawValues[0], 'provider'),
        safeScalar(rawValues[1], 'resource'),
      ],
    };
  }
  if (verb === 'setup') {
    const { values, backendArgs } = parseBackend(rawValues);
    if (values.length !== 1) {
      throw new Error('usage: integration setup <provider> [--backend name]');
    }
    requiredWorkspace(workspaceId);
    return {
      name: 'integration.setup',
      provider: safeScalar(values[0], 'provider'),
      backendArgs,
    };
  }
  if (verb === 'mount' && rawValues.length === 0) {
    requiredWorkspace(workspaceId);
    return { name: 'integration.mount' };
  }
  if (verb === 'stop' && rawValues.length === 0) {
    const workspace = requiredWorkspace(workspaceId);
    return { name: 'integration.stop', args: [relayfileWorkspace ?? workspace] };
  }
  if (verb === 'status' && rawValues.length === 0) {
    const workspace = requiredWorkspace(workspaceId);
    return { name: 'integration.status', args: [relayfileWorkspace ?? workspace] };
  }
  if (verb === 'writeback-status' && rawValues.length === 0) {
    const workspace = requiredWorkspace(workspaceId);
    return {
      name: 'integration.writeback-status',
      args: [relayfileWorkspace ?? workspace],
    };
  }
  if (verb === 'writeback-retry' && rawValues.length === 1) {
    const workspace = requiredWorkspace(workspaceId);
    return {
      name: 'integration.writeback-retry',
      args: [
        '--opId',
        safeScalar(rawValues[0], 'operation id'),
        relayfileWorkspace ?? workspace,
      ],
    };
  }
  throw new Error(
    'usage: integration available|search|connect|disconnect|adopt|set-metadata|resolve-path|list|setup|mount|stop|status|writeback-status|writeback-retry ...'
  );
}

export function parseRoomOperation(
  command,
  args,
  { workspaceId, relayfileWorkspace } = {}
) {
  if (command === 'history' && args.length === 1) {
    return { name: 'channel.history', channel: safeScalar(args[0], 'channel') };
  }
  if (command === 'presence' && args.length === 0) return { name: 'presence' };
  if (command === 'channel') return channelOperation(args);
  if (command === 'dm') {
    if (args[0] === 'send' && args.length >= 3) {
      return {
        name: 'direct.send',
        to: safeScalar(args[1], 'recipient'),
        text: args.slice(2).join(' '),
      };
    }
    if (args[0] === 'history' && args.length === 2) {
      return {
        name: 'direct.history',
        conversationId: safeScalar(args[1], 'conversation id'),
      };
    }
    throw new Error('usage: dm send <agent> <text> | dm history <conversation-id>');
  }
  if (command === 'group') {
    if (args[0] === 'create' && [2, 3].includes(args.length)) {
      return {
        name: 'group-direct.create',
        participants: participantList(args[1]),
        ...(args[2] ? { groupName: safeScalar(args[2], 'group name') } : {}),
      };
    }
    if (args[0] === 'send' && args.length >= 3) {
      return {
        name: 'group-direct.send',
        conversationId: safeScalar(args[1], 'conversation id'),
        text: args.slice(2).join(' '),
      };
    }
    throw new Error(
      'usage: group create <agent,agent> [name] | group send <conversation-id> <text>'
    );
  }
  if (command === 'events') {
    if (args[0] === 'status' && args.length === 1) return { name: 'events.status' };
    if (['subscribe', 'unsubscribe'].includes(args[0]) && args.length >= 2) {
      return {
        name: `events.${args[0]}`,
        channels: args.slice(1).map((value) => safeScalar(value, 'channel')),
      };
    }
    throw new Error('usage: events status | events subscribe|unsubscribe <#channel...>');
  }
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
  if (command === 'message') {
    if (args[0] === 'send' && args.length >= 3) {
      return {
        name: 'message.send',
        channel: safeScalar(args[1], 'channel'),
        text: args.slice(2).join(' '),
      };
    }
    if (
      ['get', 'mark-read', 'readers', 'reactions'].includes(args[0]) &&
      args.length === 2
    ) {
      return {
        name: args[0] === 'reactions' ? 'reaction.list' : `message.${args[0]}`,
        messageId: safeScalar(args[1], 'message id'),
      };
    }
    if (args[0] === 'read-status' && args.length === 2) {
      return {
        name: 'message.read-status',
        channel: safeScalar(args[1], 'channel'),
      };
    }
    if (args[0] === 'search' && args.length >= 2) {
      return { name: 'message.search', query: args.slice(1).join(' ') };
    }
    throw new Error(
      'usage: message send|get|search|mark-read|readers|read-status|reactions ...'
    );
  }
  if (command === 'reaction' && ['add', 'remove'].includes(args[0]) && args.length === 3) {
    return {
      name: `reaction.${args[0]}`,
      messageId: safeScalar(args[1], 'message id'),
      emoji: safeScalar(args[2], 'emoji'),
    };
  }
  if (command === 'room') return roomOperation(args);
  if (command === 'integration') {
    return integrationOperation(args, { workspaceId, relayfileWorkspace });
  }
  throw new Error('Unknown Relay Room command. Run help for the supported controls.');
}
