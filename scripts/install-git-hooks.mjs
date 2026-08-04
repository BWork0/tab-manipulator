import { spawnSync } from 'node:child_process';

const repositoryCheck = spawnSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
  stdio: 'pipe',
});

if (repositoryCheck.status !== 0) {
  console.log('Skipping Git hook installation because this directory is not a Git repository.');
  process.exit(0);
}

const hookConfiguration = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
  encoding: 'utf8',
  stdio: 'pipe',
});

if (hookConfiguration.status !== 0) {
  const details = hookConfiguration.stderr.trim();
  console.error(`Failed to configure the Git hooks path.${details ? ` ${details}` : ''}`);
  process.exit(hookConfiguration.status ?? 1);
}

console.log('Configured Git to use hooks from .githooks.');
