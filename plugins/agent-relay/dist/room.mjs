import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { createCommandRunner, redactSensitiveText } from './command-runner.mjs';
import { RelayRoomController } from './room-client.mjs';

async function main() {
  const room = await RelayRoomController.create({ runner: createCommandRunner() });
  const terminal = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    terminal.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  if (process.platform !== 'win32') process.once('SIGHUP', stop);
  stdout.write('Relay Room ready. Start a chat session or configure Relayfile writeback. Type help for controls.\n');
  try {
    while (!stopping) {
      let line;
      try {
        line = await terminal.question('relay-room> ');
      } catch (error) {
        if (stopping && error?.code === 'ERR_USE_AFTER_CLOSE') break;
        throw error;
      }
      if (['exit', 'quit'].includes(line.trim().toLowerCase())) break;
      try {
        const output = await room.execute(line);
        if (output) stdout.write(`${output}\n`);
      } catch (error) {
        // Command output and CLI errors are already sanitized by the control
        // client, but redacting here keeps the terminal boundary fail-closed.
        stdout.write(`Error: ${redactSensitiveText(error?.message || 'Relay Room command failed')}\n`);
      }
    }
  } finally {
    terminal.close();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (process.platform !== 'win32') process.off('SIGHUP', stop);
    await room.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    stdout.write(`Relay Room failed: ${redactSensitiveText(error?.message || 'startup failed')}\n`);
    process.exitCode = 1;
  });
}
