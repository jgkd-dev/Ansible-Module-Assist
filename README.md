# Ansible Module Assist

Dot-triggered IntelliSense for Ansible playbooks and task files. Type a namespace, hit `.`, and drill down through what's **actually installed on your machine**:

```
ansible.            →  ansible.builtin, ansible.posix, ansible.netcommon …
ansible.builtin.    →  copy, file, template, apt, service, user …
pfsensible.         →  pfsensible.core
pfsensible.core.    →  pfsense_rule, pfsense_alias, pfsense_interface …
```

It reads `ansible.builtin` from your ansible-core install and every collection you've installed with `ansible-galaxy`, so new collections show up after a re-scan.

## Features

- **Namespace → collection → module** suggestions, triggered by `.`, each with its short description.
- **Short names expand to FQCN** — type `copy` and pick `ansible.builtin.copy`.
- **Required options inserted for you** — picking `pfsensible.core.pfsense_rule` drops in `name:` and `interface:` as tab stops.
- **Inline ghost-text parameters** (like inline AI suggestions) — finish a module line or press Enter inside its block and the next required parameter appears in grey; press `Tab` to accept. Typing part of a name (`dest`) completes it, and `action: ` / `backup` show the default value.
- **Module option suggestions** inside a module block, required ones first, already-used ones hidden.
- **Choice values** — after `state: ` or `action: ` you get the allowed values; booleans offer `true` / `false`.
- **Hover docs** on modules (description, options, first example, docs link) and on options (type, default, choices, aliases).
- **Task keywords** (`name`, `when`, `register`, `loop`, `become`, `notify` …).
- Commands: **Ansible Modules: Re-scan installed collections**, **Show installed collections**, **Insert module…**
- Status bar shows how many collections were found; click it to re-scan.

## Where modules come from

In order (first match wins, like Ansible's own precedence):

1. `ansible --version` → the ansible-core install, for `ansible.builtin`
2. `ansible-galaxy collection list` → respects your `ansible.cfg` and `ANSIBLE_COLLECTIONS_PATH`
3. A disk scan of `ansibleModules.collectionsPaths`, `collections_path` in the workspace `ansible.cfg`, `./collections`, `ANSIBLE_COLLECTIONS_PATH`, `~/.ansible/collections`, `/usr/share/ansible/collections`, and the `ansible_collections` folder next to ansible-core (the full `ansible` pip package)

Module options are read straight from each module's `DOCUMENTATION` block, including shared doc fragments (`extends_documentation_fragment`), so suggestions are instant. This matched `ansible-doc` exactly on all 947 modules tested across ansible.builtin, ansible.posix, ansible.windows, community.general, community.docker, kubernetes.core, amazon.aws and pfsensible.core. `ansible-doc` is used as a fallback.

If Ansible isn't installed where VS Code can see it (e.g. editing on Windows), you still get a bundled `ansible.builtin` list plus anything found on disk. For WSL or a remote box, use the Remote – WSL / Remote – SSH extension so this runs where Ansible lives.

Ansible in a virtualenv? It checks `.venv/bin`, `venv/bin` in the workspace and `~/.local/bin` (pipx) automatically, or set `ansibleModules.ansibleBinPath`.

## Settings

| Setting | Default | |
|---|---|---|
| `ansibleModules.ansibleBinPath` | `""` | Folder with `ansible`, `ansible-galaxy`, `ansible-doc` |
| `ansibleModules.collectionsPaths` | `[]` | Extra collection folders to scan |
| `ansibleModules.useAnsibleDoc` | `true` | Fall back to `ansible-doc` |
| `ansibleModules.insertRequiredOptions` | `true` | Insert required options when a module is picked |
| `ansibleModules.inlineSuggestions` | `true` | Grey ghost-text parameter suggestions |
| `ansibleModules.suggestShortNames` | `true` | `copy` → `ansible.builtin.copy` |
| `ansibleModules.suggestTaskKeywords` | `true` | Suggest `when`, `register`, … |
| `ansibleModules.includeDeprecated` | `false` | Include `_deprecated` modules |
| `ansibleModules.activation` | `auto` | `auto`: YAML that looks like Ansible; `always`: all YAML |

## Install

```
code --install-extension ansible-module-assist-0.3.0.vsix
```

## Develop

```
npm install
npm run build      # bundle to dist/
npm test           # unit + integration tests against your local ansible install
npm run package    # build the .vsix
```

Press F5 in VS Code with this folder open to launch an Extension Development Host.
