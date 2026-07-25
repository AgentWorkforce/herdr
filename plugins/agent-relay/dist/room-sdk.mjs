export const RELAY_SDK_OPERATIONS = new Set([
  'channel.history',
  'message.send',
  'thread.get',
  'thread.reply',
  'reaction.add',
  'reaction.remove',
  'reaction.list',
  'message.get',
  'message.search',
  'message.mark-read',
  'message.readers',
  'message.read-status',
  'direct.send',
  'direct.history',
  'group-direct.create',
  'group-direct.send',
  'channel.list',
  'channel.get',
  'channel.create',
  'channel.update',
  'channel.archive',
  'channel.join',
  'channel.leave',
  'channel.invite',
  'channel.members',
  'channel.mute',
  'channel.unmute',
  'events.subscribe',
  'events.unsubscribe',
  'events.status',
  'presence',
]);

export async function invokeRelaySdk(relay, operation, eventSubscriptions) {
  switch (operation.name) {
    case 'channel.history':
      return relay.messages.list(operation.channel);
    case 'channel.list':
      return relay.channels.list();
    case 'channel.get':
      return relay.channels.get(operation.channel);
    case 'channel.create':
      return relay.channels.create({
        name: operation.channel,
        ...(operation.topic ? { topic: operation.topic } : {}),
      });
    case 'channel.update':
      return relay.channels.update(operation.channel, { topic: operation.topic });
    case 'channel.archive':
      await relay.channels.archive(operation.channel);
      return { ok: true };
    case 'channel.join':
      await relay.channels.join(operation.channel);
      return { ok: true };
    case 'channel.leave':
      await relay.channels.leave(operation.channel);
      return { ok: true };
    case 'channel.invite':
      await relay.channels.invite(operation.channel, operation.agent);
      return { ok: true };
    case 'channel.members':
      return relay.channels.members(operation.channel);
    case 'channel.mute':
      await relay.channels.mute(operation.channel);
      return { ok: true };
    case 'channel.unmute':
      await relay.channels.unmute(operation.channel);
      return { ok: true };
    case 'message.send':
      return relay.messages.send({ channel: operation.channel, text: operation.text });
    case 'message.get':
      return relay.messages.get(operation.messageId);
    case 'message.search':
      return relay.messages.search(operation.query);
    case 'message.mark-read':
      return relay.messages.markRead(operation.messageId);
    case 'message.readers':
      return relay.messages.readers(operation.messageId);
    case 'message.read-status':
      return relay.messages.readStatus(operation.channel);
    case 'thread.get':
      return relay.threads.get(operation.messageId);
    case 'thread.reply':
      return relay.threads.reply({
        messageId: operation.messageId,
        text: operation.text,
      });
    case 'direct.send':
      return relay.messages.direct({ to: operation.to, text: operation.text });
    case 'direct.history':
      return relay.messages.listDirect({ conversationId: operation.conversationId });
    case 'group-direct.create':
      return relay.messages.createGroupDirect({
        participants: operation.participants,
        ...(operation.groupName ? { name: operation.groupName } : {}),
      });
    case 'group-direct.send':
      return relay.messages.groupDirect({
        conversationId: operation.conversationId,
        text: operation.text,
      });
    case 'reaction.list':
      return relay.messages.reactions(operation.messageId);
    case 'reaction.add':
      return relay.messages.react(operation.messageId, operation.emoji);
    case 'reaction.remove':
      await relay.messages.unreact(operation.messageId, operation.emoji);
      return { ok: true };
    case 'events.subscribe':
      relay.events.subscribe(operation.channels);
      for (const channel of operation.channels) eventSubscriptions.add(channel);
      return { ok: true, subscriptions: [...eventSubscriptions] };
    case 'events.unsubscribe':
      relay.events.unsubscribe(operation.channels);
      for (const channel of operation.channels) eventSubscriptions.delete(channel);
      return { ok: true, subscriptions: [...eventSubscriptions] };
    case 'presence':
      return relay.agents.presence();
    default:
      throw new Error('Unknown Relay SDK operation');
  }
}
