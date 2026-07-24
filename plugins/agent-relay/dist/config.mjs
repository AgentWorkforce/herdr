import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

const channelName = z.string().trim().regex(/^#[A-Za-z0-9][A-Za-z0-9_-]*$/, {
  message: 'channel must be a #channel-name',
});

const relayBaseUrl = z
  .string()
  .url()
  .superRefine((value, context) => {
    let url;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!['http:', 'https:'].includes(url.protocol) || (url.protocol !== 'https:' && !loopback)) {
      context.addIssue({
        code: 'custom',
        message: 'baseUrl must use HTTPS (HTTP is allowed only for a loopback address)',
      });
    }
    if (url.username || url.password) {
      context.addIssue({ code: 'custom', message: 'baseUrl must not contain credentials' });
    }
  });

const roomApiUrl = relayBaseUrl.superRefine((value, context) => {
  const url = new URL(value);
  if (url.search || url.hash) {
    context.addIssue({
      code: 'custom',
      message: 'apiUrl must not contain query, fragment, or credential material',
    });
  }
});

const publicWorkspaceId = z
  .string()
  .trim()
  .regex(
    /^(?:rw_[a-z0-9]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    { message: 'workspaceId must be a public rw_ identifier or UUID' }
  );

export const BridgeConfigSchema = z
  .object({
    workspaceKey: z.string().trim().min(1),
    baseUrl: relayBaseUrl.optional(),
    channel: channelName,
    workspaceIds: z
      .array(z.string().trim().min(1))
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, 'workspaceIds must not contain duplicates'),
  })
  .strict();

// The room deliberately uses a separate configuration file from the status
// bridge. A room binding is a public workspace identifier, never an rk_live
// workspace key or a Cloud/API credential.
export const RoomConfigSchema = z
  .object({
    workspaceId: publicWorkspaceId,
    relayfileWorkspace: publicWorkspaceId.optional(),
    apiUrl: roomApiUrl.optional(),
  })
  .strict();

export function pluginPaths(environment = process.env) {
  const configDir = environment.HERDR_PLUGIN_CONFIG_DIR;
  const stateDir = environment.HERDR_PLUGIN_STATE_DIR;
  if (!configDir || !stateDir) {
    throw new Error('Herdr did not provide plugin config and state directories');
  }
  return { configDir, stateDir };
}

export function configPath(configDir) {
  return join(configDir, 'agent-relay.json');
}

export function roomConfigPath(configDir) {
  return join(configDir, 'relay-room.json');
}

async function assertPrivateConfigFile(path) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error('Agent Relay plugin configuration must be a regular file');
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('Agent Relay plugin configuration must not be accessible by group or other users');
  }
}

export async function loadBridgeConfig(configDir) {
  return loadConfigFile(configPath(configDir), BridgeConfigSchema, 'Agent Relay bridge');
}

export async function loadRoomConfig(configDir) {
  return loadConfigFile(roomConfigPath(configDir), RoomConfigSchema, 'Relay Room');
}

async function loadConfigFile(path, schema, displayName) {
  try {
    await assertPrivateConfigFile(path);
  } catch (error) {
    if (!error?.code) throw error;
    throw new Error(`Cannot read ${displayName} configuration at ${path}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${displayName} configuration is not valid JSON`);
    }
    throw new Error(`Cannot read ${displayName} configuration at ${path}`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${displayName} configuration is invalid`);
  }
  return result.data;
}

export function redactConfig(config) {
  return { ...config, workspaceKey: '[redacted]' };
}

export function redactRoomConfig(config) {
  return {
    workspaceId: '[bound]',
    ...(config.relayfileWorkspace ? { relayfileWorkspace: '[bound]' } : {}),
    ...(config.apiUrl ? { apiUrl: '[configured]' } : {}),
  };
}
