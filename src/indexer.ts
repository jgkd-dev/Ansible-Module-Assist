import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AnsibleCli, expandHome } from './exec';
import { BUILTIN_FALLBACK } from './builtinFallback';

export interface ModuleInfo {
  fqcn: string;
  namespace: string;
  collection: string;
  name: string;
  /** Source file (.py / .ps1) if known. */
  file?: string;
  shortDescription?: string;
}

export type CollectionSource = 'builtin' | 'cli' | 'scan' | 'fallback';

export interface CollectionInfo {
  namespace: string;
  name: string;
  fqcn: string;
  version?: string;
  /** Collection root directory (contains plugins/, galaxy.yml / MANIFEST.json). */
  root?: string;
  modulesDir?: string;
  source: CollectionSource;
  modules?: Map<string, ModuleInfo>;
  loading?: Promise<Map<string, ModuleInfo>>;
}

export interface IndexOptions {
  ansibleBinPath?: string;
  collectionsPaths: string[];
  workspaceFolders: string[];
  includeDeprecated: boolean;
  timeoutMs?: number;
}

export class ModuleIndex {
  /** namespace -> collection name -> info */
  readonly namespaces = new Map<string, Map<string, CollectionInfo>>();
  cliAvailable = false;
  ansibleVersion?: string;
  readonly cli: AnsibleCli;
  readonly log: string[] = [];

  constructor(private opts: IndexOptions) {
    this.cli = new AnsibleCli(opts.ansibleBinPath, opts.workspaceFolders, opts.timeoutMs ?? 20000);
  }

  get collectionCount(): number {
    let n = 0;
    for (const c of this.namespaces.values()) n += c.size;
    return n;
  }

  allCollections(): CollectionInfo[] {
    const out: CollectionInfo[] = [];
    for (const c of this.namespaces.values()) out.push(...c.values());
    return out.sort((a, b) => a.fqcn.localeCompare(b.fqcn));
  }

  getCollection(namespace: string, name: string): CollectionInfo | undefined {
    return this.namespaces.get(namespace)?.get(name);
  }

  private add(info: CollectionInfo): void {
    let ns = this.namespaces.get(info.namespace);
    if (!ns) {
      ns = new Map();
      this.namespaces.set(info.namespace, ns);
    }
    // First found wins, which mirrors Ansible's collections path precedence.
    if (!ns.has(info.name)) ns.set(info.name, info);
  }

  /** Discover ansible.builtin and every installed collection. */
  async build(): Promise<void> {
    this.namespaces.clear();
    const cwd = this.opts.workspaceFolders[0];

    const [versionOut, galaxyOut] = await Promise.all([
      this.cli.run('ansible', ['--version'], cwd),
      this.cli.run('ansible-galaxy', ['collection', 'list', '--format', 'json'], cwd),
    ]);

    // ansible.builtin
    let builtinLocation: string | undefined;
    if (versionOut) {
      this.cliAvailable = true;
      this.ansibleVersion = /core\s+([\d.]+\w*)/.exec(versionOut)?.[1];
      builtinLocation = /ansible python module location\s*=\s*(.+)/.exec(versionOut)?.[1]?.trim();
      this.log.push(`ansible-core ${this.ansibleVersion ?? '?'} at ${builtinLocation ?? '?'}`);
    } else {
      this.log.push('ansible CLI not found; using bundled ansible.builtin list');
    }
    const builtinModules = builtinLocation ? path.join(builtinLocation, 'modules') : undefined;
    if (builtinModules && isDir(builtinModules)) {
      this.add({ namespace: 'ansible', name: 'builtin', fqcn: 'ansible.builtin', version: this.ansibleVersion, root: builtinLocation, modulesDir: builtinModules, source: 'builtin' });
    } else {
      const modules = new Map<string, ModuleInfo>();
      for (const [name, desc] of Object.entries(BUILTIN_FALLBACK)) {
        modules.set(name, { fqcn: `ansible.builtin.${name}`, namespace: 'ansible', collection: 'builtin', name, shortDescription: desc });
      }
      this.add({ namespace: 'ansible', name: 'builtin', fqcn: 'ansible.builtin', source: 'fallback', modules });
    }

    // Collections reported by ansible-galaxy (respects ansible.cfg + env vars)
    if (galaxyOut) {
      const json = parseJsonLoose(galaxyOut);
      if (json && typeof json === 'object') {
        for (const [collPath, colls] of Object.entries<Record<string, { version?: string }>>(json)) {
          for (const [fqcn, meta] of Object.entries(colls ?? {})) {
            const [namespace, name] = fqcn.split('.');
            if (!namespace || !name) continue;
            const root = path.join(collPath, namespace, name);
            this.add({ namespace, name, fqcn, version: meta?.version, root, modulesDir: path.join(root, 'plugins', 'modules'), source: 'cli' });
          }
        }
      }
    }

    // Filesystem scan: catches anything the CLI missed or when the CLI isn't on PATH.
    const roots = this.candidateRoots(builtinLocation);
    for (const root of roots) this.scanRoot(root);

    this.log.push(`indexed ${this.collectionCount} collections`);
  }

  private candidateRoots(builtinLocation?: string): string[] {
    const roots: string[] = [];
    const push = (p?: string) => {
      if (!p) return;
      p = expandHome(p.trim());
      if (!p) return;
      roots.push(path.basename(p) === 'ansible_collections' ? p : path.join(p, 'ansible_collections'));
    };
    this.opts.collectionsPaths.forEach(push);
    for (const ws of this.opts.workspaceFolders) {
      for (const p of readAnsibleCfgCollectionPaths(ws)) push(path.isAbsolute(expandHome(p)) ? p : path.join(ws, p));
      push(path.join(ws, 'collections'));
      push(ws);
    }
    for (const v of [process.env.ANSIBLE_COLLECTIONS_PATH, process.env.ANSIBLE_COLLECTIONS_PATHS]) {
      v?.split(path.delimiter).forEach(push);
    }
    push(path.join(os.homedir(), '.ansible', 'collections'));
    push('/usr/share/ansible/collections');
    // The full `ansible` pip package installs collections next to ansible-core.
    if (builtinLocation) push(path.dirname(builtinLocation));
    return Array.from(new Set(roots)).filter(isDir);
  }

  private scanRoot(root: string): void {
    for (const namespace of safeReaddir(root)) {
      if (namespace.startsWith('.') || !/^[a-z0-9_]+$/i.test(namespace)) continue;
      const nsDir = path.join(root, namespace);
      if (!isDir(nsDir)) continue;
      for (const name of safeReaddir(nsDir)) {
        if (name.startsWith('.') || name.endsWith('.info') || !/^[a-z0-9_]+$/i.test(name)) continue;
        const collRoot = path.join(nsDir, name);
        const modulesDir = path.join(collRoot, 'plugins', 'modules');
        const hasMeta = ['MANIFEST.json', 'galaxy.yml', 'galaxy.yaml'].some((f) => fs.existsSync(path.join(collRoot, f)));
        if (!hasMeta && !isDir(modulesDir)) continue;
        this.add({ namespace, name, fqcn: `${namespace}.${name}`, version: readCollectionVersion(collRoot), root: collRoot, modulesDir, source: 'scan' });
      }
    }
  }

  /** Lists (and caches) the modules in one collection, including short descriptions. */
  async getModules(coll: CollectionInfo): Promise<Map<string, ModuleInfo>> {
    if (coll.modules) return coll.modules;
    if (!coll.loading) {
      coll.loading = this.loadModules(coll).then((m) => {
        coll.modules = m;
        coll.loading = undefined;
        return m;
      });
    }
    return coll.loading;
  }

  private async loadModules(coll: CollectionInfo): Promise<Map<string, ModuleInfo>> {
    const modules = new Map<string, ModuleInfo>();
    if (!coll.modulesDir || !isDir(coll.modulesDir)) return modules;

    const files = new Map<string, string>(); // name -> preferred file
    const walk = (dir: string, depth: number) => {
      for (const entry of safeReaddir(dir)) {
        const full = path.join(dir, entry);
        if (depth < 2 && isDir(full) && !entry.startsWith('_') && entry !== '__pycache__') {
          walk(full, depth + 1);
          continue;
        }
        const m = /^(.+)\.(py|ps1)$/.exec(entry);
        if (!m) continue;
        const name = m[1];
        if (name === '__init__') continue;
        if (name.startsWith('_') && !this.opts.includeDeprecated) continue;
        // Prefer .py: for Windows modules the .py file holds the documentation.
        if (!files.has(name) || m[2] === 'py') files.set(name, full);
      }
    };
    walk(coll.modulesDir, 0);

    await Promise.all(
      Array.from(files.entries()).map(async ([name, file]) => {
        const shortDescription = await readShortDescription(file);
        modules.set(name, { fqcn: `${coll.fqcn}.${name}`, namespace: coll.namespace, collection: coll.name, name, file, shortDescription });
      }),
    );
    return new Map(Array.from(modules.entries()).sort((a, b) => a[0].localeCompare(b[0])));
  }

  /**
   * Resolve what a user wrote as a task key to a module.
   * FQCN → exact lookup. Short name → ansible.builtin first (Ansible's default),
   * then a unique match in any already-loaded collection.
   */
  async resolveModule(key: string): Promise<ModuleInfo | undefined> {
    const parts = key.split('.');
    if (parts.length === 3) {
      const coll = this.getCollection(parts[0], parts[1]);
      if (!coll) return undefined;
      return (await this.getModules(coll)).get(parts[2]);
    }
    if (parts.length === 1) {
      const builtin = this.getCollection('ansible', 'builtin');
      if (builtin) {
        const hit = (await this.getModules(builtin)).get(key);
        if (hit) return hit;
      }
      const hits: ModuleInfo[] = [];
      for (const coll of this.allCollections()) {
        const m = coll.modules?.get(key);
        if (m) hits.push(m);
      }
      return hits.length === 1 ? hits[0] : undefined;
    }
    return undefined;
  }
}

async function readShortDescription(file: string): Promise<string | undefined> {
  try {
    const sidecar = file.replace(/\.(py|ps1)$/, '.yml');
    const text = await fs.promises.readFile(fs.existsSync(sidecar) ? sidecar : file, 'utf8');
    const m = /^\s*short_description:\s*(.+)$/m.exec(text);
    if (!m) return undefined;
    return m[1].trim().replace(/^['"]|['"]$/g, '').replace(/[CIBMLU]\(([^)]*)\)/g, '$1');
  } catch {
    return undefined;
  }
}

function readCollectionVersion(root: string): string | undefined {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'MANIFEST.json'), 'utf8'));
    return manifest?.collection_info?.version;
  } catch {
    /* fall through */
  }
  for (const f of ['galaxy.yml', 'galaxy.yaml']) {
    try {
      const m = /^version:\s*['"]?([^'"\s]+)/m.exec(fs.readFileSync(path.join(root, f), 'utf8'));
      if (m) return m[1];
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function readAnsibleCfgCollectionPaths(ws: string): string[] {
  try {
    const cfg = fs.readFileSync(path.join(ws, 'ansible.cfg'), 'utf8');
    const m = /^\s*collections_paths?\s*=\s*(.+)$/m.exec(cfg);
    return m ? m[1].split(':').map((s) => s.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseJsonLoose(text: string): any {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
