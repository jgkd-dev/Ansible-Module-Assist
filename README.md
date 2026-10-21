# Assistable

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/jgkd.ansible-module-assist?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=jgkd.ansible-module-assist)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/jgkd.ansible-module-assist)](https://marketplace.visualstudio.com/items?itemName=jgkd.ansible-module-assist)

Dot-triggered IntelliSense for Ansible playbooks, task files and roles. Type a namespace, hit `.`, and drill down through what's **actually installed on your machine**:

```
ansible.            →  ansible.builtin, ansible.posix, ansible.netcommon …
ansible.builtin.    →  copy, file, template, apt, service, user …
pfsensible.         →  pfsensible.core
pfsensible.core.    →  pfsense_rule, pfsense_alias, pfsense_interface …
```

It reads `ansible.builtin` from your ansible-core install, every collection you've installed with `ansible-galaxy`, and the roles in your project, your `roles_path` and those collections. Collections you install later show up after a re-scan. Roles are picked up as you create them.

> Assistable was previously called **Ansible Module Assist**. The extension ID is unchanged (`jgkd.ansible-module-assist`), so existing installs keep updating. See [Upgrading from 0.3](#upgrading-from-03) for the settings rename.

## Install

Install **Assistable** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=jgkd.ansible-module-assist): search for "Assistable" in the Extensions view (`Ctrl+Shift+X`), or run:

```bash
code --install-extension jgkd.ansible-module-assist
```

Each [GitHub Release](https://github.com/jgkd-dev/Ansible-Module-Assist/releases/latest) also has the `.vsix` attached, for offline installs or editors that can't use the Marketplace (VSCodium, Cursor): **Extensions → … → Install from VSIX…**

You need Ansible installed where VS Code runs (see [Where modules come from](#where-modules-come-from)). Without it you still get a bundled `ansible.builtin` list.

## Features

- **Namespace → collection → module** suggestions, triggered by `.`, each with its short description.
- **Short names expand to FQCN**: type `copy` and pick `ansible.builtin.copy`.
- **Required options inserted for you**: picking `pfsensible.core.pfsense_rule` inserts `name:` and `interface:` as tab stops.
- **Inline ghost-text parameters** (like inline AI suggestions): finish a module line, or press Enter inside its block, and the next required parameter appears in grey. Press `Tab` to accept. Typing part of a name (`dest`) completes it, and `action: ` / `backup` show the default value.
- **Module option suggestions** inside a module block. Required options come first, and options you've already set are hidden.
- **Choice values**: after `state: ` or `action: ` you get the allowed values. Booleans offer `true` / `false`.
- **Hover docs** on modules (description, options, first example, links to the docs and Galaxy) and on options (type, default, choices, aliases).
- **Task keywords** (`name`, `when`, `register`, `loop`, `become`, `notify` …).
- **Commands** (Command Palette, under *Assistable*): **Re-scan installed collections and roles**, **Show installed collections**, **Insert module…**, **Show roles**, **Insert role…**
- **Status bar** shows how many collections and roles were found. Click it to re-scan.

### Roles

```yaml
- hosts: web
  roles:
    - |                        # → web, db, geerlingguy.docker, acme. …
    - role: acme.infra.|       # → collection roles, drilled down by `.`
      tags: [base]             # role keywords: tags, when, become, vars …
      vars:
        |                      # → the role's variables, required first
  tasks:
    - ansible.builtin.include_role:
        name: web              # role names here too
        tasks_from: |          # → main, install, sub/tls (files in roles/web/tasks/)
      vars:
        install_method: |      # → package, source (from the `install` entry point)
```

- **Role names** in a play's `roles:`, in `include_role` / `import_role` `name:` and in `dependencies:` in `meta/main.yml`. Picking one in a `roles:` list inserts `role: <name>` so you can add keywords after it.
- **Collection roles** by FQCN, drilled down with `.` like modules.
- **Role files** for `tasks_from:`, `vars_from:`, `defaults_from:` and `handlers_from:`.
- **Role keywords** inside a `roles:` entry (`vars`, `tags`, `when`, `become`, `delegate_to` …).
- **Role variables** under the `vars:` of a `roles:` entry, or the task-level `vars:` next to `include_role` / `import_role`, work like module options: required ones first, variables you've already set hidden, choice and boolean values, inline ghost-text hints and hover docs. They come from the role's `meta/argument_specs.yml`, using the entry point that `tasks_from:` names (or `main`).
- **Roles without argument specs** fall back to the keys in `defaults/main.yml` (or `defaults/main/*.yml`). These are all optional, keys starting with `_` are hidden, and they're marked "from defaults/main.yml" because some may be internal.
- **Required variables inserted for you**: picking a role in a `roles:` list, or with **Insert role…**, adds `vars:` with the variables its argument specs require, as tab stops.
- **Hover** on a role shows its description, its required and optional variables, its dependencies, and where it came from.
- **Go to Definition** (`F12`) on a role opens its `tasks/main.yml`. On a `tasks_from:` value it opens that file.

Roles are found in the same order Ansible uses. The first match wins.

1. `roles/` next to the file you're editing, and in each parent folder up to the workspace folder
2. `assistable.rolesPaths`
3. `roles_path` in the workspace `ansible.cfg`
4. `ANSIBLE_ROLES_PATH`
5. `~/.ansible/roles`, `/usr/share/ansible/roles`, `/etc/ansible/roles`
6. `roles/` in each workspace folder
7. `roles/` inside every installed collection, as `namespace.collection.role`

A role is any folder with a `tasks/`, `meta/`, `defaults/`, `handlers/` or `vars/` folder in it. You can also write a role as a path (`role: ./roles/web`).

## Which files it works in

With the default `assistable.activation: auto`, suggestions appear in YAML files that look like Ansible:

- files under `tasks/`, `handlers/`, `playbooks/` or `roles/`, except a role's `files/`, `templates/`, `defaults/` and `vars/` folders
- `site.yml`, `playbook*.yml` and `main.yml` files that contain a list
- files with `hosts:`, `tasks:`, `roles:`, `import_playbook:` or `- name:`, or with a fully qualified module key

Files with the `ansible` language ID (for example from the Red Hat Ansible extension) are always included. Set `assistable.activation` to `always` to get suggestions in every YAML file.

## Where modules come from

They're found in this order. The first match wins, as in Ansible's own precedence.

1. `ansible --version`: the ansible-core install, for `ansible.builtin`
2. `ansible-galaxy collection list`: respects your `ansible.cfg` and `ANSIBLE_COLLECTIONS_PATH`
3. A disk scan of `assistable.collectionsPaths`, `collections_path` in the workspace `ansible.cfg`, `./collections`, `./ansible_collections`, `ANSIBLE_COLLECTIONS_PATH`, `~/.ansible/collections`, `/usr/share/ansible/collections`, and the `ansible_collections` folder next to ansible-core (installed by the full `ansible` pip package)

Module options are read straight from each module's `DOCUMENTATION` block, including shared doc fragments (`extends_documentation_fragment`), so suggestions are instant. This matched `ansible-doc` exactly on all 947 modules tested across ansible.builtin, ansible.posix, ansible.windows, community.general, community.docker, kubernetes.core, amazon.aws and pfsensible.core. `ansible-doc` is used as a fallback.

If Ansible isn't installed where VS Code can see it (e.g. editing on Windows), you still get a bundled `ansible.builtin` list plus anything found on disk. For WSL or a remote machine, use the Remote - WSL or Remote - SSH extension so the extension runs where Ansible is installed.

If Ansible is in a virtualenv, the extension checks `.venv/bin` and `venv/bin` in the workspace and `~/.local/bin` (pipx) automatically. You can also set `assistable.ansibleBinPath`.

The **Assistable** output channel lists every collection and role found and where it came from. Check it if one is missing.

## Settings

| Setting | Default | |
|---|---|---|
| `assistable.ansibleBinPath` | `""` | Folder with `ansible`, `ansible-galaxy`, `ansible-doc` |
| `assistable.collectionsPaths` | `[]` | Extra collection folders to scan |
| `assistable.rolesPaths` | `[]` | Extra role folders to scan |
| `assistable.useAnsibleDoc` | `true` | Fall back to `ansible-doc` |
| `assistable.insertRequiredOptions` | `true` | Insert required options (or role variables) when a module or role is picked |
| `assistable.inlineSuggestions` | `true` | Grey ghost-text parameter suggestions |
| `assistable.suggestShortNames` | `true` | `copy` → `ansible.builtin.copy` |
| `assistable.suggestTaskKeywords` | `true` | Suggest `when`, `register`, … |
| `assistable.suggestRoles` | `true` | Suggest role names, role files and role keywords |
| `assistable.suggestRoleVariables` | `true` | Suggest a role's variables under its `vars:` |
| `assistable.includeDeprecated` | `false` | Include `_deprecated` modules |
| `assistable.activation` | `auto` | `auto`: YAML that looks like Ansible; `always`: all YAML |

## Upgrading from 0.3

Settings moved from `ansibleModules.*` to `assistable.*` in 0.4.0, with the same names after the dot (`ansibleModules.activation` → `assistable.activation`).

- The old names still work until 1.0. If both are set at the same level (user, workspace or folder), the new name wins.
- If you have old settings, Assistable offers once to move them for you. It changes nothing unless you click **Move them**. Settings files you share through version control (`.vscode/settings.json`) are moved too, so commit the change.
- The commands are now `assistable.refresh`, `assistable.showCollections` and `assistable.insertModule`. Keybindings that use the old `ansibleModules.*` command IDs keep working.

## Roadmap

- **Role diagnostics**: warn about unknown roles, missing required role variables, and variables a role's argument specs don't declare.
- **Variables in templates**: `{{ var }}` completion inside a role's own tasks, from its defaults and vars.
- **`requirements.yml`**: flag roles and collections that are listed there but not installed.

See the [roles plan](https://github.com/jgkd-dev/Ansible-Module-Assist/blob/main/docs/roles-plan.md) for details.

Ideas and bug reports are welcome on [GitHub Issues](https://github.com/jgkd-dev/Ansible-Module-Assist/issues).

## Develop

```bash
npm install
npm run build      # bundle to dist/
npm test           # unit + integration tests against your local ansible install
npm run package    # build the .vsix
```

Press F5 in VS Code with this folder open to launch an Extension Development Host.

Releases are automatic when a version bump is merged to `main`. See [RELEASING.md](https://github.com/jgkd-dev/Ansible-Module-Assist/blob/main/RELEASING.md).
