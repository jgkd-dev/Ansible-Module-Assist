// Compares package.json's version with the newest v* git tag.
// Prints a GitHub Actions annotation so a PR shows whether merging will
// publish a release. Never fails the build; a PR without a bump just merges.
//   --output   also write `version`, `tag` and `release=true|false` to $GITHUB_OUTPUT
import { execSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const tag = `v${version}`;

const tags = execSync('git tag --list "v*"', { encoding: 'utf8' })
  .split('\n')
  .map((t) => t.trim())
  .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));

const parse = (v) => v.replace(/^v/, '').split('.').map(Number);
const cmp = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
const latest = tags.sort(cmp).at(-1);

let release = false;
if (tags.includes(tag)) {
  console.log(`::notice title=No release::${tag} already exists. Bump the version (npm run bump:patch) if this change should ship.`);
} else if (latest && cmp(tag, latest) < 0) {
  console.log(`::warning title=Version goes backwards::package.json is ${version} but ${latest} is already released.`);
} else {
  release = true;
  console.log(`::notice title=Release::Merging to main will publish ${tag}${latest ? ` (previous: ${latest})` : ' (first release)'}.`);
}

if (process.argv.includes('--output') && process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\nrelease=${release}\n`);
}
