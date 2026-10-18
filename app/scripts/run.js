import { spawn } from 'node:child_process';

// Runs a command (pg_dump, pg_restore) and rejects with its error output if it fails.
export function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', (error) =>
      reject(error.code === 'ENOENT' ? new Error(`${command} is not installed (PostgreSQL client tools are needed).`) : error),
    );
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`))));
  });
}
