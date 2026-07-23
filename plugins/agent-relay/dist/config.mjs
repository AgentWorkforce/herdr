import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

const channelName = z.string().trim().regex(/^#[A-Za-z0-9][A-Za-z0-9_-]*$/, {
  message: 'channel must be a #channel-name',
});

export const BridgeConfigSchema = z
  .object({
    workspaceKey: z.string().trim().min(1),
    baseUrl: z.string().url().optional(),
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

export async function loadBridgeConfig(configDir) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath(configDir), 'utf8'));
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
