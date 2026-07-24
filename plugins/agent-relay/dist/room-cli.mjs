import {
  boundedRedactedStderr,
  parseCliOutput,
  rejectCredentialInput,
} from './command-runner.mjs';

const cloudRoom = (name, { scoped = true } = {}) => ({
  command: 'agent-relay',
  alternatives: [['cloud', 'room', name]],
  environmentProfile: 'cloud-control',
  json: true,
  scoped,
});

const relayfile = (alternatives, { json = false, timeoutMs = 5 * 60_000 } = {}) => ({
  command: 'relayfile',
  alternatives,
  environmentProfile: 'relayfile',
  json,
  timeoutMs,
});

export const DEFAULT_ROOM_OPERATIONS = Object.freeze({
  'room.invite': cloudRoom('invite'),
  'room.invites': cloudRoom('invites'),
  'room.revoke-invite': cloudRoom('revoke-invite'),
  'room.members': cloudRoom('members'),
  'room.remove-member': cloudRoom('remove-member'),
  'room.accept': cloudRoom('accept', { scoped: false }),
  'room.revoke-session': cloudRoom('revoke-session'),
  'room.session': cloudRoom('session'),
  'integration.available': relayfile([['integration', 'available']], { json: true }),
  'integration.search': relayfile([['integration', 'search']], { json: true }),
  'integration.login': relayfile([['login']]),
  'integration.connect': relayfile([['integration', 'connect']]),
  'integration.disconnect': relayfile([['integration', 'disconnect']]),
  'integration.list': relayfile([['integration', 'list']], { json: true }),
  'integration.mount': relayfile([['mount']]),
  'integration.stop': relayfile([['stop']], { timeoutMs: 15_000 }),
  'integration.status': relayfile([['status']], { json: true }),
  'integration.writeback-status': relayfile([['writeback', 'status']], { json: true }),
  'integration.writeback-retry': relayfile([['writeback', 'retry']]),
});

function operationError(operation) {
  return new Error(`The installed CLI does not support Relay Room operation: ${operation}`);
}

/**
 * Execute only known argv shapes. Chat never crosses this boundary: it uses
 * @agent-relay/sdk directly after Cloud mints the participant credential.
 */
export class FeatureDetectedRoomCli {
  constructor({
    runner,
    operations = DEFAULT_ROOM_OPERATIONS,
    apiUrl,
  } = {}) {
    if (!runner?.run) throw new Error('Relay Room needs a command runner');
    this.runner = runner;
    this.operations = { ...DEFAULT_ROOM_OPERATIONS, ...operations };
    this.apiUrl = apiUrl;
    this.capabilities = new Map();
  }

  async invoke(
    operation,
    { args = [], workspaceId, input, environmentOverrides = {} } = {}
  ) {
    const spec = this.operations[operation];
    if (!spec) throw operationError(operation);
    for (const value of args) rejectCredentialInput(value);
    if (spec.scoped) rejectCredentialInput(workspaceId);
    if (input !== undefined && operation !== 'room.accept') {
      throw new Error('Only room invitation acceptance can use private command input');
    }
    const base = await this.#supportedBase(operation, spec);
    const commandArgs = [...base, ...args];
    if (spec.scoped) commandArgs.push('--workspace', workspaceId);
    if (spec.command === 'agent-relay' && this.apiUrl) {
      commandArgs.push('--api-url', this.apiUrl);
    }
    if (spec.json) commandArgs.push('--json');

    let result;
    try {
      result = await this.runner.run({
        command: spec.command,
        args: commandArgs,
        environmentOverrides,
        environmentProfile: spec.environmentProfile,
        timeoutMs: spec.timeoutMs,
        ...(input !== undefined ? { input } : {}),
      });
    } catch {
      throw new Error('Relay Room command could not be completed');
    }
    const parsed = parseCliOutput(result.stdout);
    if (result.exitCode !== 0) {
      const details = [parsed.safeOutput, boundedRedactedStderr(result.stderr)].filter(Boolean);
      throw new Error(
        `Relay Room command failed${details.length ? `: ${details.join('\n')}` : ''}`
      );
    }
    return { ...parsed, exitCode: result.exitCode };
  }

  async #supportedBase(operation, spec) {
    if (this.capabilities.has(operation)) return this.capabilities.get(operation);
    for (const candidate of spec.alternatives ?? []) {
      try {
        const result = await this.runner.run({
          command: spec.command,
          args: [...candidate, '--help'],
          environmentProfile: spec.environmentProfile,
          timeoutMs: 5_000,
          maxOutputBytes: 262_144,
        });
        if (result.exitCode === 0) {
          this.capabilities.set(operation, candidate);
          return candidate;
        }
      } catch {
        // Missing or incompatible commands fail closed.
      }
    }
    throw operationError(operation);
  }
}
