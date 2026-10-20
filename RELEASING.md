# Releasing

## How it works

- Every pull request runs **CI** (`test` job): typecheck, tests against a real Ansible install, and a `.vsix` build you can download from the run.
- `main` is protected: changes go in through a pull request, and the `test` check must pass first.
- Every merge to `main` runs **Release**. If the version in `package.json` doesn't have a git tag yet, it:
  1. builds `ansible-module-assist-<version>.vsix`
  2. publishes it to the VS Code Marketplace (if set up)
  3. publishes it to Open VSX (if set up)
  4. creates the GitHub Release `v<version>` with the `.vsix` attached and notes generated from the merged PRs

  A merge without a version bump runs the tests and stops. Each PR says which will happen in the CI run's annotations.

To ship a change, bump the version in the PR branch:

```bash
npm run bump:patch   # 0.3.0 -> 0.3.1  (fixes)
npm run bump:minor   # 0.3.0 -> 0.4.0  (features)
git commit -am "Release 0.3.1"
```

---

## One-time setup

### 1. Protect `main`

There are two rulesets in `.github/rulesets/`. Import both.

| Ruleset | What it does |
|---|---|
| `main.json` | Blocks deleting and force-pushing `main`. Every change needs a pull request with the `test` check passing on an up-to-date branch and every review conversation resolved. Applies to everyone, including you. |
| `main-maintainers-only.json` | Only repository **Admins** and **Maintainers** can merge into `main`. Other collaborators can open pull requests but can't merge them. |

Together: a maintainer merges a pull request once its tests pass. Nobody can push straight to `main`, and nobody can merge failing code.

For a personal repo, collaborators only get **Write** access, which means you (the owner, an Admin) are the only one who can merge. The **Maintain** role exists only in repos owned by an organisation.

Approvals are set to **0** because GitHub won't let you approve your own pull request, and the maintainers-only rule already means a maintainer has signed off on every merge. Once you have a second maintainer, raise `required_approving_review_count` in `main.json` to 1.

Push `main` and open one pull request first, so the `test` check has run once and GitHub knows about it. Then import each file:

**In the browser:** Settings → Rules → Rulesets → **New ruleset ▾ → Import a ruleset** → choose the file → **Create**.

**Or with the GitHub CLI:**

```bash
gh api repos/{owner}/{repo}/rulesets --method POST --input .github/rulesets/main.json
gh api repos/{owner}/{repo}/rulesets --method POST --input .github/rulesets/main-maintainers-only.json
```

People outside the repo can never push to it. They fork it and open a pull request. Before CI runs on a first-time contributor's pull request, GitHub asks you to approve it (Settings → Actions → General → *Approval for running fork pull request workflows*). That pull request's CI never sees your Marketplace secrets.

### 2. Extension stores

Publishing to each store is skipped until its sign-in is configured. The GitHub Release is always made.

| Store | Configure |
|---|---|
| VS Code Marketplace | repository variables `AZURE_CLIENT_ID` + `AZURE_TENANT_ID` (Entra managed identity, federated to the `marketplace` environment), or secret `VSCE_PAT` (stops working 1 Dec 2026) |
| Open VSX | secret `OVSX_PAT` in the `marketplace` environment |

Run **Actions → Check store login** to test the sign-ins without publishing.

### 3. Approve each publish by hand (optional)

The release job runs in the `marketplace` environment. To approve each publish yourself, go to Settings → Environments → `marketplace` and add yourself as a **Required reviewer**.

---

If a publish step fails, fix the problem and re-run the workflow from the Actions tab. Every step skips work that's already done, and the GitHub Release is created last.
