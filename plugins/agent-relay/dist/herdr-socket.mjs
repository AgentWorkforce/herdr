import { EventEmitter } from 'node:events';
import net from 'node:net';

let requestSequence = 0;

export function localSocketTarget(socketPath, platform = process.platform) {
  if (!socketPath) throw new Error('HERDR_SOCKET_PATH is required');
  if (platform !== 'win32') return socketPath;
  if (/^\\\\[^\\]+\\pipe\\/i.test(socketPath)) return socketPath;
  return `\\\\.\\pipe\\${socketPath}`;
}

function nextRequestId() {
  requestSequence += 1;
  return `agent-relay-${process.pid}-${requestSequence}`;
}

export class JsonLineSocket extends EventEmitter {
  static async connect(socketPath, options = {}) {
    const target = localSocketTarget(socketPath, options.platform);
    const socket = net.createConnection(target);
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        socket.off('connect', onConnect);
        reject(error);
      };
      const onConnect = () => {
        socket.off('error', onError);
        resolve();
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
    });
    return new JsonLineSocket(socket);
  }

  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = '';
    this.closed = false;
    this.pending = new Map();
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.#receive(chunk));
    socket.on('error', (error) => this.#rejectAll(error));
    const handleClosed = () => {
      if (this.closed) return;
      this.closed = true;
      this.#rejectAll(new Error('Herdr socket closed'));
      this.emit('closed');
    };
    socket.on('end', handleClosed);
    socket.on('close', handleClosed);
  }

  request(method, params) {
    const id = nextRequestId();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close() {
    this.socket.end();
    this.socket.destroy();
  }

  #receive(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.emit('protocolError');
        continue;
      }
      const pending = typeof message.id === 'string' ? this.pending.get(message.id) : undefined;
      if (pending) {
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error('Herdr API request failed'));
        else pending.resolve(message);
        continue;
      }
      this.emit('event', message);
    }
  }

  #rejectAll(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}

export async function requestHerdr(socketPath, method, params = {}) {
  const client = await JsonLineSocket.connect(socketPath);
  try {
    return await client.request(method, params);
  } finally {
    client.close();
  }
}

export async function subscribeToBridgeEvents(socketPath, paneIds, onEvent) {
  const client = await JsonLineSocket.connect(socketPath);
  client.on('event', onEvent);
  try {
    await client.request('events.subscribe', {
      subscriptions: [
        { type: 'pane.created' },
        { type: 'pane.closed' },
        { type: 'pane.moved' },
        { type: 'workspace.closed' },
        ...[...new Set(paneIds)].map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id })),
      ],
    });
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
