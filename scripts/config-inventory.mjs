#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const roots = ['packages'];
const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'coverage']);
const ignoredExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf']);

const patterns = [
  { name: 'DSN-specific value', re: /\b(?:dsn\.com|dsnsoft|dsn-diwan-|DSN-|DSNPAYMVP|mfox-dsn)\b/i },
  { name: 'AWS SDK import', re: /from\s+['"]@aws-sdk\/|require\(['"]@aws-sdk\// },
  { name: 'AWS endpoint', re: /amazonaws\.com/i },
  { name: 'AWS credential env', re: /\bAWS_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|REGION)\b/ },
  { name: 'hardcoded private key marker', re: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
  { name: 'inline password assignment', re: /\bpassword\s*=\s*['"][^'"]+['"]/i },
];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
      continue;
    }
    if (!entry.isFile()) continue;
    if (ignoredExts.has(entry.name.slice(entry.name.lastIndexOf('.')))) continue;
    yield path;
  }
}

const findings = [];

for (const root of roots) {
  try {
    await stat(root);
  } catch {
    continue;
  }

  for await (const file of walk(root)) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }

    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const pattern of patterns) {
        if (pattern.re.test(line)) {
          findings.push({
            file: relative(process.cwd(), file),
            line: index + 1,
            name: pattern.name,
          });
        }
      }
    }
  }
}

if (findings.length === 0) {
  console.log('Config inventory: no DSN/AWS/secret pattern findings.');
  process.exit(0);
}

console.warn('Config inventory warnings. These become hard failures after Phase 2 neutralization:');
for (const finding of findings) {
  console.warn(`- ${finding.file}:${finding.line} ${finding.name}`);
}
