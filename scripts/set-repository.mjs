// Fills in repository/bugs/homepage in package.json from the GitHub Actions
// environment, so the repo URL isn't hardcoded and works on forks too.
// vsce needs it to turn README links into absolute URLs for the store page.
import { execSync } from 'node:child_process';

const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
const repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
  console.log('GITHUB_REPOSITORY not set; leaving package.json unchanged.');
  process.exit(0);
}
const url = `${server}/${repo}`;
execSync(
  `npm pkg set repository.type=git "repository.url=${url}.git" "bugs.url=${url}/issues" "homepage=${url}#readme"`,
  { stdio: 'inherit' },
);
console.log(`repository set to ${url}`);
