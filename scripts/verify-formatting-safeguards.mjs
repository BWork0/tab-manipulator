import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installScript = join(projectRoot, 'scripts', 'install-git-hooks.mjs');
const lintStagedScript = join(projectRoot, 'node_modules', 'lint-staged', 'bin', 'lint-staged.js');
const temporaryRoot = mkdtempSync(join(tmpdir(), 'tab-manipulator-formatting-'));

function run(command, args, cwd, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: environment,
    stdio: 'pipe',
  });

  assert.equal(
    result.status,
    0,
    [`Command failed: ${command} ${args.join(' ')}`, result.stdout.trim(), result.stderr.trim()]
      .filter(Boolean)
      .join('\n'),
  );

  return result.stdout;
}

try {
  const nonRepository = join(temporaryRoot, 'non-repository');
  mkdirSync(nonRepository);

  const skippedOutput = run(process.execPath, [installScript], nonRepository);
  assert.match(
    skippedOutput,
    /Skipping Git hook installation because this directory is not a Git repository\./,
  );

  const repository = join(temporaryRoot, 'repository');
  mkdirSync(repository);
  run('git', ['init', '--quiet'], repository);

  const configuredOutput = run(process.execPath, [installScript], repository);
  assert.match(configuredOutput, /Configured Git to use hooks from \.githooks\./);
  assert.equal(run('git', ['config', '--get', 'core.hooksPath'], repository).trim(), '.githooks');

  assert.ok(
    existsSync(lintStagedScript),
    'Run pnpm install before verifying formatting safeguards.',
  );

  writeFileSync(
    join(repository, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        'lint-staged': {
          '*.{js,ts}': 'prettier --write',
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(repository, 'staged.ts'), 'export const staged={value:true}\n');
  writeFileSync(join(repository, 'unstaged.ts'), 'export const unstaged={value:false}\n');
  run('git', ['add', 'staged.ts'], repository);

  const executablePath = join(projectRoot, 'node_modules', '.bin');
  run(process.execPath, [lintStagedScript], repository, {
    ...process.env,
    PATH: `${executablePath}${delimiter}${process.env.PATH ?? ''}`,
  });

  const formattedStagedFile = 'export const staged = { value: true };\n';
  assert.equal(readFileSync(join(repository, 'staged.ts'), 'utf8'), formattedStagedFile);
  assert.equal(run('git', ['show', ':staged.ts'], repository), formattedStagedFile);
  assert.equal(
    readFileSync(join(repository, 'unstaged.ts'), 'utf8'),
    'export const unstaged={value:false}\n',
  );

  console.log('Formatting safeguard verification passed.');
} finally {
  const resolvedTemporaryRoot = resolve(temporaryRoot);
  const expectedPrefix = `${resolve(tmpdir())}${sep}`;

  assert.ok(
    resolvedTemporaryRoot.startsWith(expectedPrefix) &&
      resolvedTemporaryRoot.includes('tab-manipulator-formatting-'),
    `Refusing to remove unexpected temporary path: ${resolvedTemporaryRoot}`,
  );
  rmSync(resolvedTemporaryRoot, { force: true, recursive: true });
}
