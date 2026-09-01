import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const allowedFiles = new Set([
  '.gitignore',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'VERSION',
  'package-lock.json',
  'package.json',
  'tools/render-original.py',
  'tsconfig.json',
]);
const allowedPrefixes = ['.agents/', '.codex-plugin/', '.github/', 'docs/', 'scripts/', 'skills/', 'src/', 'test/'];

function gitLines(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    console.log('public tree check: skipped outside a Git worktree');
    process.exit(0);
  }
}

const tracked = gitLines(['ls-files', '--cached']).filter((file) => existsSync(file));
const untracked = gitLines(['ls-files', '--others', '--exclude-standard']);
const publicTree = [...new Set([...tracked, ...untracked])];
const outsideBoundary = publicTree.filter(
  (file) => !allowedFiles.has(file) && !allowedPrefixes.some((prefix) => file.startsWith(prefix)),
);
const ignoredButTracked = gitLines(['ls-files', '-ci', '--exclude-standard']).filter((file) => existsSync(file));
const documentationFiles = publicTree.filter((file) => (
  file === 'README.md'
  || file === 'package.json'
  || file.startsWith('docs/')
  || /^skills\/process-model-generator\/.*\.(?:md|ya?ml|flow)$/.test(file)
) && /\.(?:json|md|svg|ya?ml|flow)$/.test(file));
const nonEnglishDocumentation = documentationFiles.filter((file) => (
  /[ぁ-んァ-ヶ一-龯]/u.test(readFileSync(file, 'utf8'))
));
const violations = [...new Set([...outsideBoundary, ...ignoredButTracked])].sort();

if (violations.length > 0) {
  console.error('Public tree contains files outside the approved boundary:');
  for (const file of violations) console.error(`- ${file}`);
  process.exit(1);
}

if (nonEnglishDocumentation.length > 0) {
  console.error('Public documentation must be English-only:');
  for (const file of nonEnglishDocumentation) console.error(`- ${file}`);
  process.exit(1);
}

console.log(`public tree check: ${publicTree.length} files within approved boundary`);
