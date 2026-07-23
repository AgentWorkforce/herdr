import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

const TransitionSchema = z.object({
  fingerprint: z.string().min(1),
  sequence: z.number().int().positive(),
});

const BridgeStateSchema = z
  .object({
    apiToken: z.string().min(1).optional(),
    transitions: z.record(z.string(), TransitionSchema).default({}),
  })
  .strict();

export function statePath(stateDir) {
  return join(stateDir, 'relay-state.json');
}

export function emptyBridgeState() {
  return { transitions: {} };
}

export async function loadBridgeState(stateDir) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(statePath(stateDir), 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyBridgeState();
    if (error instanceof SyntaxError) {
      throw new Error('Agent Relay bridge state is not valid JSON');
    }
    throw new Error('Cannot read Agent Relay bridge state');
  }

  const result = BridgeStateSchema.safeParse(parsed);
  if (!result.success) throw new Error('Agent Relay bridge state is invalid');
  return result.data;
}

export async function saveBridgeState(stateDir, state) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const target = statePath(stateDir);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  await chmod(target, 0o600);
}
