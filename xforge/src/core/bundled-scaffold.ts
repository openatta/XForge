import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CLI_NAME, CLI_VERSION, PROTOCOL_VERSION } from '../constants.js';
import { XForgeError, diagnostic } from './errors.js';
import { normalizeRelative } from './path-safety.js';
import { validateSchema } from './validator.js';
import { loadYaml } from './yaml.js';

interface ScaffoldDescriptor {
  apiVersion: string;
  kind: 'Scaffold';
  metadata: { version: string };
  protocol: string;
  payload: 'payload';
  integrity: { algorithm: 'sha256'; manifest: 'files.sha256' };
  xforgeCompatibility: { protocol: string };
}

export interface BundledScaffold {
  version: string;
  package: typeof CLI_NAME;
  root: string;
  files: Map<string, Buffer>;
}

const packageRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const scaffoldRoot = path.join(packageRoot, 'scaffold');

function invalid(message: string, file = 'scaffold/scaffold.yaml'): never {
  throw new XForgeError(diagnostic('XFORGE_BUNDLED_SCAFFOLD_INVALID', message, file));
}

async function payloadFiles(directory: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { invalid('The npm package does not contain its bundled Scaffold payload.', 'scaffold/payload'); }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) invalid(`Bundled Scaffold contains a forbidden symlink: ${relative}.`, `scaffold/payload/${relative}`);
    if (stat.isDirectory()) result.push(...await payloadFiles(absolute, relative));
    else if (stat.isFile()) result.push(relative);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

export async function loadBundledScaffold(): Promise<BundledScaffold> {
  const descriptorPath = path.join(scaffoldRoot, 'scaffold.yaml');
  let descriptor: ScaffoldDescriptor;
  try { descriptor = await loadYaml<ScaffoldDescriptor>(descriptorPath, 'scaffold/scaffold.yaml'); }
  catch { invalid('The npm package does not contain a readable Scaffold descriptor.'); }
  const schemaDiagnostics = await validateSchema('scaffold', descriptor, 'scaffold/scaffold.yaml');
  if (schemaDiagnostics.some((item) => item.severity === 'error')) throw new XForgeError(schemaDiagnostics);
  if (descriptor.metadata.version !== CLI_VERSION
    || descriptor.protocol !== PROTOCOL_VERSION
    || descriptor.xforgeCompatibility.protocol !== PROTOCOL_VERSION) {
    invalid(`Bundled Scaffold ${descriptor.metadata.version} is incompatible with ${CLI_NAME}@${CLI_VERSION}.`);
  }

  const digestPath = path.join(scaffoldRoot, descriptor.integrity.manifest);
  let digestText: string;
  try { digestText = await readFile(digestPath, 'utf8'); }
  catch { invalid('The npm package does not contain the Scaffold digest manifest.', 'scaffold/files.sha256'); }
  const expected = new Map<string, string>();
  for (const line of digestText.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{64})  payload\/(.+)$/);
    if (!match) invalid('The bundled Scaffold digest manifest is malformed.', 'scaffold/files.sha256');
    const relative = normalizeRelative(match[2]!, 'bundled Scaffold path');
    if (relative === '.' || expected.has(relative)) invalid('The bundled Scaffold digest manifest contains a duplicate or empty path.', 'scaffold/files.sha256');
    expected.set(relative, match[1]!);
  }

  const inventory = await payloadFiles(path.join(scaffoldRoot, descriptor.payload));
  if (inventory.length !== expected.size || inventory.some((relative) => !expected.has(relative))) {
    invalid('The bundled Scaffold inventory does not match files.sha256.', 'scaffold/files.sha256');
  }
  const files = new Map<string, Buffer>();
  for (const relative of inventory) {
    const content = await readFile(path.join(scaffoldRoot, descriptor.payload, ...relative.split('/')));
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== expected.get(relative)) invalid(`Bundled Scaffold digest mismatch: ${relative}.`, 'scaffold/files.sha256');
    files.set(relative, content);
  }
  return { version: descriptor.metadata.version, package: CLI_NAME, root: scaffoldRoot, files };
}
