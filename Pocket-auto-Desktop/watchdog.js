'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_RESTARTS = 5;
const BASE_DELAY_MS = 5000;
const electronModule = require('electron');
const electronExe = typeof electronModule === 'string'
  ? electronModule
  : path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');

let restartCount = 0;
let child = null;
let stopping = false;
let restartQueued = false;

function launch() {
  if (stopping) return;

  console.log('[watchdog] Starting Pocket Tracker Desktop...');
  const startedAt = Date.now();
  child = spawn(electronExe, ['.'], {
    cwd: __dirname,
    stdio: 'inherit',
    windowsHide: false,
    env: { ...process.env, PT_WATCHDOG: '1' }
  });

  child.once('error', error => {
    console.error('[watchdog] Electron launch failed:', error);
    scheduleRestart(1);
  });

  child.once('exit', (code, signal) => {
    child = null;
    if (stopping) return;

    if (Date.now() - startedAt >= 10 * 60 * 1000) {
      restartCount = 0;
    }

    if (code === 0) {
      console.log('[watchdog] App closed normally. Watchdog stopped.');
      process.exit(0);
      return;
    }

    console.error('[watchdog] Electron exited unexpectedly. code=', code, 'signal=', signal);
    scheduleRestart(code);
  });
}

function scheduleRestart(code) {
  if (stopping || restartQueued) return;

  restartQueued = true;
  restartCount += 1;
  if (restartCount > MAX_RESTARTS) {
    console.error('[watchdog] Restart limit reached. Last exit code:', code);
    process.exit(typeof code === 'number' ? code : 1);
    return;
  }

  const delay = Math.min(30000, BASE_DELAY_MS * Math.pow(2, restartCount - 1));
  console.error('[watchdog] Restart ' + restartCount + '/' + MAX_RESTARTS +
    ' in ' + Math.round(delay / 1000) + ' seconds...');
  setTimeout(() => {
    restartQueued = false;
    launch();
  }, delay);
}

function stop(signal) {
  stopping = true;
  if (child && !child.killed) {
    try { child.kill(signal); } catch (_) {}
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

launch();
