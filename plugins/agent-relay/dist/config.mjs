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

async function assertPrivateConfigFile(path) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error('Agent Relay bridge configuration must be a regular file');
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('Agent Relay bridge configuration must not be accessible by group or other users');
  }
}

export async function loadBridgeConfig(configDir) {
  const path = configPath(configDir);
  try {
    await assertPrivateConfigFile(path);
  } catch (error) {
    if (!error?.code) throw error;
    throw new Error(`Cannot read Agent Relay bridge configuration at ${path}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Agent Relay bridge configuration is not valid JSON');
    }
    throw new Error(`Cannot read Agent Relay bridge configuration at ${configPath(configDir)}`);
  }

  const result = BridgeConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error('Agent Relay bridge configuration is invalid');
  }
  return result.data;
}

export function redactConfig(config) {
  return { ...config, workspaceKey: '[redacted]' };
}
