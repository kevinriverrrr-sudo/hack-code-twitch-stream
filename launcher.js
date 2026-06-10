// Launcher that spawns all-in-one.js as a detached, long-lived process
const { spawn } = require('child_process');
const fs = require('fs');

const log = fs.openSync('/home/z/my-project/stream-output.log', 'w');
const child = spawn('node', ['all-in-one.js'], {
  cwd: '/home/z/my-project',
  detached: true,
  stdio: ['ignore', log, log],
});

child.unref();

console.log('Launched all-in-one.js as detached process, PID:', child.pid);
console.log('Log file: /home/z/my-project/stream-output.log');
