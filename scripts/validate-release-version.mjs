import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

function readJson(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  return JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fail(message) {
  console.error(`Release metadata validation failed: ${message}`);
  process.exit(1);
}

const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');
const changelog = readText('CHANGELOG.md');
const packageVersion = packageJson.version;
const expectedTag = `v${packageVersion}`;
const releaseTag = process.env.RELEASE_TAG?.trim();

if (typeof packageVersion !== 'string' || packageVersion.length === 0) {
  fail('package.json must define a non-empty "version" field.');
}

if (packageLock.version !== packageVersion) {
  fail(`package-lock.json version (${packageLock.version ?? 'missing'}) must match package.json version (${packageVersion}).`);
}

if (packageLock.packages?.['']?.version !== packageVersion) {
  fail(
    `package-lock.json packages[""].version (${packageLock.packages?.['']?.version ?? 'missing'}) must match package.json version (${packageVersion}).`
  );
}

const changelogHeadingPattern = new RegExp(`^## \\[${escapeRegExp(packageVersion)}\\](?:\\s|$)`, 'm');
if (!changelogHeadingPattern.test(changelog)) {
  fail(`CHANGELOG.md must include a "## [${packageVersion}]" section before releasing.`);
}

if (releaseTag && releaseTag !== expectedTag) {
  fail(`release tag ${releaseTag} does not match package.json version ${packageVersion}. Expected ${expectedTag}.`);
}

console.log(`Release metadata OK for version ${packageVersion}${releaseTag ? ` (${releaseTag})` : ''}.`);
