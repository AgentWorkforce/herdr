import { spawn } from 'node:child_process';

const SECRET_VALUE = /(?:\b(?:rk|at|ot)_(?:live|test)_[A-Za-z0-9_-]+|\brelay_(?:pa|pr)_[A-Za-z0-9._~-]+|\brelay_room_inv_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])|\b(?:sk|pk)_[A-Za-z0-9_-]+|\bBearer\s+[A-Za-z0-9._~-]+|\b(?:token|secret|password|api[_-]?key|workspace[_-]?key)\s*[:=]\s*[^\s,}\]]+)/gi;
const SECRET_FIELD = /(?:token|credential|secret|password|authorization|api[_-]?key|workspace[_-]?key)/i;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_MAX_ERROR_DETAIL_BYTES = 2_048;
const CHAT_OVERRIDE_KEYS = new Set([
  'RELAY_AGENT_TOKEN',
  'RELAY_BASE_URL',
  'RELAY_WORKSPACE_KEY',
]);
const RELAYFILE_OVERRIDE_KEYS = new Set([
  'RELAYFILE_BASE_URL',
  'RELAYFILE_DELEGATED_CREDENTIALS_FILE',
  'RELAYFILE_LOCAL_DIR',
  'RELAYFILE_TOKEN',
  'RELAYFILE_URL',
  'RELAYFILE_WORKSPACE',
  'RELAYFILE_WORKSPACE_ID',
]);
const EXECUTION_ENVIRONMENT_KEYS = new Set([
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
]);
const CLOUD_CONTROL_ENVIRONMENT_KEYS = new Set([
  ...EXECUTION_ENVIRONMENT_KEYS,
  'AGENT_RELAY_HOME',
  'HOME',
  'LOCALAPPDATA',
  'USERPROFILE',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
]);
const CHILD_ENVIRONMENT_PROFILES = new Set(['chat', 'cloud-control', 'relayfile']);

export function redactSensitiveText(value) {
  return String(value ?? '').replace(SECRET_VALUE, '[redacted]');
}

export function rejectCredentialInput(value) {
  if (SECRET_VALUE.test(String(value ?? ''))) {
    SECRET_VALUE.lastIndex = 0;
    throw new Error('Credentials cannot be supplied through Relay Room');
  }
  SECRET_VALUE.lastIndex = 0;
}

export function sanitizeCliJson(value) {
  if (Array.isArray(value)) return value.map(sanitizeCliJson);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? redactSensitiveText(value) : value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, SECRET_FIELD.test(key) ? '[redacted]' : sanitizeCliJson(nested)])
  );
}

export function parseCliOutput(stdout = '') {
  const text = String(stdout).trim();
  if (!text) return { rawJson: undefined, safeOutput: '' };
  try {
    const rawJson = JSON.parse(text);
    return { rawJson, safeOutput: JSON.stringify(sanitizeCliJson(rawJson), null, 2) };
  } catch {
    return { rawJson: undefined, safeOutput: redactSensitiveText(text) };
  }
}

export function boundedRedactedStderr(
  value,
  maxBytes = DEFAULT_MAX_ERROR_DETAIL_BYTES
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Invalid Relay Room error detail limit');
  }
  const safe = redactSensitiveText(value)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  const bytes = Buffer.from(safe);
  if (bytes.length <= maxBytes) return safe;
  return `${bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/u, '')}…`;
}

function copyEnvironmentKeys(environment, keys) {
  const child = {};
  for (const key of keys) {
    if (typeof environment[key] === 'string' && environment[key]) child[key] = environment[key];
  }
  return child;
}

export function minimalChildEnvironment(
  environment = process.env,
  overrides = {},
  { profile = 'chat' } = {}
) {
  if (!CHILD_ENVIRONMENT_PROFILES.has(profile)) {
    throw new Error('Unsupported Relay Room child environment profile');
  }
  const child = copyEnvironmentKeys(
    environment,
    profile === 'cloud-control' || profile === 'relayfile'
      ? CLOUD_CONTROL_ENVIRONMENT_KEYS
      : EXECUTION_ENVIRONMENT_KEYS
  );
  const overrideKeys =
    profile === 'chat'
      ? CHAT_OVERRIDE_KEYS
      : profile === 'relayfile'
        ? RELAYFILE_OVERRIDE_KEYS
        : new Set();
  for (const [key, value] of Object.entries(overrides)) {
    if (!overrideKeys.has(key)) {
      throw new Error('Unsupported Relay Room child environment override');
    }
    if (typeof value === 'string' && value) child[key] = value;
  }
  return child;
}

/**
 * A narrow, shell-free process adapter. It intentionally never logs commands,
 * output, or environment values. Tests can replace it with a fake runner.
 */
export function createCommandRunner({ spawnImpl = spawn, environment = process.env } = {}) {
  return {
    async run({
      command,
      args = [],
      input,
      environmentOverrides = {},
      environmentProfile = 'chat',
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    }) {
      if (!command || !Array.isArray(args) || args.some((value) => typeof value !== 'string' || value.includes('\0'))) {
        throw new Error('Invalid Relay Room command');
      }
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        !Number.isSafeInteger(maxOutputBytes) ||
        maxOutputBytes < 1
      ) {
        throw new Error('Invalid Relay Room command limits');
      }
      const childEnvironment = minimalChildEnvironment(
        environment,
        environmentOverrides,
        { profile: environmentProfile }
      );
      return new Promise((resolve, reject) => {
        let child;
        try {
          child = spawnImpl(command, args, {
            env: childEnvironment,
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });
        } catch {
          reject(new Error('Unable to start Relay Room command'));
          return;
        }
        let stdout = '';
        let stderr = '';
        let outputBytes = 0;
        let settled = false;
        const finish = (callback) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback();
        };
        const terminate = (message) => {
          child.kill('SIGKILL');
          finish(() => reject(new Error(message)));
        };
        const capture = (kind, chunk) => {
          outputBytes += Buffer.byteLength(chunk);
          if (outputBytes > maxOutputBytes) {
            terminate('Relay Room command exceeded its output limit');
            return;
          }
          if (kind === 'stdout') stdout += chunk;
          else stderr += chunk;
        };
        const timer = setTimeout(() => terminate('Relay Room command timed out'), timeoutMs);
        timer.unref?.();
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => capture('stdout', chunk));
        child.stderr?.on('data', (chunk) => capture('stderr', chunk));
        child.once('error', () => finish(() => reject(new Error('Unable to start Relay Room command'))));
        child.once('close', (exitCode) =>
          finish(() => resolve({ exitCode: exitCode ?? 1, stdout, stderr }))
        );
        if (input !== undefined) child.stdin?.end(input);
        else child.stdin?.end();
      });
    },
  };
}
