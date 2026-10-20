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

Push `main` and open one pull request first, so the `test` check has run once and GitHub knows about it.

**In the browser:** Settings → Rules → Rulesets → **New ruleset ▾ → Import a ruleset** → choose `.github/rulesets/main.json` → **Create**.

**Or with the GitHub CLI:**

```bash
gh api repos/{owner}/{repo}/rulesets --method POST --input .github/rulesets/main.json
```

It blocks deleting and force-pushing `main`, requires a pull request with every review conversation resolved, and requires `test` to pass on an up-to-date branch. It requires **0 approvals** because GitHub won't let you approve your own pull request; raise `required_approving_review_count` once someone else works on it.

Nobody can bypass it, including you. To allow yourself an emergency bypass, add yourself under **Bypass list** in the ruleset settings.

### 2. VS Code Marketplace

1. Create a publisher at https://marketplace.visualstudio.com/manage (sign in with a Microsoft account).
2. Set `"publisher"` in `package.json` to that publisher ID.
3. Set up sign-in using **one** of the two options below.

#### Option A: Microsoft Entra (recommended, and the only option after 1 December 2026)

No secret is stored. GitHub proves its identity to Azure on each run. You'll need an Azure subscription; Azure for Students works, and a managed identity costs nothing.

1. In the Azure portal, create a **user-assigned managed identity**.
2. In the identity's **Federated credentials**, add a credential:
   - Scenario: *GitHub Actions deploying Azure resources*
   - Organization / Repository: your GitHub username / repo name
   - Entity: **Environment**, name **`marketplace`**
3. Give the identity the **Reader** role on your subscription or resource group (`azure/login` needs a subscription).
4. In the Marketplace publisher's **Members** list, add the identity as a **Contributor**. Follow Microsoft's "secure automated publishing with Microsoft Entra ID" steps on the [Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) page for this part.
5. In GitHub, go to Settings → Secrets and variables → Actions → **Variables** and add:
   - `AZURE_CLIENT_ID`: the identity's client ID
   - `AZURE_TENANT_ID`: your tenant ID
   - `AZURE_SUBSCRIPTION_ID`: your subscription ID

#### Option B: Personal access token (quick, but stops working 1 December 2026)

Microsoft retires "global" Azure DevOps tokens, including the kind the Marketplace needs, on 1 December 2026.

1. In Azure DevOps (https://dev.azure.com), go to User settings → Personal access tokens → **New token**.
   - Organization: **All accessible organizations**
   - Scopes: Custom defined → **Marketplace → Manage**
2. In GitHub, go to Settings → Secrets and variables → Actions → **Secrets** and add `VSCE_PAT`.

If both options are set up, Entra is used.

### 3. Open VSX (optional)

Open VSX is the extension store used by VSCodium, Cursor, Windsurf and Gitpod.

1. Sign in at https://open-vsx.org with GitHub and sign the publisher agreement.
2. Create an access token, then create the namespace once: `npx ovsx create-namespace <publisher> -p <token>`.
3. Add the GitHub secret `OVSX_PAT`.

### 4. Approve each publish by hand (optional)

The release job runs in the `marketplace` environment. To approve each publish yourself, go to Settings → Environments → `marketplace` and add yourself as a **Required reviewer**.

---

If a publish step fails, fix the problem and re-run the workflow from the Actions tab. Every step skips work that's already done, and the GitHub Release is created last.
