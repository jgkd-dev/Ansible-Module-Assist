import * as vscode from 'vscode';
import { ModuleIndex, ModuleInfo, CollectionInfo } from './indexer';
import { planGhost } from './ghost';
import { DocProvider, ModuleDoc, OptionDoc, docsUrl, galaxyUrl } from './docs';
import { RoleIndex, RoleInfo } from './roles';
import { LEGACY_KEYS, LEGACY_SECTION, SCOPES, SECTION, pickSetting } from './settings';
import {
  ROLE_KEYWORDS,
  RoleContext,
  TASK_KEYWORDS,
  TASK_LIST_KEYS,
  analyseLine,
  findEnclosing,
  keyTokenBeforeCursor,
  looksLikeAnsible,
  roleContext,
  roleReferenceAt,
  siblingKeys,
  valueTokenBeforeCursor,
} from './context';

const SELECTOR: vscode.DocumentSelector = [
  { language: 'yaml', scheme: 'file' },
  { language: 'yaml', scheme: 'untitled' },
  { language: 'ansible', scheme: 'file' },
  { language: 'ansible', scheme: 'untitled' },
  { language: 'yaml', scheme: 'vscode-remote' },
  { language: 'ansible', scheme: 'vscode-remote' },
];

const CMD_RETRIGGER = 'assistable.retrigger';
const CMD_MODULE_INSERTED = 'assistable.moduleInserted';

let index: ModuleIndex;
let roles: RoleIndex;
let docs: DocProvider;
let ready: Promise<void>;
let status: vscode.StatusBarItem;
let output: vscode.OutputChannel;

/** Reads `assistable.<key>`, falling back to the pre-0.4 `ansibleModules.<key>`. */
function setting<T>(key: string, fallback: T): T {
  const now = vscode.workspace.getConfiguration(SECTION).inspect<T>(key);
  const old = (LEGACY_KEYS as readonly string[]).includes(key) ? vscode.workspace.getConfiguration(LEGACY_SECTION).inspect<T>(key) : undefined;
  return pickSetting(now, old, fallback);
}

function indentUnit(doc: vscode.TextDocument): number {
  const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc);
  const size = editor?.options.tabSize;
  return typeof size === 'number' && editor?.options.insertSpaces !== false ? size : 2;
}

async function rebuild(): Promise<void> {
  status.text = '$(sync~spin) Ansible modules';
  index = new ModuleIndex({
    ansibleBinPath: setting<string>('ansibleBinPath', ''),
    collectionsPaths: setting<string[]>('collectionsPaths', []),
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    includeDeprecated: setting('includeDeprecated', false),
  });
  docs = new DocProvider(index, () => setting('useAnsibleDoc', true));
  ready = index.build().catch((e) => {
    index.log.push(`index failed: ${e}`);
  });
  await ready;
  for (const l of index.log) output.appendLine(l);
  for (const c of index.allCollections()) output.appendLine(`  ${c.fqcn} ${c.version ?? ''} [${c.source}] ${c.root ?? ''}`);
  rebuildRoles();
}

/** Roles are cheap to find (no CLI), so they're re-scanned on their own when files change. */
function rebuildRoles(): void {
  roles = new RoleIndex({
    rolesPaths: setting<string[]>('rolesPaths', []),
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
  });
  roles.build(index.allCollections());
  output.appendLine(`indexed ${roles.count} roles from ${roles.roots.length ? roles.roots.join(', ') : 'no roles_path folders'} and collections`);
  for (const r of roles.all()) output.appendLine(`  ${r.name} ${r.version ?? ''} [${r.source}] ${r.root}`);
  const n = (x: number, word: string) => `${x} ${word}${x === 1 ? '' : 's'}`;
  status.text = `$(symbol-module) Ansible: ${n(index.collectionCount, 'collection')} · ${n(roles.count, 'role')}`;
  status.tooltip = `${index.cliAvailable ? `ansible-core ${index.ansibleVersion ?? ''}` : 'ansible CLI not found (using bundled ansible.builtin list)'}\nClick to re-scan installed collections and roles`;
}

function debounce(fn: () => void, ms: number): () => void {
  let t: NodeJS.Timeout | undefined;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Assistable');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'assistable.refresh';
  context.subscriptions.push(output, status);

  const updateStatusVisibility = () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc && isActiveFor(doc)) status.show();
    else status.hide();
  };

  ready = rebuild();

  const refresh = async () => {
    await rebuild();
    vscode.window.setStatusBarMessage(`Ansible: indexed ${index.collectionCount} collections and ${roles.count} roles`, 4000);
  };
  const commands: Record<string, (...args: any[]) => unknown> = {
    refresh,
    showCollections,
    insertModule: insertModuleCommand,
    showRoles: showRolesCommand,
    insertRole: insertRoleCommand,
  };
  for (const [name, fn] of Object.entries(commands)) {
    context.subscriptions.push(vscode.commands.registerCommand(`${SECTION}.${name}`, fn));
  }
  // Pre-0.4 command IDs, so custom keybindings keep working. Not contributed, so not in the palette.
  for (const name of ['refresh', 'showCollections', 'insertModule']) {
    context.subscriptions.push(vscode.commands.registerCommand(`${LEGACY_SECTION}.${name}`, commands[name]));
  }

  const rescanRoles = debounce(() => void ready.then(rebuildRoles), 500);
  const rescanAll = debounce(() => void rebuild(), 300);
  // New or removed roles, and edits to their meta/ (description, argument specs).
  const roleDirs = vscode.workspace.createFileSystemWatcher('**/roles/{*,*/*}', false, true, false);
  const roleMeta = vscode.workspace.createFileSystemWatcher('**/roles/*/meta/*.{yml,yaml}');
  for (const w of [roleDirs, roleMeta]) {
    w.onDidCreate(rescanRoles);
    w.onDidDelete(rescanRoles);
  }
  roleMeta.onDidChange(rescanRoles);

  context.subscriptions.push(
    roleDirs,
    roleMeta,
    vscode.languages.registerCompletionItemProvider(SELECTOR, new AnsibleCompletionProvider(), '.', ' '),
    vscode.languages.registerHoverProvider(SELECTOR, new AnsibleHoverProvider()),
    vscode.languages.registerDefinitionProvider(SELECTOR, new RoleDefinitionProvider()),
    vscode.languages.registerInlineCompletionItemProvider(SELECTOR, new AnsibleInlineProvider()),
    vscode.commands.registerCommand(CMD_RETRIGGER, () => vscode.commands.executeCommand('editor.action.triggerSuggest')),
    vscode.commands.registerCommand(CMD_MODULE_INSERTED, moduleInserted),
    vscode.window.onDidChangeActiveTextEditor(updateStatusVisibility),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION) || e.affectsConfiguration(LEGACY_SECTION)) rescanAll();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(rescanAll),
  );
  updateStatusVisibility();
  void offerSettingsMove(context);
}

const MOVE_DISMISSED = 'assistable.settingsMoveDismissed';

/** One-time offer to move `ansibleModules.*` values to `assistable.*`. Writes nothing unless the user agrees. */
async function offerSettingsMove(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(MOVE_DISMISSED)) return;
  type Target = { target: vscode.ConfigurationTarget; uri?: vscode.Uri; scope: (typeof SCOPES)[number] };
  const targets: Target[] = [
    { target: vscode.ConfigurationTarget.Global, scope: 'globalValue' },
    { target: vscode.ConfigurationTarget.Workspace, scope: 'workspaceValue' },
    ...(vscode.workspace.workspaceFolders ?? []).map((f) => ({ target: vscode.ConfigurationTarget.WorkspaceFolder, uri: f.uri, scope: 'workspaceFolderValue' as const })),
  ];
  const moves: { key: string; value: unknown; t: Target }[] = [];
  for (const t of targets) {
    const old = vscode.workspace.getConfiguration(LEGACY_SECTION, t.uri);
    for (const key of LEGACY_KEYS) {
      const value = old.inspect(key)?.[t.scope];
      if (value !== undefined) moves.push({ key, value, t });
    }
  }
  if (!moves.length) return;
  const keys = [...new Set(moves.map((m) => m.key))];
  const pick = await vscode.window.showInformationMessage(
    `Assistable settings have moved from ansibleModules.* to assistable.*. You have ${keys.length} old setting${keys.length === 1 ? '' : 's'} (${keys.join(', ')}). They still work, but they'll stop working in 1.0.`,
    'Move them',
    'Not now',
  );
  if (pick === 'Not now') await context.globalState.update(MOVE_DISMISSED, true);
  if (pick !== 'Move them') return;
  try {
    for (const { key, value, t } of moves) {
      const now = vscode.workspace.getConfiguration(SECTION, t.uri);
      // A value already set under the new name wins; just drop the old one.
      if (now.inspect(key)?.[t.scope] === undefined) await now.update(key, value, t.target);
      await vscode.workspace.getConfiguration(LEGACY_SECTION, t.uri).update(key, undefined, t.target);
    }
    vscode.window.showInformationMessage(`Moved ${moves.length} setting${moves.length === 1 ? '' : 's'} to assistable.*.`);
  } catch (e) {
    vscode.window.showWarningMessage(`Couldn't move every setting: ${e}. The old names still work.`);
  }
}

export function deactivate(): void {}

function isActiveFor(doc: vscode.TextDocument): boolean {
  if (doc.languageId === 'ansible') return true;
  if (doc.languageId !== 'yaml') return false;
  if (setting<string>('activation', 'auto') === 'always') return true;
  return looksLikeAnsible(doc.uri.fsPath || doc.uri.path, doc.getText());
}

function docLines(doc: vscode.TextDocument): string[] {
  return doc.getText().split(/\r?\n/);
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

class AnsibleCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    _token: vscode.CancellationToken,
    ctx: vscode.CompletionContext,
  ): Promise<vscode.CompletionItem[] | vscode.CompletionList | undefined> {
    if (!isActiveFor(doc)) return undefined;
    await ready;
    const lineText = doc.lineAt(pos.line).text;
    const prefix = lineText.slice(0, pos.character);
    const lines = docLines(doc);
    const isSpace = ctx.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter && ctx.triggerCharacter === ' ';

    // 0) roles: `roles:` entries, include_role `name:` / `tasks_from:`, meta dependencies
    const rc = setting('suggestRoles', true) ? roleContext(lines, pos.line, prefix) : undefined;
    if (rc) {
      // Typing `- ` opens a role entry and `role: ` expects a value; a space elsewhere doesn't.
      if (isSpace && rc.kind === 'roleKeyword') return undefined;
      return roleCompletions(doc, pos, rc);
    }

    // 1) value position: `state: |` → choices of the option
    const val = valueTokenBeforeCursor(prefix);
    if (val) {
      return this.valueCompletions(lines, pos, val.key, val.keyCol, val.dashCol, val.valueStart);
    }
    if (isSpace) return undefined;

    // 2) key position
    const tok = keyTokenBeforeCursor(prefix);
    if (!tok) return undefined;
    const enclosing = findEnclosing(lines, pos.line, tok.start, tok.dashCol);

    // Replace the whole token, including anything after the cursor (re-editing a key).
    const after = /^[A-Za-z0-9_.]*/.exec(lineText.slice(pos.character))![0];
    const hasColonAfter = lineText.slice(pos.character + after.length).startsWith(':');
    const range = new vscode.Range(pos.line, tok.start, pos.line, pos.character + after.length);

    // Module options: we're inside `ansible.builtin.copy:` → suggest its parameters
    if (enclosing.mapParentKey && !tok.token.includes('.')) {
      const mod = await index.resolveModule(enclosing.mapParentKey);
      if (mod) return this.optionCompletions(doc, lines, pos, tok.start, mod, range, hasColonAfter);
      return undefined;
    }

    // Task position: suggest namespaces → collections → modules
    const isTaskPosition =
      enclosing.inListItem &&
      ((enclosing.listParentKey !== undefined && TASK_LIST_KEYS.has(enclosing.listParentKey)) ||
        (enclosing.listParentKey === undefined && enclosing.topLevelList));
    if (!isTaskPosition) return undefined;

    const siblings = siblingKeys(lines, pos.line, tok.start);
    if (enclosing.topLevelList && (siblings.has('hosts') || siblings.has('import_playbook'))) return undefined; // that's a play, not a task

    return this.moduleCompletions(doc, tok.token, tok.start, range, hasColonAfter, siblings);
  }

  private async moduleCompletions(
    doc: vscode.TextDocument,
    token: string,
    keyCol: number,
    range: vscode.Range,
    hasColonAfter: boolean,
    siblings: Set<string>,
  ): Promise<vscode.CompletionList> {
    const parts = token.split('.');
    const items: vscode.CompletionItem[] = [];
    const retrigger: vscode.Command = { title: 'suggest', command: CMD_RETRIGGER };

    if (parts.length === 1) {
      // Namespaces (ansible, community, pfsensible, ...)
      for (const [ns, colls] of index.namespaces) {
        const item = new vscode.CompletionItem({ label: ns, description: `${colls.size} collection${colls.size === 1 ? '' : 's'}` }, vscode.CompletionItemKind.Folder);
        item.insertText = `${ns}.`;
        item.filterText = ns;
        item.range = range;
        item.detail = Array.from(colls.keys()).map((c) => `${ns}.${c}`).join(', ');
        item.sortText = `1_${ns === 'ansible' ? '0' : '1'}_${ns}`;
        item.command = retrigger;
        items.push(item);
      }
      // Bare module names → expand to the FQCN (e.g. typing `copy` offers ansible.builtin.copy)
      if (setting('suggestShortNames', true)) {
        for (const coll of index.allCollections()) {
          const preload = coll.fqcn === 'ansible.builtin' || coll.modules;
          if (!preload) continue;
          const mods = await index.getModules(coll);
          for (const mod of mods.values()) {
            const item = this.moduleItem(doc, mod, keyCol, range, hasColonAfter);
            item.filterText = mod.name;
            item.sortText = `3_${coll.fqcn === 'ansible.builtin' ? '0' : '1'}_${mod.name}`;
            items.push(item);
          }
        }
      }
      // Task keywords (name, when, register, ...)
      if (setting('suggestTaskKeywords', true)) {
        for (const [kw, desc] of Object.entries(TASK_KEYWORDS)) {
          if (siblings.has(kw)) continue;
          const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
          item.detail = 'task keyword';
          item.documentation = desc;
          item.insertText = hasColonAfter ? kw : `${kw}: `;
          item.range = range;
          item.sortText = `2_${kw}`;
          items.push(item);
        }
      }
      return new vscode.CompletionList(items, false);
    }

    if (parts.length === 2) {
      // Collections in a namespace: `community.` → general, docker, ...
      const colls = index.namespaces.get(parts[0]);
      if (!colls) return new vscode.CompletionList([], false);
      for (const coll of colls.values()) {
        const item = new vscode.CompletionItem({ label: coll.fqcn, description: coll.version ? `v${coll.version}` : undefined }, vscode.CompletionItemKind.Module);
        item.insertText = `${coll.fqcn}.`;
        item.filterText = coll.fqcn;
        item.range = range;
        item.detail = collectionDetail(coll);
        item.sortText = coll.name === 'builtin' ? `0_${coll.name}` : `1_${coll.name}`;
        item.command = retrigger;
        items.push(item);
      }
      return new vscode.CompletionList(items, false);
    }

    if (parts.length === 3) {
      // Modules in a collection: `ansible.builtin.` → copy, file, template, ...
      const coll = index.getCollection(parts[0], parts[1]);
      if (!coll) return new vscode.CompletionList([], false);
      const mods = await index.getModules(coll);
      for (const mod of mods.values()) {
        const item = this.moduleItem(doc, mod, keyCol, range, hasColonAfter);
        item.filterText = mod.fqcn;
        items.push(item);
      }
      return new vscode.CompletionList(items, false);
    }
    return new vscode.CompletionList([], false);
  }

  private moduleItem(doc: vscode.TextDocument, mod: ModuleInfo, keyCol: number, range: vscode.Range, hasColonAfter: boolean): vscode.CompletionItem {
    const item = new vscode.CompletionItem({ label: mod.fqcn, description: mod.shortDescription }, vscode.CompletionItemKind.Function);
    item.range = range;
    item.sortText = `0_${mod.name}`;
    (item as any).moduleInfo = mod;
    if (hasColonAfter) {
      item.insertText = mod.fqcn;
    } else {
      const indent = ' '.repeat(keyCol + indentUnit(doc));
      item.insertText = `${mod.fqcn}:\n${indent}`;
      item.keepWhitespace = true;
      item.command = { title: 'module inserted', command: CMD_MODULE_INSERTED, arguments: [mod.fqcn] };
    }
    return item;
  }

  async resolveCompletionItem(item: vscode.CompletionItem): Promise<vscode.CompletionItem> {
    const mod: ModuleInfo | undefined = (item as any).moduleInfo;
    if (mod) {
      const d = await docs.get(mod);
      if (d) item.documentation = moduleMarkdown(mod, d, true);
    }
    const role: RoleInfo | undefined = (item as any).roleInfo;
    if (role) item.documentation = roleMarkdown(role);
    return item;
  }

  private async optionCompletions(
    doc: vscode.TextDocument,
    lines: string[],
    pos: vscode.Position,
    keyCol: number,
    mod: ModuleInfo,
    range: vscode.Range,
    hasColonAfter: boolean,
  ): Promise<vscode.CompletionItem[]> {
    const d = await docs.get(mod);
    if (!d) return [];
    const present = siblingKeys(lines, pos.line, keyCol);
    const items: vscode.CompletionItem[] = [];
    const unit = indentUnit(doc);
    for (const opt of Object.values(d.options)) {
      if (present.has(opt.name) || opt.aliases.some((a) => present.has(a))) continue;
      const item = new vscode.CompletionItem(
        { label: opt.name, description: [opt.required ? 'required' : '', opt.type ?? ''].filter(Boolean).join(' · ') },
        vscode.CompletionItemKind.Property,
      );
      item.range = range;
      item.filterText = [opt.name, ...opt.aliases].join(' ');
      item.sortText = `${opt.required ? '0' : '1'}_${opt.name}`;
      item.documentation = optionMarkdown(mod.fqcn, opt);
      item.detail = `${mod.fqcn} option`;
      if (hasColonAfter) {
        item.insertText = opt.name;
      } else {
        item.insertText = optionSnippet(opt, ' '.repeat(keyCol + unit));
        item.keepWhitespace = true;
      }
      items.push(item);
    }
    return items;
  }

  private async valueCompletions(
    lines: string[],
    pos: vscode.Position,
    key: string,
    keyCol: number,
    dashCol: number | undefined,
    valueStart: number,
  ): Promise<vscode.CompletionItem[] | undefined> {
    const enclosing = findEnclosing(lines, pos.line, keyCol, dashCol);
    if (!enclosing.mapParentKey) return undefined;
    const mod = await index.resolveModule(enclosing.mapParentKey);
    if (!mod) return undefined;
    const d = await docs.get(mod);
    const opt = d && (d.options[key] ?? Object.values(d.options).find((o) => o.aliases.includes(key)));
    if (!opt) return undefined;
    const values = opt.choices?.length ? opt.choices : opt.type === 'bool' ? [true, false] : [];
    const range = new vscode.Range(pos.line, valueStart, pos.line, pos.character);
    return values.map((v, i) => {
      const item = new vscode.CompletionItem(String(v), vscode.CompletionItemKind.EnumMember);
      item.range = range;
      item.sortText = String(i).padStart(3, '0');
      if (opt.default !== undefined && String(opt.default) === String(v)) item.detail = 'default';
      return item;
    });
  }
}

// ---------------------------------------------------------------------------
// Role completion
// ---------------------------------------------------------------------------

function docPath(doc: vscode.TextDocument): string | undefined {
  return doc.uri.scheme === 'untitled' ? undefined : doc.uri.fsPath;
}

function roleCompletions(doc: vscode.TextDocument, pos: vscode.Position, rc: RoleContext): vscode.CompletionList {
  const lineText = doc.lineAt(pos.line).text;
  // Replace the whole token, including anything after the cursor.
  const after = (rc.value ? /^[^\s'"#]*/ : /^[A-Za-z0-9_.]*/).exec(lineText.slice(pos.character))![0];
  const hasColonAfter = !rc.value && lineText.slice(pos.character + after.length).startsWith(':');
  const range = new vscode.Range(pos.line, rc.start, pos.line, pos.character + after.length);
  const items: vscode.CompletionItem[] = [];

  if (rc.kind === 'roleKeyword') {
    for (const [kw, desc] of Object.entries(ROLE_KEYWORDS)) {
      if (rc.siblings.has(kw) || (kw === 'role' && rc.siblings.has('name'))) continue;
      const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
      item.detail = 'role keyword';
      item.documentation = desc;
      item.insertText = hasColonAfter ? kw : `${kw}: `;
      item.range = range;
      item.sortText = `${kw === 'role' ? '0' : '1'}_${kw}`;
      items.push(item);
    }
    return new vscode.CompletionList(items, false);
  }

  if (rc.kind === 'roleFile') {
    const role = rc.role ? roles.resolve(rc.role, docPath(doc)) : undefined;
    if (!role) return new vscode.CompletionList([], false);
    for (const f of roles.entryFiles(role, rc.folder)) {
      const item = new vscode.CompletionItem({ label: f, description: `${rc.folder}/${f}.yml` }, vscode.CompletionItemKind.File);
      item.range = range;
      items.push(item);
    }
    return new vscode.CompletionList(items, false);
  }

  // Role names. At `- |` a pick inserts `role: <name>` so keywords can follow.
  const prefix = rc.asKey && !hasColonAfter ? 'role: ' : '';
  const retrigger: vscode.Command = { title: 'suggest', command: CMD_RETRIGGER };
  const parts = rc.token.split('.');
  const add = (role: RoleInfo, sort: string) => {
    const item = new vscode.CompletionItem({ label: role.name, description: roleSourceLabel(role) }, vscode.CompletionItemKind.Module);
    item.insertText = prefix + role.name;
    item.filterText = role.name;
    item.range = range;
    item.sortText = `${sort}_${role.name}`;
    (item as any).roleInfo = role;
    items.push(item);
  };
  // Standalone roles always show: Galaxy role names like `geerlingguy.docker` contain a dot too.
  for (const role of roles.forDocument(docPath(doc))) add(role, role.source === 'playbook' ? '0' : '1');

  // Collection roles drill down like modules: `acme.` → `acme.infra.` → `acme.infra.base`
  const byNs = roles.roleCollections();
  if (parts.length === 1) {
    for (const [ns, colls] of byNs) {
      const item = new vscode.CompletionItem({ label: ns, description: `roles in ${colls.size} collection${colls.size === 1 ? '' : 's'}` }, vscode.CompletionItemKind.Folder);
      item.insertText = `${prefix}${ns}.`;
      item.filterText = ns;
      item.range = range;
      item.sortText = `2_${ns}`;
      item.command = retrigger;
      items.push(item);
    }
  } else if (parts.length === 2) {
    for (const coll of byNs.get(parts[0]) ?? []) {
      const fqcn = `${parts[0]}.${coll}`;
      const item = new vscode.CompletionItem({ label: fqcn, description: `${roles.collectionRolesIn(fqcn).length} roles` }, vscode.CompletionItemKind.Folder);
      item.insertText = `${prefix}${fqcn}.`;
      item.filterText = fqcn;
      item.range = range;
      item.sortText = `2_${fqcn}`;
      item.command = retrigger;
      items.push(item);
    }
  } else {
    for (const role of roles.collectionRolesIn(`${parts[0]}.${parts[1]}`)) add(role, '0');
  }

  if (rc.asKey && !roles.forDocument(docPath(doc)).length && !byNs.size) {
    const item = new vscode.CompletionItem('role', vscode.CompletionItemKind.Keyword);
    item.insertText = hasColonAfter ? 'role' : 'role: ';
    item.range = range;
    items.push(item);
  }
  return new vscode.CompletionList(items, false);
}

function roleSourceLabel(role: RoleInfo): string {
  if (role.source === 'collection') return `collection ${role.collection}${role.version ? ` v${role.version}` : ''}`;
  const where = role.source === 'playbook' ? 'project' : 'roles_path';
  return role.version ? `${where} v${role.version}` : where;
}

function optionSnippet(opt: OptionDoc, childIndent: string): vscode.SnippetString {
  const s = new vscode.SnippetString();
  s.appendText(`${opt.name}:`);
  if (opt.choices?.length) {
    s.appendText(' ');
    const ordered = orderDefaultFirst(opt.choices.map(String), opt.default);
    s.appendChoice(ordered);
  } else if (opt.type === 'bool') {
    s.appendText(' ');
    const def = opt.default === true || opt.default === 'yes' ? 'true' : opt.default === false || opt.default === 'no' ? 'false' : undefined;
    s.appendChoice(orderDefaultFirst(['true', 'false'], def));
  } else if (opt.type === 'list') {
    s.appendText(`\n${childIndent}- `);
    s.appendTabstop(0);
  } else if (opt.type === 'dict') {
    s.appendText(`\n${childIndent}`);
    s.appendTabstop(0);
  } else {
    s.appendText(' ');
    if (opt.default !== undefined && opt.default !== null && typeof opt.default !== 'object') s.appendPlaceholder(String(opt.default));
    else s.appendTabstop(0);
  }
  return s;
}

function orderDefaultFirst(values: string[], def: unknown): string[] {
  if (def === undefined) return values;
  const d = String(def);
  return values.includes(d) ? [d, ...values.filter((v) => v !== d)] : values;
}

/** After a module is accepted: add its required options, or open the options list. */
async function moduleInserted(fqcn: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const mod = await index.resolveModule(fqcn);
  const insertRequired = setting('insertRequiredOptions', true);
  if (mod && insertRequired) {
    const d = await docs.get(mod);
    const required = d ? Object.values(d.options).filter((o) => o.required) : [];
    if (required.length) {
      const s = new vscode.SnippetString();
      required.forEach((o, i) => {
        if (i > 0) s.appendText('\n');
        s.appendText(`${o.name}: `);
        if (o.choices?.length) s.appendChoice(o.choices.map(String));
        else s.appendPlaceholder(o.name);
      });
      s.appendText('\n');
      s.appendTabstop(0);
      await editor.insertSnippet(s, editor.selection.active, { undoStopBefore: false, undoStopAfter: true });
      return;
    }
  }
  await vscode.commands.executeCommand('editor.action.triggerSuggest');
}

// ---------------------------------------------------------------------------
// Inline (ghost text) parameter suggestions
// ---------------------------------------------------------------------------

class AnsibleInlineProvider implements vscode.InlineCompletionItemProvider {
  async provideInlineCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    _ctx: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!setting('inlineSuggestions', true) || !isActiveFor(doc)) return undefined;
    await ready;
    const ghost = await planGhost(
      docLines(doc),
      pos.line,
      pos.character,
      async (key) => {
        const mod = await index.resolveModule(key);
        return mod ? docs.get(mod) : undefined;
      },
      indentUnit(doc),
    );
    if (!ghost || token.isCancellationRequested) return undefined;
    return [new vscode.InlineCompletionItem(ghost.text, new vscode.Range(pos.line, ghost.start, pos.line, pos.character))];
  }
}

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

class AnsibleHoverProvider implements vscode.HoverProvider {
  async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    if (!isActiveFor(doc)) return undefined;
    await ready;
    const ref = roleReferenceAt(docLines(doc), pos.line, pos.character);
    if (ref) {
      const role = ref.kind === 'role' ? roles.resolve(ref.name, docPath(doc)) : ref.role ? roles.resolve(ref.role, docPath(doc)) : undefined;
      if (!role) return undefined;
      const r = new vscode.Range(pos.line, ref.start, pos.line, ref.end);
      if (ref.kind === 'role') return new vscode.Hover(roleMarkdown(role), r);
      const file = roles.entryFile(role, ref.folder, ref.file);
      return new vscode.Hover(file ? `\`${vscode.workspace.asRelativePath(file)}\`` : `$(warning) No \`${ref.folder}/${ref.file}.yml\` in role ${role.name}`, r);
    }
    const range = doc.getWordRangeAtPosition(pos, /[A-Za-z0-9_.]+/);
    if (!range) return undefined;
    const word = doc.getText(range);
    const lineText = doc.lineAt(pos.line).text;
    const li = analyseLine(lineText);
    if (li.key !== word || range.start.character !== li.keyCol) return undefined;
    const lines = docLines(doc);

    // Hovering an option inside a module block
    const enclosing = findEnclosing(lines, pos.line, li.keyCol, li.dashCol);
    if (enclosing.mapParentKey) {
      const parent = await index.resolveModule(enclosing.mapParentKey);
      if (parent) {
        const d = await docs.get(parent);
        const opt = d && (d.options[word] ?? Object.values(d.options).find((o) => o.aliases.includes(word)));
        if (opt) return new vscode.Hover(optionMarkdown(parent.fqcn, opt), range);
      }
    }

    // Hovering a module key
    const mod = await index.resolveModule(word);
    if (!mod) return undefined;
    const d = await docs.get(mod);
    return new vscode.Hover(moduleMarkdown(mod, d, false), range);
  }
}

class RoleDefinitionProvider implements vscode.DefinitionProvider {
  async provideDefinition(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Definition | vscode.LocationLink[] | undefined> {
    if (!isActiveFor(doc)) return undefined;
    await ready;
    const ref = roleReferenceAt(docLines(doc), pos.line, pos.character);
    if (!ref) return undefined;
    const role = roles.resolve(ref.kind === 'role' ? ref.name : (ref.role ?? ''), docPath(doc));
    if (!role) return undefined;
    const target = ref.kind === 'role' ? roles.mainFile(role) : roles.entryFile(role, ref.folder, ref.file);
    if (!target) return undefined;
    return [
      {
        originSelectionRange: new vscode.Range(pos.line, ref.start, pos.line, ref.end),
        targetUri: vscode.Uri.file(target),
        targetRange: new vscode.Range(0, 0, 0, 0),
      },
    ];
  }
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function roleMarkdown(role: RoleInfo): vscode.MarkdownString {
  const d = roles.details(role);
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${role.name}** _role_`);
  if (d.description) md.appendMarkdown(` — ${d.description}`);
  md.appendMarkdown('\n\n');
  const opts = Object.values(d.options);
  const required = opts.filter((o) => o.required).map((o) => `\`${o.name}\``);
  if (required.length) md.appendMarkdown(`**Required variables:** ${required.join(', ')}\n\n`);
  const optional = opts.filter((o) => !o.required).map((o) => `\`${o.name}\``);
  if (optional.length) md.appendMarkdown(`**Variables:** ${optional.slice(0, 40).join(', ')}${optional.length > 40 ? ', …' : ''}\n\n`);
  if (d.dependencies.length) md.appendMarkdown(`**Depends on:** ${d.dependencies.map((x) => `\`${x}\``).join(', ')}\n\n`);
  const facts = [roleSourceLabel(role), d.author ? `by ${d.author}` : ''].filter(Boolean).join(' · ');
  md.appendMarkdown(`_${facts}_ · \`${vscode.workspace.asRelativePath(role.root)}\``);
  if (role.collection) md.appendMarkdown(` · [Galaxy](${galaxyUrl(role.name)})`);
  return md;
}

function moduleMarkdown(mod: ModuleInfo, d: ModuleDoc | undefined, compact: boolean): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**${mod.fqcn}**`);
  const short = d?.shortDescription ?? mod.shortDescription;
  if (short) md.appendMarkdown(` — ${short}`);
  md.appendMarkdown('\n\n');
  if (d?.deprecated) md.appendMarkdown(`$(warning) **Deprecated:** ${d.deprecated}\n\n`);
  if (d?.description) md.appendMarkdown(`${compact ? truncate(d.description, 500) : d.description}\n\n`);
  if (d) {
    const opts = Object.values(d.options);
    const required = opts.filter((o) => o.required).map((o) => `\`${o.name}\``);
    if (required.length) md.appendMarkdown(`**Required:** ${required.join(', ')}\n\n`);
    const optional = opts.filter((o) => !o.required).map((o) => `\`${o.name}\``);
    if (optional.length) md.appendMarkdown(`**Options:** ${optional.slice(0, 40).join(', ')}${optional.length > 40 ? ', …' : ''}\n\n`);
    if (!compact && d.examples) {
      md.appendMarkdown('**Example**\n');
      md.appendCodeblock(firstExample(d.examples), 'yaml');
    }
  }
  const isPackaged = mod.namespace === 'ansible' && mod.collection === 'builtin';
  md.appendMarkdown(`[Docs](${docsUrl(mod.fqcn)})${isPackaged ? '' : ` · [Galaxy](${galaxyUrl(mod.fqcn)})`}`);
  return md;
}

function optionMarkdown(fqcn: string, opt: OptionDoc): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  const typeStr = opt.type ? (opt.elements ? `${opt.type} of ${opt.elements}` : opt.type) : 'any';
  md.appendMarkdown(`**${opt.name}** \`${typeStr}\`${opt.required ? ' · **required**' : ''}\n\n`);
  if (opt.description) md.appendMarkdown(`${opt.description}\n\n`);
  if (opt.choices?.length) md.appendMarkdown(`**Choices:** ${opt.choices.map((c) => `\`${String(c)}\``).join(', ')}\n\n`);
  if (opt.default !== undefined && opt.default !== null) md.appendMarkdown(`**Default:** \`${JSON.stringify(opt.default)}\`\n\n`);
  if (opt.aliases.length) md.appendMarkdown(`**Aliases:** ${opt.aliases.map((a) => `\`${a}\``).join(', ')}\n\n`);
  if (opt.suboptions) md.appendMarkdown(`**Suboptions:** ${Object.keys(opt.suboptions).map((k) => `\`${k}\``).join(', ')}\n\n`);
  md.appendMarkdown(`_${fqcn}_`);
  return md;
}

function firstExample(examples: string): string {
  const blocks = examples.split(/\n(?=- name:)/);
  return truncate(blocks[0].trim(), 1200);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n).trimEnd()}…` : s;
}

function collectionDetail(c: CollectionInfo): string {
  const src = { builtin: 'ansible-core', cli: 'ansible-galaxy', scan: 'found on disk', fallback: 'bundled list' }[c.source];
  return `${c.fqcn}${c.version ? ` ${c.version}` : ''} (${src})`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function showCollections(): Promise<void> {
  await ready;
  const picked = await vscode.window.showQuickPick(
    index.allCollections().map((c) => ({ label: c.fqcn, description: c.version, detail: c.root, coll: c })),
    { placeHolder: `${index.collectionCount} installed collections — pick one to browse its modules`, matchOnDetail: true },
  );
  if (picked) await pickModule(picked.coll);
}

async function insertModuleCommand(): Promise<void> {
  await ready;
  const picked = await vscode.window.showQuickPick(
    index.allCollections().map((c) => ({ label: c.fqcn, description: c.version, coll: c })),
    { placeHolder: 'Collection' },
  );
  if (picked) await pickModule(picked.coll);
}

function rolePickItems(doc?: vscode.TextDocument) {
  const local = roles.forDocument(doc && docPath(doc));
  const seen = new Set(local.map((r) => r.root));
  return [...local, ...roles.all().filter((r) => !seen.has(r.root))].map((r) => ({
    label: r.name,
    description: roleSourceLabel(r),
    detail: roles.details(r).description,
    role: r,
  }));
}

async function showRolesCommand(): Promise<void> {
  await ready;
  const items = rolePickItems(vscode.window.activeTextEditor?.document);
  const picked = await vscode.window.showQuickPick(items, { placeHolder: `${items.length} roles — pick one to open it`, matchOnDescription: true, matchOnDetail: true });
  if (picked) await vscode.window.showTextDocument(vscode.Uri.file(roles.mainFile(picked.role)));
}

/** In a `roles:` list inserts `role: <name>`; anywhere else an include_role task. */
async function insertRoleCommand(): Promise<void> {
  await ready;
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isActiveFor(editor.document)) {
    await showRolesCommand();
    return;
  }
  const picked = await vscode.window.showQuickPick(rolePickItems(editor.document), { placeHolder: 'Role', matchOnDescription: true, matchOnDetail: true });
  if (!picked) return;
  const pos = editor.selection.active;
  const prefix = editor.document.lineAt(pos.line).text.slice(0, pos.character);
  const rc = roleContext(docLines(editor.document), pos.line, prefix);
  const name = picked.role.name;
  if (rc?.kind === 'roleName') {
    const range = new vscode.Range(pos.line, rc.start, pos.line, pos.character);
    await editor.edit((b) => b.replace(range, (rc.asKey ? 'role: ' : '') + name));
    return;
  }
  const indent = ' '.repeat(pos.character + indentUnit(editor.document));
  await editor.edit((b) => b.insert(pos, `ansible.builtin.include_role:\n${indent}name: ${name}`));
}

async function pickModule(coll: CollectionInfo): Promise<void> {
  const mods = await index.getModules(coll);
  const picked = await vscode.window.showQuickPick(
    Array.from(mods.values()).map((m) => ({ label: m.name, description: m.shortDescription, mod: m })),
    { placeHolder: `${coll.fqcn} — ${mods.size} modules`, matchOnDescription: true },
  );
  if (!picked) return;
  const editor = vscode.window.activeTextEditor;
  if (editor && isActiveFor(editor.document)) {
    const col = editor.selection.active.character;
    const indent = ' '.repeat(col + indentUnit(editor.document));
    await editor.edit((b) => b.insert(editor.selection.active, `${picked.mod.fqcn}:\n${indent}`), { undoStopBefore: true, undoStopAfter: false });
    await moduleInserted(picked.mod.fqcn);
  } else {
    await vscode.env.openExternal(vscode.Uri.parse(docsUrl(picked.mod.fqcn)));
  }
}
