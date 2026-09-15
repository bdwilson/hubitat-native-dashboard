#!/usr/bin/env node
/**
 * Enforce the importUrl convention borrowed from bdwilson/hubitat, across
 * EVERY self-referencing raw URL in the repo.
 *
 *   node build/check-import-url.mjs
 *
 * The rule there, restated for this repo (whose default branch is `main`,
 * not `master`):
 *
 *   Reading a branch-pinned URL must tell you exactly which branch the thing it
 *   points at currently lives on — never early, never stale, never a leftover
 *   from a previous branch.
 *
 * So:
 *   - On `main`, these MUST point at `main`. This is the guarantee that
 *     matters: whatever is merged is immediately re-importable by every user
 *     who installed via Import or HPM, and the running app fetches UI files
 *     that actually exist.
 *   - On a feature branch, they must point at EITHER that same branch (normal
 *     development) OR `main` (the release flip, done inside the PR that merges
 *     the branch — per bdwilson/hubitat, exactly once, never as an earlier
 *     standalone commit).
 *   - Pointing at any OTHER branch is always wrong.
 *
 * WHY THIS SCANS RATHER THAN CHECKS A LIST. The first version of this file
 * checked two known sites: the app's importUrl and packageManifest.json's
 * location. It passed green while `defaultUiSourceUrl()` — the URL the running
 * app fetches its UI files from, and so the one with the largest blast radius —
 * still pointed at a branch that had merged months earlier. Enumerating known
 * sites cannot catch an unknown one, which is the same lesson GUARDS encode for
 * upstream drift. So: walk every tracked file, match every URL into this repo,
 * and check them all. A fourth site cannot hide.
 */

import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BRANCH = 'main';
const REPO_SLUG = 'bdwilson/hubitat-native-dashboard';
const RAW_PREFIX = `https://raw.githubusercontent.com/${REPO_SLUG}/`;

/**
 * Matches a raw URL into this repo that actually pins something — the trailing
 * `[^\s"'`),]+` requires at least one path character after the prefix, so the
 * bare prefix constant in this very file is not itself flagged.
 */
const URL_RE = new RegExp(
  `https://raw\\.githubusercontent\\.com/${REPO_SLUG.replace('/', '\\/')}/([^\\s"'\`),]+)`,
  'g',
);

/**
 * The branch under test. GitHub Actions sets GITHUB_REF_NAME on a push (the
 * branch) and on a pull_request (the PR number, e.g. "42/merge" — not a branch,
 * so prefer GITHUB_HEAD_REF, which is the source branch). Locally, ask git.
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
 * Allowed URL prefixes for a branch. Checking by PREFIX rather than parsing a
 * branch out of the URL is deliberate: branch names contain slashes
 * (`claude/guard-upstream-drift`) and the pinned path may be a file *or* a
 * directory (`/dist`), so there is no unambiguous way to split one from the
 * other. Prefix matching sidesteps that entirely.
 */
function allowedPrefixes(branch) {
  const forms = (b) => [`${RAW_PREFIX}${b}/`, `${RAW_PREFIX}refs/heads/${b}/`];
  const out = forms(DEFAULT_BRANCH);
  if (branch !== DEFAULT_BRANCH) out.unshift(...forms(branch));
  return out;
}

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

async function main() {
  const branch = currentBranch();
  if (!branch) {
    console.error('check-import-url: cannot determine the current branch; refusing to guess.');
    process.exit(1);
  }
  const allowed = allowedPrefixes(branch);
  console.log(`check-import-url: branch "${branch}"`);

  const problems = [];
  let found = 0;

  for (const rel of trackedFiles()) {
    let text;
    try {
      text = await readFile(path.join(REPO_ROOT, rel), 'utf8');
    } catch {
      continue; // unreadable or binary — nothing to pin in it
    }
    if (!text.includes(RAW_PREFIX)) continue;

    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(URL_RE)) {
        const url = m[0];
        found++;
        if (allowed.some((p) => url.startsWith(p))) {
          console.log(`  ok  ${rel}:${i + 1}`);
        } else {
          problems.push(`${rel}:${i + 1}\n    ${url}`);
        }
      }
    });
  }

  if (!found) {
    console.error(
      'check-import-url: no self-referencing raw URLs found at all.\n' +
        '  That is almost certainly a bug in this checker (a moved file, a changed\n' +
        '  host), not a repo with nothing to check. Investigate before trusting it.',
    );
    process.exit(1);
  }

  if (problems.length) {
    const fix =
      branch === DEFAULT_BRANCH
        ? `  On ${DEFAULT_BRANCH}, the only allowed branch is "${DEFAULT_BRANCH}".`
        : `  Point these at "${branch}", or at "${DEFAULT_BRANCH}" if this is the PR\n` +
          `  that merges the branch.`;
    console.error(
      `\ncheck-import-url FAILED — ${problems.length} of ${found} URL(s) pin the wrong branch:\n\n` +
        `  ${problems.join('\n\n  ')}\n\n${fix}\n` +
        `  Allowed prefixes here:\n${allowed.map((p) => `    ${p}`).join('\n')}\n` +
        `  See "The importUrl rule" in CLAUDE.md.\n`,
    );
    process.exit(1);
  }

  console.log(`check-import-url: OK (${found} URL(s) checked)`);
}

main().catch((e) => {
  console.error(`check-import-url: ${e.message}`);
  process.exit(1);
});
