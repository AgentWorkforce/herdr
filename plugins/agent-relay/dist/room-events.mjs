import { createHash } from 'node:crypto';

const EVENT_DEDUPE_LIMIT = 2_048;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

export function relayEventIdentity(event) {
  if (!event || typeof event !== 'object') return undefined;
  const messageId = event.message?.id ?? event.messageId;
  const resourceId =
    messageId ??
    event.invocationId ??
    event.channel?.name ??
    event.agent?.name ??
    event.agentName;
  if (typeof resourceId !== 'string' || !resourceId) return undefined;
  const scope = [
    event.type,
    event.channel?.name ?? event.channel,
    event.conversationId,
    event.parentId,
    resourceId,
  ]
    .filter((value) => typeof value === 'string' && value)
    .join(':');
  return scope || undefined;
}

export class RelayEventDeduper {
  constructor(limit = EVENT_DEDUPE_LIMIT) {
    this.limit = limit;
    this.seen = new Map();
  }

  isDuplicate(event) {
    try {
      const identity = relayEventIdentity(event);
      if (!identity) return false;
      const fingerprint = createHash('sha256').update(stableJson(event)).digest('hex');
      if (this.seen.get(identity) === fingerprint) return true;
      this.seen.delete(identity);
      this.seen.set(identity, fingerprint);
      while (this.seen.size > this.limit) {
        this.seen.delete(this.seen.keys().next().value);
      }
      return false;
    } catch {
      // Unknown or cyclic payloads are delivered. Never lose a real event
      // merely because this defensive plugin-boundary deduper cannot hash it.
      return false;
    }
  }

  clear() {
    this.seen.clear();
  }
}
