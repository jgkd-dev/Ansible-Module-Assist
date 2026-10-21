import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { expandHome } from './exec';
import { CollectionInfo, isDir, readAnsibleCfgPaths, safeReaddir } from './indexer';
import { OptionDoc, cleanMarkup, normaliseOptions } from './docs';

export type RoleSource = 'playbook' | 'path' | 'collection';

export interface RoleInfo {
  /** `web`, `geerlingguy.docker` (Galaxy role) or `acme.infra.base` (collection role). */
  name: string;
  /** Role directory. */
  root: string;
  source: RoleSource;
  /** `ns.coll` for collection roles. */
  collection?: string;
  version?: string;
}

export interface RoleDetails {
  description?: string;
  author?: string;
  dependencies: string[];
}

/** Variables a role accepts at one entry point. */
export interface RoleSpec {
  entryPoint: string;
  shortDescription?: string;
  description: string;
  options: Record<string, OptionDoc>;
  /** `argument_specs`: declared by the role. `defaults`: guessed from defaults/main.yml, all optional. */
  source: 'argument_specs' | 'defaults';
}

export interface RoleIndexOptions {
  rolesPaths: string[];
  workspaceFolders: string[];
}

const ROLE_SUBDIRS = ['tasks', 'meta', 'defaults', 'handlers', 'vars'];
const YAML_EXT = ['.yml', '.yaml'];

export function isRoleDir(dir: string): boolean {
  return ROLE_SUBDIRS.some((d) => isDir(path.join(dir, d)));
}

/**
 * Finds roles the way Ansible does: `roles/` next to the playbook first, then
 * roles_path (setting, ansible.cfg, ANSIBLE_ROLES_PATH, defaults), plus the
 * roles inside every installed collection.
 */
export class RoleIndex {
  /** Standalone roles from the configured roots, first found wins. */
  private readonly byName = new Map<string, RoleInfo>();
  /** `ns.coll.role` → collection role. */
  private readonly collectionRoles = new Map<string, RoleInfo>();
  /** Roles in a playbook-adjacent `roles/` folder, cached per folder. */
  private readonly dirCache = new Map<string, RoleInfo[]>();
  private readonly detailsCache = new Map<string, RoleDetails>();
  private readonly specCache = new Map<string, RoleSpec | undefined>();
  roots: string[] = [];

  constructor(private readonly opts: RoleIndexOptions) {}

  build(collections: CollectionInfo[]): void {
    this.byName.clear();
    this.collectionRoles.clear();
    this.dirCache.clear();
    this.detailsCache.clear();
    this.specCache.clear();
    this.roots = this.candidateRoots();
    for (const root of this.roots) {
      for (const role of this.scanDir(root, 'path')) if (!this.byName.has(role.name)) this.byName.set(role.name, role);
    }
    for (const coll of collections) {
      if (!coll.root) continue;
      const dir = path.join(coll.root, 'roles');
      for (const name of safeReaddir(dir)) {
        const root = path.join(dir, name);
        if (name.startsWith('.') || !isRoleDir(root)) continue;
        const fqcn = `${coll.fqcn}.${name}`;
        this.collectionRoles.set(fqcn, { name: fqcn, root, source: 'collection', collection: coll.fqcn, version: coll.version });
      }
    }
  }

  get count(): number {
    return this.byName.size + this.collectionRoles.size;
  }

  /** Every role from the configured roots and collections (not playbook-adjacent ones). */
  all(): RoleInfo[] {
    return [...this.byName.values(), ...this.collectionRoles.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  collectionRolesIn(fqcn: string): RoleInfo[] {
    return [...this.collectionRoles.values()].filter((r) => r.collection === fqcn);
  }

  /** Collection namespaces → collections that ship roles. */
  roleCollections(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const r of this.collectionRoles.values()) {
      const [ns, coll] = r.collection!.split('.');
      if (!out.has(ns)) out.set(ns, new Set());
      out.get(ns)!.add(coll);
    }
    return out;
  }

  /** Standalone roles visible from a document: playbook-adjacent `roles/` folders first, then roles_path. */
  forDocument(docPath?: string): RoleInfo[] {
    const seen = new Map<string, RoleInfo>();
    for (const dir of this.localRoleDirs(docPath)) {
      for (const role of this.scanDirCached(dir)) if (!seen.has(role.name)) seen.set(role.name, role);
    }
    for (const role of this.byName.values()) if (!seen.has(role.name)) seen.set(role.name, role);
    return [...seen.values()];
  }

  /** Resolve what a playbook wrote as a role: FQCN, name or path. */
  resolve(name: string, docPath?: string): RoleInfo | undefined {
    if (!name) return undefined;
    const fq = this.collectionRoles.get(name);
    if (fq) return fq;
    const hit = this.forDocument(docPath).find((r) => r.name === name);
    if (hit) return hit;
    if (name.includes('/') || name.includes('\\')) {
      const p = expandHome(name);
      const root = path.isAbsolute(p) ? p : docPath ? path.resolve(path.dirname(docPath), p) : undefined;
      if (root && isRoleDir(root)) return { name, root, source: 'path' };
    }
    return undefined;
  }

  /** Files in one of the role's folders, as `tasks_from` etc. accept them (no extension). */
  entryFiles(role: RoleInfo, folder: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, rel: string, depth: number) => {
      for (const entry of safeReaddir(dir)) {
        const full = path.join(dir, entry);
        if (depth < 2 && isDir(full) && !entry.startsWith('.')) walk(full, `${rel}${entry}/`, depth + 1);
        const ext = path.extname(entry);
        if (YAML_EXT.includes(ext)) out.push(rel + entry.slice(0, -ext.length));
      }
    };
    walk(path.join(role.root, folder), '', 0);
    return out.sort((a, b) => (a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)));
  }

  /** The file `tasks_from: install` (or `install.yml`) points at, if it exists. */
  entryFile(role: RoleInfo, folder: string, file: string): string | undefined {
    const base = path.join(role.root, folder, file);
    return [base, ...YAML_EXT.map((e) => base + e)].find((f) => fs.existsSync(f) && !isDir(f));
  }

  /** Where go-to-definition on a role lands: tasks/main.yml, else meta/main.yml, else the folder. */
  mainFile(role: RoleInfo): string {
    return this.entryFile(role, 'tasks', 'main') ?? this.entryFile(role, 'meta', 'main') ?? role.root;
  }

  /** Description, author and dependencies from meta/, read on demand and cached. Variables come from `spec()`. */
  details(role: RoleInfo): RoleDetails {
    let d = this.detailsCache.get(role.root);
    if (d) return d;
    const meta = readYaml(path.join(role.root, 'meta', 'main')) ?? {};
    const main = readArgumentSpecs(role.root, meta)?.main ?? {};
    const info = meta.galaxy_info ?? {};
    // `ansible-galaxy role init` leaves this placeholder; many roles never replace it.
    const description = main.short_description ?? (info.description === 'your role description' ? undefined : info.description);
    d = {
      description: description ? cleanMarkup(String(description)) : undefined,
      author: info.author ? String(info.author) : undefined,
      dependencies: (Array.isArray(meta.dependencies) ? meta.dependencies : [])
        .map((x: any) => (typeof x === 'string' ? x : (x?.role ?? x?.name)))
        .filter((x: unknown): x is string => typeof x === 'string'),
    };
    this.detailsCache.set(role.root, d);
    return d;
  }

  /**
   * The variables a role takes at an entry point (`main`, or a `tasks_from`
   * file), from meta/argument_specs.yml. Roles without a spec for it fall back
   * to the keys in defaults/main.yml, minus `_private` ones, all optional.
   */
  spec(role: RoleInfo, entryPoint = 'main'): RoleSpec | undefined {
    const cacheKey = `${role.root}\0${entryPoint}`;
    if (this.specCache.has(cacheKey)) return this.specCache.get(cacheKey);
    const meta = readYaml(path.join(role.root, 'meta', 'main')) ?? {};
    const entry = readArgumentSpecs(role.root, meta)?.[entryPoint];
    let spec: RoleSpec | undefined;
    if (entry && typeof entry === 'object') {
      spec = {
        entryPoint,
        shortDescription: entry.short_description ? cleanMarkup(String(entry.short_description)) : undefined,
        description: [entry.description].flat().filter(Boolean).map((x) => cleanMarkup(String(x))).join('\n\n'),
        options: normaliseOptions(entry.options),
        source: 'argument_specs',
      };
    } else {
      const defaults = readDefaults(role.root);
      const options: Record<string, OptionDoc> = {};
      for (const [name, value] of Object.entries(defaults)) {
        if (name.startsWith('_')) continue;
        options[name] = {
          name,
          description: '',
          type: inferType(value),
          required: false,
          // Templated defaults (`{{ other_var }}`) aren't a useful value to suggest.
          default: typeof value === 'string' && value.includes('{{') ? undefined : value,
          aliases: [],
        };
      }
      spec = Object.keys(options).length ? { entryPoint, description: '', options, source: 'defaults' } : undefined;
    }
    this.specCache.set(cacheKey, spec);
    return spec;
  }

  private candidateRoots(): string[] {
    const roots: string[] = [];
    const push = (p?: string, base?: string) => {
      p = p?.trim();
      if (!p) return;
      p = expandHome(p);
      roots.push(base && !path.isAbsolute(p) ? path.join(base, p) : p);
    };
    this.opts.rolesPaths.forEach((p) => push(p, this.opts.workspaceFolders[0]));
    for (const ws of this.opts.workspaceFolders) {
      for (const p of readAnsibleCfgPaths(ws, 'roles_path')) push(p, ws);
    }
    process.env.ANSIBLE_ROLES_PATH?.split(path.delimiter).forEach((p) => push(p));
    push(path.join(os.homedir(), '.ansible', 'roles'));
    push('/usr/share/ansible/roles');
    push('/etc/ansible/roles');
    for (const ws of this.opts.workspaceFolders) push(path.join(ws, 'roles'));
    return Array.from(new Set(roots)).filter(isDir);
  }

  /**
   * `roles/` folders in the document's folder and its parents, up to the
   * workspace folder. A playbook's roles live next to it; a task file inside
   * `roles/web/tasks/` finds its sibling roles the same way.
   */
  private localRoleDirs(docPath?: string): string[] {
    if (!docPath) return [];
    const ws = this.opts.workspaceFolders.find((w) => docPath.startsWith(w + path.sep));
    const dirs: string[] = [];
    let dir = path.dirname(docPath);
    for (let i = 0; i < 10; i++) {
      const candidate = path.join(dir, 'roles');
      if (isDir(candidate)) dirs.push(candidate);
      if (dir === ws || (!ws && i >= 4)) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return dirs;
  }

  private scanDirCached(dir: string): RoleInfo[] {
    let roles = this.dirCache.get(dir);
    if (!roles) {
      roles = this.scanDir(dir, 'playbook');
      this.dirCache.set(dir, roles);
    }
    return roles;
  }

  private scanDir(dir: string, source: RoleSource): RoleInfo[] {
    const out: RoleInfo[] = [];
    for (const name of safeReaddir(dir)) {
      const root = path.join(dir, name);
      if (name.startsWith('.') || !isRoleDir(root)) continue;
      out.push({ name, root, source, version: readGalaxyInstallVersion(root) });
    }
    return out;
  }
}

/** `argument_specs:` from meta/argument_specs.yml, or from meta/main.yml (also allowed). */
function readArgumentSpecs(root: string, meta: any): Record<string, any> | undefined {
  const specs = readYaml(path.join(root, 'meta', 'argument_specs'))?.argument_specs ?? meta?.argument_specs;
  return specs && typeof specs === 'object' ? specs : undefined;
}

/** defaults/main.yml, or every file in a defaults/main/ folder merged in name order (as Ansible does). */
function readDefaults(root: string): Record<string, unknown> {
  const base = path.join(root, 'defaults', 'main');
  const asMap = (y: any) => (y && typeof y === 'object' && !Array.isArray(y) ? y : {});
  if (!isDir(base)) return asMap(readYaml(base));
  const out: Record<string, unknown> = {};
  for (const f of safeReaddir(base).sort()) {
    const ext = path.extname(f);
    if (YAML_EXT.includes(ext)) Object.assign(out, asMap(readYaml(path.join(base, f.slice(0, -ext.length)))));
  }
  return out;
}

function inferType(v: unknown): string | undefined {
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  if (v && typeof v === 'object') return 'dict';
  return undefined;
}

/** Ansible's own tags: `!unsafe` keeps the string as is, `!vault` is encrypted (no usable value). */
const ANSIBLE_TAGS = [
  { tag: '!unsafe', resolve: (str: string) => str },
  { tag: '!vault', resolve: () => null },
];

function readYaml(base: string): any {
  for (const ext of YAML_EXT) {
    try {
      return parseYaml(fs.readFileSync(base + ext, 'utf8'), { strict: false, uniqueKeys: false, customTags: ANSIBLE_TAGS, logLevel: 'error' });
    } catch {
      /* missing or unparseable: try the next extension */
    }
  }
  return undefined;
}

/** `ansible-galaxy role install` records the installed version in meta/.galaxy_install_info. */
function readGalaxyInstallVersion(root: string): string | undefined {
  try {
    const m = /^version:\s*['"]?([^'"\s]+)/m.exec(fs.readFileSync(path.join(root, 'meta', '.galaxy_install_info'), 'utf8'));
    return m?.[1];
  } catch {
    return undefined;
  }
}
