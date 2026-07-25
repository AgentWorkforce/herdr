import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
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

export function lockPath(stateDir) {
  return join(stateDir, 'relay-bridge.lock');
}

export function emptyBridgeState() {
  return { transitions: {} };
}

async function prepareStateDirectory(stateDir) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(stateDir, 0o700);
}

async function assertPrivateStateFile(path) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error('Agent Relay bridge state must be a regular file');
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('Agent Relay bridge state must not be accessible by group or other users');
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export async function acquireBridgeLock(stateDir) {
  await prepareStateDirectory(stateDir);
  const target = lockPath(stateDir);
  const nonce = randomUUID();
  let handle;
  try {
    handle = await open(target, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, nonce })}\n`);
    await handle.sync();
  } catch (error) {
    const created = Boolean(handle);
    await handle?.close().catch(() => undefined);
    if (error?.code !== 'EEXIST') {
      if (created) await unlink(target).catch(() => undefined);
      throw error;
    }
    let owner;
    try {
      owner = JSON.parse(await readFile(target, 'utf8'));
    } catch {
      owner = undefined;
    }
    if (Number.isInteger(owner?.pid) && !processIsAlive(owner.pid)) {
      await unlink(target);
      return acquireBridgeLock(stateDir);
    }
    const suffix = Number.isInteger(owner?.pid) ? ` (PID ${owner.pid})` : '';
    throw new Error(
      `Another Agent Relay bridge holds ${target}${suffix}; remove the lock only after verifying that bridge is stopped`
    );
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await handle.close();
      let owner;
      try {
        owner = JSON.parse(await readFile(target, 'utf8'));
      } catch {
        return;
      }
      if (owner?.nonce === nonce) {
        await unlink(target).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
      }
    },
  };
}

export async function loadBridgeState(stateDir) {
  const target = statePath(stateDir);
  try {
    await assertPrivateStateFile(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyBridgeState();
    if (!error?.code) throw error;
    throw new Error('Cannot read Agent Relay bridge state');
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
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
  await prepareStateDirectory(stateDir);
  const target = statePath(stateDir);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  await chmod(target, 0o600);
}
