/**
 * Pure YAML-structure helpers (no vscode imports) so they can be unit tested.
 * They work line-by-line on indentation, which is robust while the user is
 * mid-edit and the document isn't valid YAML yet.
 */

export const TASK_LIST_KEYS = new Set(['tasks', 'pre_tasks', 'post_tasks', 'handlers', 'block', 'rescue', 'always']);

export const TASK_KEYWORDS: Record<string, string> = {
  name: 'Task name shown in output',
  when: 'Conditional expression; the task runs only if it is true',
  register: 'Save the task result into a variable',
  loop: 'List to iterate over (item available as `item`)',
  loop_control: 'Control loop behaviour (loop_var, label, pause, index_var)',
  with_items: 'Legacy loop over a list',
  vars: 'Variables scoped to this task',
  become: 'Run with privilege escalation',
  become_user: 'User to become',
  become_method: 'Privilege escalation method (sudo, su, ...)',
  notify: 'Handlers to notify when the task reports changed',
  tags: 'Tags to select/skip this task',
  ignore_errors: 'Continue even if the task fails',
  ignore_unreachable: 'Continue even if the host is unreachable',
  changed_when: 'Override when the task reports changed',
  failed_when: 'Override when the task reports failure',
  until: 'Retry until this condition is true',
  retries: 'Number of retries for `until`',
  delay: 'Seconds between retries',
  delegate_to: 'Run the task on another host',
  delegate_facts: 'Assign gathered facts to the delegated host',
  run_once: 'Run on only the first host in the batch',
  environment: 'Environment variables for the task',
  no_log: 'Hide task output (for secrets)',
  check_mode: 'Force check mode on/off for this task',
  diff: 'Show diffs for this task',
  async: 'Run asynchronously for up to N seconds',
  poll: 'Poll interval for async tasks (0 = fire and forget)',
  throttle: 'Limit concurrent workers for this task',
  timeout: 'Task timeout in seconds',
  args: 'Module arguments as a mapping',
  module_defaults: 'Default module arguments',
  any_errors_fatal: 'Fail the whole play if this task fails on any host',
  connection: 'Connection plugin to use',
  listen: 'Topic(s) a handler listens on',
  block: 'Group tasks together',
  rescue: 'Tasks to run if the block fails',
  always: 'Tasks that always run after the block',
};

export interface LineInfo {
  /** Column where the mapping key starts (after any `- `). -1 for blank/comment lines. */
  keyCol: number;
  /** Column of the leading `-` if this line starts a list item. */
  dashCol?: number;
  /** The key, if the line is `key:` or `key: value`. */
  key?: string;
  /** True if the key has no inline value (so it opens a nested block). */
  opensBlock?: boolean;
}

const KEY_RE = /^([A-Za-z0-9_.\-]+)\s*:(?:\s+(.*))?$/;

export function analyseLine(text: string): LineInfo {
  const m = /^(\s*)(-\s+)?(.*)$/.exec(text)!;
  const rest = m[3];
  if (!rest.trim() && !m[2]) return { keyCol: -1 };
  if (rest.trimStart().startsWith('#') && !m[2]) return { keyCol: -1 };
  const dashCol = m[2] ? m[1].length : undefined;
  const keyCol = m[1].length + (m[2]?.length ?? 0);
  const body = rest.replace(/\s+#.*$/, '').trimEnd();
  const km = KEY_RE.exec(body);
  if (km) {
    const value = (km[2] ?? '').trim();
    return { keyCol, dashCol, key: km[1], opensBlock: value === '' };
  }
  return { keyCol, dashCol };
}

export interface Enclosing {
  /** The list item we're in belongs to this key (e.g. `tasks`), if any. */
  listParentKey?: string;
  /** True if we're directly inside a list item (task-like position). */
  inListItem: boolean;
  /** True if that list is at the document root (a tasks/handlers file). */
  topLevelList: boolean;
  /** Key of the mapping directly containing this position (e.g. a module name). */
  mapParentKey?: string;
  mapParentLine?: number;
  /** Line where the enclosing list item starts. */
  itemLine?: number;
}

/**
 * Work out what encloses a key at (line, keyCol).
 * If `selfLine` starts the list item itself (`- foo`), it counts as being in that item.
 */
export function findEnclosing(lines: string[], lineNo: number, keyCol: number, currentDashCol?: number): Enclosing {
  if (currentDashCol !== undefined) {
    return { inListItem: true, itemLine: lineNo, ...listOwner(lines, lineNo, currentDashCol) };
  }
  for (let i = lineNo - 1; i >= 0; i--) {
    const li = analyseLine(lines[i]);
    if (li.keyCol < 0) continue;
    if (li.keyCol === keyCol) {
      if (li.dashCol !== undefined) {
        return { inListItem: true, itemLine: i, ...listOwner(lines, i, li.dashCol) };
      }
      continue; // sibling key in the same mapping
    }
    if (li.keyCol < keyCol) {
      // A `- ` line whose dash is at our column means we're in a list, not a mapping.
      if (li.key && li.opensBlock) return { inListItem: false, topLevelList: false, mapParentKey: li.key, mapParentLine: i };
      return { inListItem: false, topLevelList: false };
    }
  }
  return { inListItem: false, topLevelList: keyCol === 0 };
}

function listOwner(lines: string[], itemLine: number, dashCol: number): { listParentKey?: string; topLevelList: boolean } {
  for (let i = itemLine - 1; i >= 0; i--) {
    const li = analyseLine(lines[i]);
    if (li.keyCol < 0) continue;
    const col = li.dashCol ?? li.keyCol;
    if (col < dashCol || (col === dashCol && li.dashCol === undefined)) {
      // `tasks:` followed by `- ...` at the same indent is valid YAML too.
      return li.key && li.opensBlock ? { listParentKey: li.key, topLevelList: false } : { topLevelList: false };
    }
  }
  return { topLevelList: true };
}

/** Lines holding keys at `keyCol` in the block that contains `lineNo` (excluding `lineNo`). */
function siblingLines(lines: string[], lineNo: number, keyCol: number): number[] {
  const found: number[] = [];
  const visit = (i: number): boolean => {
    const li = analyseLine(lines[i]);
    if (li.keyCol < 0) return true;
    if (li.keyCol < keyCol) return false;
    if (li.keyCol === keyCol && li.key) found.push(i);
    return true;
  };
  // Upwards: stop at a lower indent, or at the start of our own list item.
  for (let i = lineNo - 1; i >= 0; i--) {
    if (!visit(i)) break;
    const li = analyseLine(lines[i]);
    if (li.keyCol === keyCol && li.dashCol !== undefined) break;
  }
  for (let i = lineNo + 1; i < lines.length; i++) {
    const li = analyseLine(lines[i]);
    if (li.keyCol === keyCol && li.dashCol !== undefined) break; // next list item
    if (!visit(i)) break;
  }
  return found;
}

/** Keys already present at `keyCol` in the block that contains `lineNo`. */
export function siblingKeys(lines: string[], lineNo: number, keyCol: number): Set<string> {
  return new Set(siblingLines(lines, lineNo, keyCol).map((i) => analyseLine(lines[i]).key!));
}

/** The scalar value of sibling `key` in the block that contains `lineNo` (quotes and comments stripped). */
export function siblingValue(lines: string[], lineNo: number, keyCol: number, key: string): string | undefined {
  for (const i of siblingLines(lines, lineNo, keyCol)) {
    if (analyseLine(lines[i]).key === key) return valueOf(lines[i]);
  }
  return undefined;
}

export interface KeyToken {
  /** Column where the token starts. */
  start: number;
  token: string;
  /** Column of `-` if the token is the first key of a list item. */
  dashCol?: number;
}

/** If the text before the cursor is a (partial) mapping key, return it. */
export function keyTokenBeforeCursor(prefix: string): KeyToken | undefined {
  const m = /^(\s*)(-\s+)?([A-Za-z0-9_.]*)$/.exec(prefix);
  if (!m) return undefined;
  return { start: m[1].length + (m[2]?.length ?? 0), token: m[3], dashCol: m[2] ? m[1].length : undefined };
}

export interface ValueToken {
  key: string;
  keyCol: number;
  dashCol?: number;
  valueStart: number;
  value: string;
}

/** If the cursor is in the value of `key: <here>`, return it. */
export function valueTokenBeforeCursor(prefix: string): ValueToken | undefined {
  const m = /^(\s*)(-\s+)?([A-Za-z0-9_]+):(\s+)(['"]?[^\s'"#]*)$/.exec(prefix);
  if (!m) return undefined;
  const keyCol = m[1].length + (m[2]?.length ?? 0);
  return {
    key: m[3],
    keyCol,
    dashCol: m[2] ? m[1].length : undefined,
    valueStart: keyCol + m[3].length + 1 + m[4].length,
    value: m[5],
  };
}

/** Role folders that never hold tasks: files and templates aren't Ansible, defaults and vars are plain variables. */
const ROLE_NON_TASK_DIRS = new Set(['files', 'templates', 'defaults', 'vars']);

/** Heuristic for "is this YAML file Ansible?" */
export function looksLikeAnsible(filePath: string, text: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  const roleDir = /\/roles\/[^/]+\/([^/]+)\//.exec(p)?.[1];
  if (roleDir && ROLE_NON_TASK_DIRS.has(roleDir)) return false;
  if (/\/(tasks|handlers|playbooks?|roles)\//.test(p)) return true;
  if (/(^|\/)(site|playbook|main)[^/]*\.ya?ml$/.test(p) && /^\s*-\s/m.test(text)) return true;
  if (/^\s*-?\s*(hosts|tasks|handlers|gather_facts|become|import_playbook|roles)\s*:/m.test(text)) return true;
  if (/^\s*-?\s*[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+\s*:/m.test(text)) return true;
  if (/^\s*-\s+name\s*:/m.test(text)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/** Lists whose items are roles: a play's `roles:` and `dependencies:` in meta/main.yml. */
export const ROLE_LIST_KEYS = new Set(['roles', 'dependencies']);

/** Task keys that take a role `name:`. */
export const INCLUDE_ROLE_KEYS = new Set(
  ['include_role', 'import_role'].flatMap((m) => [m, `ansible.builtin.${m}`, `ansible.legacy.${m}`]),
);

/** `include_role` / `import_role` options that name a file inside the role, and the folder it's in. */
export const ROLE_FILE_KEYS: Record<string, string> = {
  tasks_from: 'tasks',
  vars_from: 'vars',
  defaults_from: 'defaults',
  handlers_from: 'handlers',
};

/** Keys allowed in an entry of a play's `roles:` list. */
export const ROLE_KEYWORDS: Record<string, string> = {
  role: 'Role to run (name, FQCN for a collection role, or path)',
  vars: 'Variables passed to the role',
  tags: 'Tags applied to every task in the role',
  when: 'Conditional expression; the role runs only if it is true',
  become: 'Run the role with privilege escalation',
  become_user: 'User to become',
  become_method: 'Privilege escalation method (sudo, su, ...)',
  delegate_to: 'Run the role\'s tasks on another host',
  environment: 'Environment variables for the role\'s tasks',
  ignore_errors: 'Continue even if a task in the role fails',
  any_errors_fatal: 'Fail the whole play if the role fails on any host',
  no_log: 'Hide the output of the role\'s tasks',
  check_mode: 'Force check mode on/off for the role',
  diff: 'Show diffs for the role\'s tasks',
  run_once: 'Run on only the first host in the batch',
  throttle: 'Limit concurrent workers for the role\'s tasks',
  timeout: 'Task timeout in seconds',
  connection: 'Connection plugin to use',
  module_defaults: 'Default module arguments',
  collections: 'Collections searched for short module names',
  debugger: 'When to start the task debugger',
};

export type RoleContext =
  /**
   * A role name. `asKey`: the cursor is at `- |`, so a pick should insert `role: <name>`.
   * `entry`: it's an entry of a `roles:` / `dependencies:` list whose keys start at `keyCol`
   * (as opposed to include_role's `name:`).
   */
  | { kind: 'roleName'; start: number; token: string; value: boolean; asKey: boolean; entry: boolean; keyCol: number }
  /** A file inside a role, e.g. `tasks_from: |`. `role` is the sibling `name:`, if set. */
  | { kind: 'roleFile'; start: number; token: string; value: true; folder: string; role?: string }
  /** A key inside an entry of a `roles:` list. */
  | { kind: 'roleKeyword'; start: number; token: string; value: false; siblings: Set<string> };

function inRoleList(e: Enclosing): boolean {
  return e.inListItem && e.listParentKey !== undefined && ROLE_LIST_KEYS.has(e.listParentKey);
}

/** What role-related thing, if any, the text before the cursor is typing. */
export function roleContext(lines: string[], lineNo: number, prefix: string): RoleContext | undefined {
  const val = valueTokenBeforeCursor(prefix);
  if (val) {
    const enc = findEnclosing(lines, lineNo, val.keyCol, val.dashCol);
    const quote = /^['"]/.test(val.value) ? 1 : 0;
    const start = val.valueStart + quote;
    const token = val.value.slice(quote);
    if ((val.key === 'role' || val.key === 'name') && inRoleList(enc)) return { kind: 'roleName', start, token, value: true, asKey: false, entry: true, keyCol: val.keyCol };
    if (enc.mapParentKey && INCLUDE_ROLE_KEYS.has(enc.mapParentKey)) {
      if (val.key === 'name') return { kind: 'roleName', start, token, value: true, asKey: false, entry: false, keyCol: val.keyCol };
      const folder = ROLE_FILE_KEYS[val.key];
      if (folder) return { kind: 'roleFile', start, token, value: true, folder, role: siblingValue(lines, lineNo, val.keyCol, 'name') };
    }
    return undefined;
  }
  const tok = keyTokenBeforeCursor(prefix);
  if (!tok) return undefined;
  const enc = findEnclosing(lines, lineNo, tok.start, tok.dashCol);
  if (!inRoleList(enc)) return undefined;
  if (tok.dashCol !== undefined) return { kind: 'roleName', start: tok.start, token: tok.token, value: false, asKey: true, entry: true, keyCol: tok.start };
  return { kind: 'roleKeyword', start: tok.start, token: tok.token, value: false, siblings: siblingKeys(lines, lineNo, tok.start) };
}

export type RoleRef =
  | { kind: 'role'; name: string; start: number; end: number }
  | { kind: 'file'; role?: string; folder: string; file: string; start: number; end: number };

/** The role (or role file) referenced at `col`, for hover and go-to-definition. */
export function roleReferenceAt(lines: string[], lineNo: number, col: number): RoleRef | undefined {
  const text = lines[lineNo] ?? '';
  const word = /[A-Za-z0-9_.\-/]+/g;
  let m: RegExpExecArray | null;
  while ((m = word.exec(text))) {
    const start = m.index;
    const end = start + m[0].length;
    if (col < start || col > end) continue;
    const rc = roleContext(lines, lineNo, text.slice(0, end));
    if (!rc || rc.kind === 'roleKeyword' || rc.start !== start) return undefined;
    // `- web` is a role, but in `- role: web` the cursor on `role` is a key, not a role.
    if (!rc.value && !/^\s*(#.*)?$/.test(text.slice(end))) return undefined;
    if (rc.kind === 'roleFile') return { kind: 'file', role: rc.role, folder: rc.folder, file: rc.token, start, end };
    return { kind: 'role', name: rc.token, start, end };
  }
  return undefined;
}

/** The scalar value of `key` among the direct children of the block opened at `parentLine`. */
export function childValue(lines: string[], parentLine: number, key: string): string | undefined {
  const parentCol = analyseLine(lines[parentLine]).keyCol;
  let childCol: number | undefined;
  for (let i = parentLine + 1; i < lines.length; i++) {
    const li = analyseLine(lines[i]);
    if (li.keyCol < 0) continue;
    if (li.keyCol <= parentCol) break;
    childCol ??= li.keyCol;
    if (li.keyCol === childCol && li.key === key) return valueOf(lines[i]);
  }
  return undefined;
}

/** The scalar value of a `key: value` line, quotes and trailing comment stripped. */
function valueOf(line: string): string | undefined {
  const m = /^\s*(?:-\s+)?[A-Za-z0-9_.\-]+\s*:\s*(.*)$/.exec(line);
  const v = m?.[1].replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
  return v || undefined;
}

export interface RoleVarsBlock {
  role: string;
  /** argument_specs entry point: `main`, or the `tasks_from` file for include_role / import_role. */
  entryPoint: string;
}

/**
 * If the `vars:` key on `varsLine` passes variables to a role, which role:
 *   roles:                       - ansible.builtin.include_role:
 *     - role: web                    name: web
 *       vars:          or            tasks_from: install
 *         web_port: 80             vars:
 *                                    web_port: 80
 */
export function roleVarsBlock(lines: string[], varsLine: number): RoleVarsBlock | undefined {
  const li = analyseLine(lines[varsLine] ?? '');
  if (li.key !== 'vars' || !li.opensBlock) return undefined;
  const enc = findEnclosing(lines, varsLine, li.keyCol, li.dashCol);
  if (!enc.inListItem) return undefined;
  if (inRoleList(enc)) {
    const role = siblingValue(lines, varsLine, li.keyCol, 'role') ?? siblingValue(lines, varsLine, li.keyCol, 'name');
    return role ? { role, entryPoint: 'main' } : undefined;
  }
  // A task: find its include_role / import_role key, then that block's `name:`.
  const itemLine = enc.itemLine ?? varsLine;
  for (let i = itemLine; i < lines.length; i++) {
    const s = analyseLine(lines[i]);
    if (s.keyCol >= 0 && s.keyCol < li.keyCol) break;
    if (i > itemLine && s.keyCol === li.keyCol && s.dashCol !== undefined) break; // next task
    if (s.keyCol !== li.keyCol || !s.key || !INCLUDE_ROLE_KEYS.has(s.key)) continue;
    const role = childValue(lines, i, 'name');
    if (!role) return undefined;
    const from = childValue(lines, i, 'tasks_from');
    return { role, entryPoint: from ? from.replace(/\.ya?ml$/, '') : 'main' };
  }
  return undefined;
}
