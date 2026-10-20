import * as vscode from 'vscode';
import { ModuleIndex, ModuleInfo, CollectionInfo } from './indexer';
import { planGhost } from './ghost';
import { DocProvider, ModuleDoc, OptionDoc, docsUrl, galaxyUrl } from './docs';
import {
  TASK_KEYWORDS,
  TASK_LIST_KEYS,
  analyseLine,
  findEnclosing,
  keyTokenBeforeCursor,
  looksLikeAnsible,
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

const CMD_RETRIGGER = 'ansibleModules.retrigger';
const CMD_MODULE_INSERTED = 'ansibleModules.moduleInserted';

let index: ModuleIndex;
let docs: DocProvider;
let ready: Promise<void>;
let status: vscode.StatusBarItem;
let output: vscode.OutputChannel;

function cfg() {
  return vscode.workspace.getConfiguration('ansibleModules');
}

function indentUnit(doc: vscode.TextDocument): number {
  const editor = vscode.window.visibleTextEditors.find((e) => e.document === doc);
  const size = editor?.options.tabSize;
  return typeof size === 'number' && editor?.options.insertSpaces !== false ? size : 2;
}

async function rebuild(): Promise<void> {
  status.text = '$(sync~spin) Ansible modules';
  index = new ModuleIndex({
    ansibleBinPath: cfg().get<string>('ansibleBinPath'),
    collectionsPaths: cfg().get<string[]>('collectionsPaths') ?? [],
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    includeDeprecated: cfg().get<boolean>('includeDeprecated') ?? false,
  });
  docs = new DocProvider(index, () => cfg().get<boolean>('useAnsibleDoc') ?? true);
  ready = index.build().catch((e) => {
    index.log.push(`index failed: ${e}`);
  });
  await ready;
  for (const l of index.log) output.appendLine(l);
  for (const c of index.allCollections()) output.appendLine(`  ${c.fqcn} ${c.version ?? ''} [${c.source}] ${c.root ?? ''}`);
  status.text = `$(symbol-module) Ansible: ${index.collectionCount} collections`;
  status.tooltip = `${index.cliAvailable ? `ansible-core ${index.ansibleVersion ?? ''}` : 'ansible CLI not found (using bundled ansible.builtin list)'}\nClick to re-scan installed collections`;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Ansible Module Assist');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'ansibleModules.refresh';
  context.subscriptions.push(output, status);

  const updateStatusVisibility = () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (doc && isActiveFor(doc)) status.show();
    else status.hide();
  };

  ready = rebuild();

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(SELECTOR, new AnsibleCompletionProvider(), '.', ' '),
    vscode.languages.registerHoverProvider(SELECTOR, new AnsibleHoverProvider()),
    vscode.languages.registerInlineCompletionItemProvider(SELECTOR, new AnsibleInlineProvider()),
    vscode.commands.registerCommand('ansibleModules.refresh', async () => {
      await rebuild();
      vscode.window.setStatusBarMessage(`Ansible: indexed ${index.collectionCount} collections`, 4000);
    }),
    vscode.commands.registerCommand('ansibleModules.showCollections', showCollections),
    vscode.commands.registerCommand('ansibleModules.insertModule', insertModuleCommand),
    vscode.commands.registerCommand(CMD_RETRIGGER, () => vscode.commands.executeCommand('editor.action.triggerSuggest')),
    vscode.commands.registerCommand(CMD_MODULE_INSERTED, moduleInserted),
    vscode.window.onDidChangeActiveTextEditor(updateStatusVisibility),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ansibleModules')) void rebuild();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void rebuild()),
  );
  updateStatusVisibility();
}

export function deactivate(): void {}

function isActiveFor(doc: vscode.TextDocument): boolean {
  if (doc.languageId === 'ansible') return true;
  if (doc.languageId !== 'yaml') return false;
  if (cfg().get<string>('activation') === 'always') return true;
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

    // 1) value position: `state: |` → choices of the option
    const val = valueTokenBeforeCursor(prefix);
    if (val) {
      return this.valueCompletions(lines, pos, val.key, val.keyCol, val.dashCol, val.valueStart);
    }
    if (ctx.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter && ctx.triggerCharacter === ' ') return undefined;

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
      if (cfg().get<boolean>('suggestShortNames') ?? true) {
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
      if (cfg().get<boolean>('suggestTaskKeywords') ?? true) {
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
  const insertRequired = cfg().get<boolean>('insertRequiredOptions') ?? true;
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
    if (!(cfg().get<boolean>('inlineSuggestions') ?? true) || !isActiveFor(doc)) return undefined;
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

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

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
