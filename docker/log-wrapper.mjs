import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

const [logPath, command, ...args] = process.argv.slice(2);
if (!logPath || !command) {
  console.error("Usage: log-wrapper.mjs <log-path> <command> [...args]");
  process.exit(64);
}

mkdirSync(dirname(logPath), { recursive: true });
const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
const child = spawn(command, args, {
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});

child.stdout.pipe(process.stdout);
child.stdout.pipe(log, { end: false });
child.stderr.pipe(process.stderr);
child.stderr.pipe(log, { end: false });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(error);
  log.end(() => { process.exitCode = 1; });
});

child.on("exit", (code, signal) => {
  log.end(() => {
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
});
