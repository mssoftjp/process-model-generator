#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION_FILE = join(ROOT, 'VERSION');
const PACKAGE_FILE = join(ROOT, 'package.json');
const LOCK_FILE = join(ROOT, 'package-lock.json');
const PLUGIN_FILE = join(ROOT, '.codex-plugin', 'plugin.json');
const SKILL_ROOT = 'skills/process-model-generator';
const DEFAULT_OUTPUT_DIR = join(ROOT, 'dist');
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const SKILL_FILES = [
  'SKILL.md',
  'agents/openai.yaml',
  'references/dsl-advanced.md',
  'references/audit-patterns.md',
  'references/engine-maintenance.md',
  'references/translation-sources.md',
  'references/consulting-workflow.md',
  'scripts/bpmn2flow.py',
  'scripts/process-model-generator.mjs',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function atomicWrite(path, contents) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, contents);
  renameSync(temporary, path);
}

function writeJson(path, value) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function parseVersion(value) {
  const match = VERSION_RE.exec(value);
  if (!match) {
    throw new Error(`version must match X.Y.Z or X.Y.Z-prerelease, got ${JSON.stringify(value)}`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  };
}

function compareIdentifiers(left, right) {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : undefined;
  const rightNumber = /^\d+$/.test(right) ? Number(right) : undefined;
  if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
  if (leftNumber !== undefined) return -1;
  if (rightNumber !== undefined) return 1;
  return left.localeCompare(right);
}

export function compareVersions(leftValue, rightValue) {
  const left = parseVersion(leftValue);
  const right = parseVersion(rightValue);
  for (const key of ['major', 'minor', 'patch']) {
    const difference = left[key] - right[key];
    if (difference !== 0) return difference;
  }
  if (!left.prerelease && !right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  const leftParts = left.prerelease.split('.');
  const rightParts = right.prerelease.split('.');
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    if (leftParts[index] === undefined) return -1;
    if (rightParts[index] === undefined) return 1;
    const difference = compareIdentifiers(leftParts[index], rightParts[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function nextVersion(currentValue, target) {
  const current = parseVersion(currentValue);
  if (['major', 'minor', 'patch'].includes(target)) {
    if (current.prerelease) {
      throw new Error('automatic bumps from a prerelease are ambiguous; provide the exact target version');
    }
    if (target === 'major') return `${current.major + 1}.0.0`;
    if (target === 'minor') return `${current.major}.${current.minor + 1}.0`;
    return `${current.major}.${current.minor}.${current.patch + 1}`;
  }
  parseVersion(target);
  if (compareVersions(target, currentValue) <= 0) {
    throw new Error(`target version must be newer than ${currentValue}, got ${target}`);
  }
  return target;
}

export function readCanonicalVersion() {
  const version = readFileSync(VERSION_FILE, 'utf8').trim();
  parseVersion(version);
  return version;
}

export function checkVersionSync(expectedValue) {
  const version = readCanonicalVersion();
  const expected = expectedValue?.replace(/^v/, '');
  const packageJson = readJson(PACKAGE_FILE);
  const packageLock = readJson(LOCK_FILE);
  const plugin = readJson(PLUGIN_FILE);
  const versions = new Map([
    ['VERSION', version],
    ['package.json', packageJson.version],
    ['package-lock.json', packageLock.version],
    ['package-lock.json root package', packageLock.packages?.['']?.version],
    ['.codex-plugin/plugin.json', plugin.version],
  ]);
  if (expected) versions.set('expected release version', expected);

  const mismatches = [...versions].filter(([, candidate]) => candidate !== version);
  if (mismatches.length > 0) {
    const details = mismatches.map(([label, candidate]) => `${label}=${JSON.stringify(candidate)}`).join(', ');
    throw new Error(`version mismatch: canonical VERSION=${version}; ${details}`);
  }
  return version;
}

export function synchronizeVersion(version) {
  parseVersion(version);
  const packageJson = readJson(PACKAGE_FILE);
  const packageLock = readJson(LOCK_FILE);
  const plugin = readJson(PLUGIN_FILE);
  packageJson.version = version;
  packageLock.version = version;
  if (!packageLock.packages?.['']) throw new Error('package-lock.json is missing its root package');
  packageLock.packages[''].version = version;
  plugin.version = version;
  atomicWrite(VERSION_FILE, `${version}\n`);
  writeJson(PACKAGE_FILE, packageJson);
  writeJson(LOCK_FILE, packageLock);
  writeJson(PLUGIN_FILE, plugin);
  checkVersionSync(version);
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  CRC_TABLE[index] = value >>> 0;
}

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

function validateArchivePath(path) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
    throw new Error(`unsafe ZIP path: ${JSON.stringify(path)}`);
  }
}

export function createZip(entries) {
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path));
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of sorted) {
    validateArchivePath(entry.path);
    const name = Buffer.from(entry.path, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    const mode = entry.mode ?? 0o644;
    central.writeUInt32LE(((0o100000 | mode) * 0x10000) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function readZipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const expectedCrc = buffer.readUInt32LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    if (flags !== 0x0800 || method !== 0 || compressedSize !== uncompressedSize) {
      throw new Error('unsupported ZIP entry encoding in generated archive');
    }
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error('truncated ZIP entry');
    const path = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const data = buffer.subarray(dataStart, dataEnd);
    validateArchivePath(path);
    if (entries.has(path)) throw new Error(`duplicate ZIP entry: ${path}`);
    if (crc32(data) !== expectedCrc) throw new Error(`ZIP CRC mismatch: ${path}`);
    entries.set(path, Buffer.from(data));
    offset = dataEnd;
  }
  if (entries.size === 0 || buffer.readUInt32LE(offset) !== 0x02014b50) {
    throw new Error('generated archive is missing its central directory');
  }
  return entries;
}

function sourceEntry(sourcePath, archivePath) {
  const absolute = join(ROOT, sourcePath);
  const mode = statSync(absolute).mode & 0o111 ? 0o755 : 0o644;
  return { path: archivePath, data: readFileSync(absolute), mode };
}

export function releaseArchives() {
  const version = checkVersionSync();
  const skillEntries = [
    sourceEntry('VERSION', 'VERSION'),
    sourceEntry('LICENSE', 'LICENSE'),
    ...SKILL_FILES.map((path) => sourceEntry(`${SKILL_ROOT}/${path}`, path)),
  ];
  const pluginEntries = [
    sourceEntry('.codex-plugin/plugin.json', '.codex-plugin/plugin.json'),
    sourceEntry('LICENSE', 'LICENSE'),
    ...SKILL_FILES.map((path) => sourceEntry(`${SKILL_ROOT}/${path}`, `${SKILL_ROOT}/${path}`)),
  ];
  const skillZip = createZip(skillEntries);
  const pluginZip = createZip(pluginEntries);
  const skillName = `process-model-generator-skill-${version}.zip`;
  const pluginName = `process-model-generator-plugin-${version}.zip`;

  const skillContents = readZipEntries(skillZip);
  const pluginContents = readZipEntries(pluginZip);
  if (!skillContents.has('SKILL.md')) throw new Error('standalone skill archive is missing SKILL.md at its root');
  if (!pluginContents.has('.codex-plugin/plugin.json')) throw new Error('plugin archive is missing plugin.json');
  if (!pluginContents.has('skills/process-model-generator/SKILL.md')) throw new Error('plugin archive is missing its bundled skill');
  const packagedPlugin = JSON.parse(pluginContents.get('.codex-plugin/plugin.json').toString('utf8'));
  if (packagedPlugin.version !== version) throw new Error('packaged plugin version does not match VERSION');

  return new Map([
    [skillName, skillZip],
    [pluginName, pluginZip],
  ]);
}

export function createReleaseArtifacts(outputDirectory = DEFAULT_OUTPUT_DIR) {
  const archives = releaseArchives();
  mkdirSync(outputDirectory, { recursive: true });
  const checksumLines = [];
  for (const [name, data] of archives) {
    writeFileSync(join(outputDirectory, name), data);
    const hash = createHash('sha256').update(data).digest('hex');
    checksumLines.push(`${hash}  ${name}`);
  }
  checksumLines.sort();
  writeFileSync(join(outputDirectory, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`);
  return { outputDirectory, files: [...archives.keys(), 'SHA256SUMS'] };
}

function run(command, args) {
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });
}

function outputDirectoryFrom(args) {
  const index = args.indexOf('--output-dir');
  if (index < 0) return DEFAULT_OUTPUT_DIR;
  const value = args[index + 1];
  if (!value) throw new Error('--output-dir requires a path');
  return resolve(ROOT, value);
}

function printArtifacts(result) {
  for (const file of result.files) console.log(join(result.outputDirectory, file));
}

function main() {
  const [command = 'package', ...args] = process.argv.slice(2);
  if (command === 'show') {
    console.log(readCanonicalVersion());
    return;
  }
  if (command === 'check') {
    console.log(`version ${checkVersionSync(args[0])} is synchronized`);
    return;
  }
  if (command === 'package') {
    run(process.execPath, [join(ROOT, 'scripts', 'build.mjs')]);
    checkVersionSync();
    printArtifacts(createReleaseArtifacts(outputDirectoryFrom(args)));
    return;
  }
  if (command === 'prepare') {
    const target = args[0];
    if (!target) throw new Error('usage: node scripts/release.mjs prepare <patch|minor|major|X.Y.Z>');
    const current = readCanonicalVersion();
    const version = nextVersion(current, target);
    synchronizeVersion(version);
    console.log(`version ${current} -> ${version}`);
    run(process.execPath, [join(ROOT, 'scripts', 'build.mjs')]);
    run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['test']);
    printArtifacts(createReleaseArtifacts(DEFAULT_OUTPUT_DIR));
    console.log(`release candidate v${version} is ready for review; commit and tag it only after approval`);
    return;
  }
  throw new Error(`unknown release command: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
