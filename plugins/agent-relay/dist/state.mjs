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

const RelayfileMountSchema = z
  .object({
    relayfileWorkspace: z.string().min(1),
    checkoutPath: z.string().min(1),
    mountPath: z.string().min(1),
    active: z.boolean().default(false),
  })
  .strict();

const RoomSessionIntentSchema = z
  .object({
    deviceId: z.string().min(1),
  })
  .strict();

const RoomSessionCleanupSchema = z
  .object({
    needed: z.literal(true),
    deviceId: z.string().min(1),
    reason: z.enum(['new-session', 'reset-session', 'persist-failure']),
  })
  .strict();

const RoomStateSchema = z
  .object({
    workspaceId: z.string().min(1),
    sessionIntent: RoomSessionIntentSchema.optional(),
    sessionCleanup: RoomSessionCleanupSchema.optional(),
    relayfileMount: RelayfileMountSchema.optional(),
  })
  .strict();

export function statePath(stateDir) {
  return join(stateDir, 'relay-state.json');
}

export function lockPath(stateDir) {
  return join(stateDir, 'relay-bridge.lock');
}

export function roomStatePath(stateDir) {
  return join(stateDir, 'relay-room-state.json');
}

export function roomLockPath(stateDir) {
  return join(stateDir, 'relay-room.lock');
}

export function emptyBridgeState() {
  return { transitions: {} };
}

export function emptyRoomState() {
  return undefined;
}

async function prepareStateDirectory(stateDir) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(stateDir, 0o700);
}

async function assertPrivateStateFile(path) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error('Agent Relay plugin state must be a regular file');
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error('Agent Relay plugin state must not be accessible by group or other users');
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

async function acquireProcessLock(stateDir, target, displayName) {
  await prepareStateDirectory(stateDir);
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
      return acquireProcessLock(stateDir, target, displayName);
    }
    const suffix = Number.isInteger(owner?.pid) ? ` (PID ${owner.pid})` : '';
    throw new Error(
      `Another ${displayName} holds ${target}${suffix}; remove the lock only after verifying that process is stopped`
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

export function acquireBridgeLock(stateDir) {
  return acquireProcessLock(stateDir, lockPath(stateDir), 'Agent Relay bridge');
}

export function acquireRoomLock(stateDir) {
  return acquireProcessLock(stateDir, roomLockPath(stateDir), 'Relay Room');
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
  await savePrivateState(statePath(stateDir), stateDir, state);
}

export async function loadRoomState(stateDir) {
  const target = roomStatePath(stateDir);
  try {
    await assertPrivateStateFile(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyRoomState();
    if (!error?.code) throw error;
    throw new Error('Cannot read Relay Room state');
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Relay Room state is not valid JSON');
    throw new Error('Cannot read Relay Room state');
  }
  const result = RoomStateSchema.safeParse(parsed);
  if (!result.success) throw new Error('Relay Room state is invalid');
  return result.data;
}

export async function bindRoomWorkspace(stateDir, configuredWorkspaceId) {
  const state = await loadRoomState(stateDir);
  if (state && state.workspaceId !== configuredWorkspaceId) {
    // Do not reveal either binding. Changing rooms must be an intentional local
    // recovery step, not an accidental config switch while a pane is open.
    throw new Error('Relay Room is already bound to a different workspace');
  }
  if (state) return state;
  const next = { workspaceId: configuredWorkspaceId };
  await saveRoomState(stateDir, next);
  return next;
}

export async function saveRoomState(stateDir, state) {
  const result = RoomStateSchema.safeParse(state);
  if (!result.success) throw new Error('Relay Room state is invalid');
  await savePrivateState(roomStatePath(stateDir), stateDir, result.data);
}

export async function setRoomSessionIntent(stateDir, deviceId) {
  const state = await loadRoomState(stateDir);
  if (!state) throw new Error('Relay Room must bind a workspace before saving a session');
  const next = { ...state, sessionIntent: { deviceId } };
  await saveRoomState(stateDir, next);
  return next;
}

export async function clearRoomSessionIntent(stateDir) {
  const state = await loadRoomState(stateDir);
  if (!state?.sessionIntent) return state;
  const { sessionIntent: _discarded, ...next } = state;
  await saveRoomState(stateDir, next);
  return next;
}

export async function markRoomSessionCleanup(stateDir, deviceId, reason) {
  const state = await loadRoomState(stateDir);
  if (!state) throw new Error('Relay Room must bind a workspace before recording cleanup');
  const next = {
    ...state,
    sessionCleanup: { needed: true, deviceId, reason },
  };
  await saveRoomState(stateDir, next);
  return next;
}

export async function clearRoomSessionCleanup(stateDir) {
  const state = await loadRoomState(stateDir);
  if (!state?.sessionCleanup) return state;
  const { sessionCleanup: _discarded, ...next } = state;
  await saveRoomState(stateDir, next);
  return next;
}

/**
 * Reserve one exact Relayfile mount before starting its daemon. Inactive
 * records preserve ownership of a non-empty .integrations directory; active
 * records force the next pane to health-check and stop stale daemons first.
 */
export async function claimRoomMount(stateDir, mount) {
  const validMount = RelayfileMountSchema.safeParse({ ...mount, active: true });
  if (!validMount.success) throw new Error('Relayfile mount state is invalid');
  const state = await loadRoomState(stateDir);
  if (!state) throw new Error('Relay Room must bind a workspace before mounting Relayfile');
  const existing = state.relayfileMount;
  if (existing) {
    if (
      existing.relayfileWorkspace === validMount.data.relayfileWorkspace &&
      existing.checkoutPath === validMount.data.checkoutPath &&
      existing.mountPath === validMount.data.mountPath
    ) {
      if (existing.active) {
        throw new Error('Relayfile mount state is already active');
      }
      const next = { ...state, relayfileMount: { ...existing, active: true } };
      await saveRoomState(stateDir, next);
      return { reused: true, state: next };
    }
    throw new Error('Relayfile is already mounted for this Relay Room; refusing to rehome it implicitly');
  }
  const next = { ...state, relayfileMount: validMount.data };
  await saveRoomState(stateDir, next);
  return { reused: false, state: next };
}

export async function deactivateRoomMount(stateDir, mount) {
  const state = await loadRoomState(stateDir);
  if (!state?.relayfileMount) return;
  const existing = state.relayfileMount;
  if (
    existing.relayfileWorkspace !== mount.relayfileWorkspace ||
    existing.checkoutPath !== mount.checkoutPath ||
    existing.mountPath !== mount.mountPath
  ) {
    return;
  }
  const next = { ...state, relayfileMount: { ...existing, active: false } };
  await saveRoomState(stateDir, next);
}

async function savePrivateState(target, stateDir, state) {
  await prepareStateDirectory(stateDir);
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  await chmod(target, 0o600);
}
