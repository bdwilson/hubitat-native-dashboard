#!/usr/bin/env node
/**
 * Enforce the importUrl convention borrowed from bdwilson/hubitat.
 *
 *   node build/check-import-url.mjs
 *
 * The rule there, restated for this repo (whose default branch is `main`,
 * not `master`):
 *
 *   Reading a .groovy file's importUrl must tell you exactly which branch that
 *   file currently lives on — never early, never stale, never a leftover from a
 *   previous branch.
 *
 * So:
 *   - On `main`, importUrl MUST point at `main`. This is the guarantee that
 *     matters: whatever is merged is immediately re-importable by every user
 *     who installed via Import or HPM, because the URL they already have
 *     resolves to the code that just landed.
 *   - On a feature branch, importUrl must point at EITHER that same branch
 *     (normal development) OR `main` (the release flip, done inside the PR that
 *     merges the branch — per bdwilson/hubitat, that flip happens exactly once,
 *     as part of the merging PR, never as its own earlier commit).
 *   - Pointing at any OTHER branch is always wrong. That is the failure this
 *     check exists for: importUrl sat on `claude/modifier-syntax-error-188-lkzmfi`
 *     for months after that branch merged, so anyone hitting Import re-fetched
 *     a dead branch instead of current code, and nothing anywhere said so.
 *
 * packageManifest.json's `apps[].location` is held to the same rule, because
 * HPM resolves it at install and update time — a stale location is the same
 * bug wearing different clothes.
 */

import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BRANCH = 'main';
const RAW_PREFIX = 'https://raw.githubusercontent.com/bdwilson/hubitat-native-dashboard/';
const APP_PATH = 'app/HubitatNativeDashboard.groovy';

/**
 * The branch under test. GitHub Actions sets GITHUB_REF_NAME on a push (the
 * branch) and on a pull_request (the PR number, e.g. "42/merge" — not a branch,
 * so fall back to GITHUB_HEAD_REF which is the source branch). Locally, ask git.
 */
function currentBranch() {
  if (process.env.GITHUB_HEAD_REF) return process.env.GITHUB_HEAD_REF;
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Pull the branch segment out of a raw.githubusercontent URL for this repo.
 * Accepts both spellings bdwilson/hubitat allows: `<branch>/<path>` and
 * `refs/heads/<branch>/<path>`. Branch names may contain slashes
 * (`claude/guard-upstream-drift`), so the branch is whatever precedes the known
 * file path rather than "the next segment".
 */
function branchFromUrl(url, filePath) {
  if (!url.startsWith(RAW_PREFIX)) return { error: `does not start with ${RAW_PREFIX}` };
  let rest = url.slice(RAW_PREFIX.length);
  if (rest.startsWith('refs/heads/')) rest = rest.slice('refs/heads/'.length);
  if (!rest.endsWith(`/${filePath}`)) return { error: `does not end with /${filePath}` };
  const branch = rest.slice(0, -`/${filePath}`.length);
  if (!branch) return { error: 'has an empty branch segment' };
  return { branch };
}

function check(label, url, filePath, branch, problems) {
  const { branch: urlBranch, error } = branchFromUrl(url, filePath);
  if (error) {
    problems.push(`${label}\n    ${url}\n    ${error}`);
    return;
  }
  const ok = urlBranch === branch || urlBranch === DEFAULT_BRANCH;
  if (!ok) {
    const allowed =
      branch === DEFAULT_BRANCH
        ? `On ${DEFAULT_BRANCH}, the only allowed value is "${DEFAULT_BRANCH}".`
        : `Allowed here: "${branch}" (development) or "${DEFAULT_BRANCH}" (release flip, in the merging PR).`;
    problems.push(
      `${label}\n` +
        `    points at   : ${urlBranch}\n` +
        `    but lives on: ${branch}\n` +
        `    ${allowed}`,
    );
    return;
  }
  console.log(`  ok  ${label} -> ${urlBranch}`);
}

async function main() {
  const branch = currentBranch();
  if (!branch) {
    console.error('check-import-url: cannot determine the current branch; refusing to guess.');
    process.exit(1);
  }
  console.log(`check-import-url: branch "${branch}"`);

  const problems = [];

  const app = await readFile(path.join(REPO_ROOT, APP_PATH), 'utf8');
  const m = app.match(/importUrl:\s*"([^"]+)"/);
  if (!m) {
    problems.push(`${APP_PATH}\n    no importUrl found in the definition() block`);
  } else {
    check(`${APP_PATH} importUrl`, m[1], APP_PATH, branch, problems);
  }

  const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, 'packageManifest.json'), 'utf8'));
  for (const entry of manifest.apps ?? []) {
    check(`packageManifest.json apps["${entry.name}"].location`, entry.location, APP_PATH, branch, problems);
  }

  if (problems.length) {
    const fix =
      branch === DEFAULT_BRANCH
        ? `  Fix: point these at "${DEFAULT_BRANCH}".`
        : `  Fix: point these at "${branch}", or at "${DEFAULT_BRANCH}" if this is the PR\n` +
          `  that merges the branch.`;
    console.error(
      `\ncheck-import-url FAILED:\n\n  ${problems.join('\n\n  ')}\n\n` +
        `${fix}\n  See "The importUrl rule" in CLAUDE.md.\n`,
    );
    process.exit(1);
  }
  console.log('check-import-url: OK');
}

main().catch((e) => {
  console.error(`check-import-url: ${e.message}`);
  process.exit(1);
});
