#!/usr/bin/env node

const { runCommand } = require('./cli-commands');
const taskPaths = require('./task-paths');

async function runCli(argv, deps = {}) {
  const args = Array.isArray(argv) ? argv : [];
  const command = args[0] || 'help';
  return runCommand(command, {
    projectRoot: deps.projectRoot || process.env.LOOPI_PROJECT_ROOT || taskPaths.getProjectRoot(),
    ...deps,
    args: args.slice(1)
  });
}

async function main() {
  const handleSigint = () => {
    console.error('CLI cancelled.');
    process.exit(130);
  };

  process.once('SIGINT', handleSigint);
  try {
    const exitCode = await runCli(process.argv.slice(2));
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', handleSigint);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runCli
};
