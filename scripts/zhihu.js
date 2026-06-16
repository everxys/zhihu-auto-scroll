#!/usr/bin/env node
const { spawn } = require('node:child_process');
const path = require('node:path');

const COMMANDS = {
  login: 'zhihu-login.js',
  'auth-check': 'zhihu-auth-check.js',
  archive: 'zhihu-archive.js',
};

const HELP = `
Usage:
  zhihu <command> [options]

Commands:
  login        Open a browser for manual login and save auth state under .auth/zhihu.storageState.json.
  auth-check   Check whether the saved Zhihu auth state is usable.
  archive      Archive Zhihu question pages as single-file HTML.

Examples:
  zhihu login
  zhihu auth-check --url https://www.zhihu.com/question/286130359
  zhihu archive --url https://www.zhihu.com/question/286130359 --comments

Subcommand help:
  zhihu login --help
  zhihu auth-check --help
  zhihu archive --help
`.trim();

function printHelp() {
  console.log(HELP);
}

function main() {
  const [, , command, ...args] = process.argv;
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  const script = COMMANDS[command];
  if (!script) {
    console.error(`Unknown command: ${command}`);
    console.error('Run zhihu --help to see available commands.');
    process.exitCode = 1;
    return;
  }

  const child = spawn(process.execPath, [path.join(__dirname, script), ...args], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  child.on('error', error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
  child.on('close', code => {
    process.exitCode = code;
  });
}

main();
