# Plan: role support

Status: phases 1 (0.4.0) and 2 (0.5.0) implemented · phase 3 not started

Assistable completes modules today. Its role support is limited to one thing: files under `roles/` are treated as Ansible, so `roles/x/tasks/main.yml` gets module suggestions. This plan adds roles as a second kind of thing it indexes, completes, documents and navigates.

## What users get

| Where the cursor is | Today | After |
|---|---|---|
| `roles:` list in a play (`- myrole` or `- role: myrole`) | nothing | role names: local, Galaxy-installed and collection roles (`ns.coll.role`, dot drill-down like modules) |
| `ansible.builtin.include_role:` / `import_role:` → `name:` | nothing | role names |
| `tasks_from:` / `defaults_from:` / `vars_from:` / `handlers_from:` | nothing | files in that role's `tasks/`, `defaults/`, … |
| `dependencies:` in `meta/main.yml` | nothing | role names |
| Under a role entry (`vars:` or its own keys) | nothing | the role's variables from `meta/argument_specs.yml`, required first, with type, choices and defaults. Falls back to `defaults/main.yml` keys |
| Hover on a role name | nothing | description, path, version, required variables |
| F12 on a role name | nothing | opens `roles/<name>/tasks/main.yml` (or the `tasks_from` file) |
| Role-level keywords in a `roles:` entry | nothing | `role`, `vars`, `tags`, `when`, `become`, `delegate_to`, … |

New commands: **Assistable: Show roles** and **Insert role…**. Re-scan covers roles as well, and the status bar reads `Ansible: 12 collections · 8 roles`.

## Where roles come from

Discovery follows Ansible's role search order. The first match wins, as in `ModuleIndex.add`.

1. `roles/` next to the playbook being edited. This depends on the document, so resolve it per request rather than at index time.
2. `assistable.rolesPaths` (new setting).
3. `roles_path` in the workspace `ansible.cfg`. It is `:`-separated, like `collections_path`, so reuse `readAnsibleCfgCollectionPaths` in a generalised form.
4. `ANSIBLE_ROLES_PATH`.
5. `~/.ansible/roles`, `/usr/share/ansible/roles`, `/etc/ansible/roles`.
6. `./roles` in each workspace folder.
7. Collection roles: `<collection root>/roles/<name>/` for every collection already in `ModuleIndex`, named `ns.coll.role`. No extra scan is needed.

Optional: run `ansible-galaxy role list` alongside the existing `collection list` call. It is slow and its output is text, so the disk scan stays the primary source.

A directory counts as a role if it contains at least one of `tasks/`, `meta/`, `defaults/`, `handlers/` or `vars/`.

## Design

### `src/roles.ts` (new, no `vscode` imports, unit-testable)

```ts
export interface RoleInfo {
  name: string;            // "myrole" or "ns.coll.myrole"
  root: string;            // role directory
  source: 'local' | 'path' | 'collection';
  collection?: string;     // "ns.coll" for collection roles
  description?: string;    // meta/main.yml galaxy_info.description
  version?: string;
}

export interface RoleSpec {     // one entry point in meta/argument_specs.yml
  entryPoint: string;           // "main", or a tasks_from name
  shortDescription?: string;
  description: string;
  options: Record<string, OptionDoc>;   // same shape as module options
}

export class RoleIndex {
  build(roots: string[], collections: CollectionInfo[]): void;
  forDocument(docPath: string): RoleInfo[];   // adds playbook-relative roles/
  resolve(name: string, docPath: string): RoleInfo | undefined;
  spec(role: RoleInfo, entryPoint = 'main'): Promise<RoleSpec | undefined>;  // cached
  entryFiles(role: RoleInfo, kind: 'tasks' | 'defaults' | 'vars' | 'handlers'): string[];
}
```

Argument specs use the same option schema as module `DOCUMENTATION`, so reuse `normaliseOptions` from `docs.ts` (export it). One difference: specs put nested options under `options:`, where modules use `suboptions:`. `normaliseOptions` needs to read `o.suboptions ?? o.options`. Without argument specs, build a `RoleSpec` from `defaults/main.yml`, with every key optional, its value as the default, and a "from defaults" note.

### `context.ts`: new cursor positions

`findEnclosing` already returns `listParentKey`, so a list item under `roles:` is easy to detect. Add `ROLE_LIST_KEYS = new Set(['roles', 'dependencies'])` and a `ROLE_KEYWORDS` table (`role`, `name`, `vars`, `tags`, `when`, `become`, `become_user`, `delegate_to`, `environment`, `public`, `allow_duplicates`).

A new pure helper, `roleContext(lines, line, col)`, returns one of:

- `{ kind: 'roleName' }`: key token in a `roles:` / `dependencies:` item, or the value of `role:`, or `name:` inside `include_role` / `import_role` (any FQCN or short form).
- `{ kind: 'roleFile', role, folder }`: the value of `tasks_from:` and the other `*_from` keys.
- `{ kind: 'roleVar', role, entryPoint }`: a key under the role entry's `vars:`, a direct key in a `roles:` entry, or a key under `vars:` that sits next to `include_role:` / `import_role:`.

### `extension.ts`

- Before the module branches in the completion, hover and inline providers, check `roleContext`. Role variables go through the same `optionSnippet`, `optionMarkdown` and `planGhost` code, because a `RoleSpec`'s options are `OptionDoc`s. `planGhost` takes a `DocLookup`, so pass it a lookup that returns the role spec wrapped as a `ModuleDoc`.
- `insertRequiredOptions` also applies to roles: picking a role in `roles:` inserts `role: name` plus `vars:` with its required variables.
- Register a `DefinitionProvider` for role names and `*_from` values.
- Value completion for `name:` under `include_role` doesn't fit `valueCompletions`, which only offers choices. Add a role check ahead of it.

### File watching

Roles are local and often edited, unlike installed collections. Add a `FileSystemWatcher` on `**/roles/*/meta/*.yml` and `**/roles/*/` creates and deletes, debounced, so the role index refreshes without a manual re-scan. The collection index doesn't need it.

## Settings and command rename (`ansibleModules.*` → `assistable.*`)

This ships in phase 1, before any role settings are added, so the new settings are created under `assistable.*` from the start. The extension ID stays `jgkd.ansible-module-assist`, because changing it would publish a separate Marketplace listing.

**Settings**
- Contribute every setting under `assistable.*` (`assistable.ansibleBinPath`, `assistable.activation`, …).
- Keep the old `ansibleModules.*` entries in `package.json`, each with a `markdownDeprecationMessage` that names its replacement. VS Code then strikes them through in settings.json and still shows their value.
- Route every read through `setting(key, fallback)` in `extension.ts`. It passes both keys' `inspect()` results to `pickSetting` in `src/settings.ts`, which is pure and tested. The most specific level (folder, then workspace, then user) wins, and within one level the new key beats the old one. So an old workspace setting still beats a new user setting, as it would have before the rename.
- `onDidChangeConfiguration` rebuilds on changes to either `assistable` or `ansibleModules`.
- **Moving settings:** on activation, if any `ansibleModules.*` value is set, show one notification: *"Assistable settings have moved to `assistable.*`."* It has two buttons, **Move them** and **Not now**. **Move them** copies each value to the same scope (user, workspace or folder) under the new key and then clears the old key. Remember a *Not now* in `globalState`. Never write to the user's settings without that click.
- Leave the fallback in place for at least two minor releases, then remove the old keys in 1.0.

**Commands**
- Rename the user-facing commands to `assistable.refresh`, `assistable.showCollections` and `assistable.insertModule`, and the internal ones to `assistable.retrigger` and `assistable.moduleInserted`.
- Also register the old IDs as aliases that call the same handlers, so custom keybindings keep working. They aren't contributed in `package.json`, so they don't appear in the Command Palette.
- The status bar item uses the new ID. The new phase 1 commands are created as `assistable.showRoles` and `assistable.insertRole`.

**Docs**: the README settings table switches to `assistable.*` and gets a short "Upgrading from 0.3" note. Release notes call out the move.

**Tests**: `setting()` precedence (new key set, only the old key set, neither), with a small stub of `getConfiguration` / `inspect`.

## Fix as part of this work

`looksLikeAnsible` turns on for any YAML under `roles/`, which includes `roles/x/files/*.yml`, `templates/`, `defaults/` and `vars/`. A top-level list in `files/` then gets module suggestions. Narrow the check so task suggestions apply only to `roles/*/tasks/` and `roles/*/handlers/`, and so `meta/` gets role (dependency) suggestions only.

## Phases

**Phase 1 (0.4.0): rename and find roles**
- settings and command IDs move to `assistable.*`, with the old keys still read and an offer to move them (see above)
- `RoleIndex` discovery, including collection roles and playbook-relative `roles/`
- role-name completion in `roles:`, `include_role` / `import_role`, `dependencies:`
- `ROLE_KEYWORDS` in role entries
- hover, go-to-definition, `*_from` completion
- `Show roles` / `Insert role…`, status bar count, output channel listing
- `assistable.rolesPaths` setting, the `looksLikeAnsible` fix, file watcher

**Phase 2 (0.5.0): role variables**
- `meta/argument_specs.yml` parsing (all entry points), with `defaults/main.yml` as the fallback
- variable completion, required-first ordering, choice values, ghost text, required insertion
- `assistable.suggestRoleVariables` setting

**Phase 3 (later, optional)**
- Diagnostics: unknown role, missing required role variable, unknown variable when argument specs exist
- `{{ var }}` completion inside a role's own tasks from its defaults and vars
- `requirements.yml` awareness, to flag roles that are listed but not installed

## Tests

Add `test/fixtures/` with a small project:

```
fixtures/project/
  ansible.cfg            # roles_path = ./extra_roles
  site.yml
  roles/web/{tasks/main.yml,tasks/install.yml,meta/argument_specs.yml,defaults/main.yml}
  roles/db/{tasks/main.yml,defaults/main.yml}           # no argument specs → defaults fallback
  extra_roles/common/tasks/main.yml
  collections/ansible_collections/acme/infra/roles/base/...
```

Cover discovery order and precedence, every `roleContext` position (including mid-edit, invalid YAML), argument-spec normalisation with nested `options:`, defaults fallback, and the `looksLikeAnsible` change. These are all pure-function tests in the style of the existing `test/run.ts`, so CI needs no changes.

## Decided

- **Settings and command IDs move to `assistable.*` in phase 1** (see the rename section). The extension ID does not change.

## Decided in phase 2

- **Defaults fallback is on, `_private` keys hidden.** Roles without argument specs still get suggestions from `defaults/main.yml` (or a `defaults/main/` folder). Keys starting with `_` are left out, every variable is optional, and the hover says it comes from defaults, so possibly internal ones are labelled as such. Templated defaults (`{{ … }}`) aren't offered as values, and Ansible's `!unsafe` / `!vault` tags are understood.
- **Variables only under `vars:`.** Direct keys in a `roles:` entry (`- role: web\n  port: 80`) aren't suggested. That's the legacy form, and its keys share a namespace with role keywords.
- **Entry points:** for include_role / import_role, `tasks_from:` selects the argument_specs entry point (as Ansible's validation does). A role with argument specs but none for that entry point falls back to defaults.
- **Required insertion** applies to roles picked in a `roles:` list and to **Insert role…** (both in a list and as a new include_role task). Picking a role name in an existing include_role's `name:` doesn't insert anything, because its `vars:` belongs to the task, outside the block being edited.

## How phase 2 is wired

`blockDoc()` in `extension.ts` returns the docs for whatever block the cursor is in. That's a module's options, or, for a `vars:` that `roleVarsBlock()` (in `context.ts`) ties to a role, `RoleIndex.spec()` shown as a `ModuleDoc`. Completion, value choices, hover and ghost text all go through it, so role variables reuse the module-option code. `planGhost`'s lookup now also gets the line of the block's key, so it can tell whose `vars:` it's in.
