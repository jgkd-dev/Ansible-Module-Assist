/**
 * Decides what grey "ghost text" to show for module parameters, Copilot-style.
 * Pure logic (no vscode imports) so it can be unit tested.
 */
import { ModuleDoc, OptionDoc } from './docs';
import { TASK_LIST_KEYS, analyseLine, findEnclosing, keyTokenBeforeCursor, siblingKeys, valueTokenBeforeCursor } from './context';

export interface Ghost {
  /** Column on the cursor line where the replaced text starts. */
  start: number;
  /** Full text that replaces [start, cursor). Must begin with what's already typed there. */
  text: string;
}

export type DocLookup = (moduleKey: string) => Promise<ModuleDoc | undefined>;

export async function planGhost(
  lines: string[],
  lineNo: number,
  col: number,
  lookup: DocLookup,
  indentUnit = 2,
): Promise<Ghost | undefined> {
  const lineText = lines[lineNo] ?? '';
  const prefix = lineText.slice(0, col);
  if (lineText.slice(col).trim() !== '') return undefined; // only at end of line

  // A) End of a module line: `pfsensible.core.pfsense_rule:|` → "\n  name: "
  const li = analyseLine(lineText);
  if (li.key && li.opensBlock && /:\s*$/.test(prefix) && isTaskModuleKey(lines, lineNo, li)) {
    if (hasChildren(lines, lineNo, li.keyCol)) return undefined;
    const d = await lookup(li.key);
    const first = d && missingRequired(d, new Set())[0];
    if (!first) return undefined;
    const indent = ' '.repeat(li.keyCol + indentUnit);
    return { start: col, text: `\n${indent}${optionText(first, indent, indentUnit)}` };
  }

  // C) Value position: `state: |` → default / first choice; `state: ab|` → `absent`
  const val = valueTokenBeforeCursor(prefix);
  if (val) {
    const enc = findEnclosing(lines, lineNo, val.keyCol, val.dashCol);
    if (!enc.mapParentKey) return undefined;
    const d = await lookup(enc.mapParentKey);
    const opt = d && findOption(d, val.key);
    if (!opt) return undefined;
    const candidates = valueCandidates(opt);
    const typed = val.value.replace(/^['"]/, '');
    // Empty value: only suggest when there's a real default, not an arbitrary first choice.
    const hit = typed ? candidates.find((c) => c.startsWith(typed) && c !== typed) : hasDefault(opt) ? candidates[0] : undefined;
    if (!hit) return undefined;
    return { start: val.valueStart + (val.value.length - typed.length), text: hit };
  }

  // B) Key position inside a module block: next required parameter, or complete a partial name
  const tok = keyTokenBeforeCursor(prefix);
  if (!tok || tok.dashCol !== undefined || tok.token.includes('.')) return undefined;
  if (tok.start === 0 && tok.token === '') return undefined;
  const enc = findEnclosing(lines, lineNo, tok.start);
  if (!enc.mapParentKey) return undefined;
  const d = await lookup(enc.mapParentKey);
  if (!d) return undefined;
  const present = siblingKeys(lines, lineNo, tok.start);
  const missing = Object.values(d.options).filter((o) => !present.has(o.name) && !o.aliases.some((a) => present.has(a)));
  const required = byImportance(missing.filter((o) => o.required));

  let pick: OptionDoc | undefined;
  if (!tok.token) {
    pick = required[0];
  } else {
    const t = tok.token;
    pick =
      required.find((o) => o.name.startsWith(t)) ??
      missing.filter((o) => o.name.startsWith(t)).sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))[0];
  }
  if (!pick) return undefined;
  const indent = ' '.repeat(tok.start);
  return { start: tok.start, text: optionText(pick, indent, indentUnit) };
}

function missingRequired(d: ModuleDoc, present: Set<string>): OptionDoc[] {
  return byImportance(Object.values(d.options).filter((o) => o.required && !present.has(o.name)));
}

/** `name` first (it's how most modules identify the thing), then the docs' order. */
function byImportance(opts: OptionDoc[]): OptionDoc[] {
  return [...opts.filter((o) => o.name === 'name'), ...opts.filter((o) => o.name !== 'name')];
}

function hasDefault(opt: OptionDoc): boolean {
  return opt.default !== undefined && opt.default !== null && typeof opt.default !== 'object';
}

function findOption(d: ModuleDoc, key: string): OptionDoc | undefined {
  return d.options[key] ?? Object.values(d.options).find((o) => o.aliases.includes(key));
}

function valueCandidates(opt: OptionDoc): string[] {
  const def = opt.default !== undefined && opt.default !== null && typeof opt.default !== 'object' ? String(opt.default) : undefined;
  let values: string[] = [];
  if (opt.choices?.length) values = opt.choices.map(String);
  else if (opt.type === 'bool') values = ['true', 'false'];
  else if (def !== undefined) values = [def];
  if (opt.type === 'bool' && def !== undefined) {
    const b = ['true', 'yes', 'True'].includes(def) ? 'true' : 'false';
    values = [b, b === 'true' ? 'false' : 'true'];
  } else if (def !== undefined && values.includes(def)) {
    values = [def, ...values.filter((v) => v !== def)];
  }
  return values;
}

/** `name: ` / `state: present` / `rules:\n    - ` depending on the option's type. */
function optionText(opt: OptionDoc, indent: string, unit: number): string {
  if (opt.type === 'list') return `${opt.name}:\n${indent}${' '.repeat(unit)}- `;
  if (opt.type === 'dict') return `${opt.name}:\n${indent}${' '.repeat(unit)}`;
  const hasDefault = opt.default !== undefined && opt.default !== null && typeof opt.default !== 'object';
  if ((opt.choices?.length || opt.type === 'bool') && hasDefault) return `${opt.name}: ${valueCandidates(opt)[0]}`;
  return `${opt.name}: `;
}

function hasChildren(lines: string[], lineNo: number, keyCol: number): boolean {
  for (let i = lineNo + 1; i < lines.length; i++) {
    const li = analyseLine(lines[i]);
    if (li.keyCol < 0) continue;
    return li.keyCol > keyCol;
  }
  return false;
}

/** FQCN keys always count; short names (`copy:`) only directly inside a task. */
function isTaskModuleKey(lines: string[], lineNo: number, li: ReturnType<typeof analyseLine>): boolean {
  const parts = li.key!.split('.');
  if (parts.length === 3) return true;
  if (parts.length !== 1) return false;
  const enc = findEnclosing(lines, lineNo, li.keyCol, li.dashCol);
  return enc.inListItem && (enc.listParentKey ? TASK_LIST_KEYS.has(enc.listParentKey) : enc.topLevelList);
}
