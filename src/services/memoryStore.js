import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { config } from '../config.js';
import { readTextFileInDriveSubfolder } from './googleDriveState.js';

function normalizeString(value, maxLength = 500) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function normalizeMemoryRelativePath(path) {
  const raw = String(path || '').trim().replace(/\\/g, '/');
  if (!raw) return '';

  const folderPrefix = `${String(config.googleDrive.memoryFolderName || 'memory').trim()}/`;
  const withoutPrefix = raw.startsWith(folderPrefix) ? raw.slice(folderPrefix.length) : raw;
  const withoutDotPrefix = withoutPrefix.replace(/^(\.\/)+/, '');
  if (!withoutDotPrefix) return '';

  const segments = withoutDotPrefix.split('/').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    return '';
  }

  return segments.join('/');
}

function normalizeRegistryAliases(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(new Set(value.map((item) => normalizeString(item, 120)).filter(Boolean))).slice(0, 20);
}

export function normalizeMemoryRegistryEntry(rawEntry) {
  if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
    return null;
  }

  const id = normalizeString(rawEntry.id, 120);
  const name = normalizeString(rawEntry.name, 200);
  const description = normalizeString(rawEntry.description, 400);
  const type = normalizeString(rawEntry.type, 80);
  const path = normalizeMemoryRelativePath(rawEntry.path);

  if (!id || !name || !description || !type || !path) {
    return null;
  }

  return {
    id,
    name,
    aliases: normalizeRegistryAliases(rawEntry.aliases),
    description,
    type,
    path
  };
}

function normalizeRegistryEntries(rawRegistry) {
  const sourceEntries = Array.isArray(rawRegistry)
    ? rawRegistry
    : Array.isArray(rawRegistry?.nodes)
      ? rawRegistry.nodes
      : Array.isArray(rawRegistry?.entries)
        ? rawRegistry.entries
        : [];

  const normalized = [];
  const seenIds = new Set();
  for (const entry of sourceEntries) {
    const candidate = normalizeMemoryRegistryEntry(entry);
    if (!candidate || seenIds.has(candidate.id)) {
      continue;
    }
    seenIds.add(candidate.id);
    normalized.push(candidate);
  }

  return normalized;
}

export function parseMemoryFrontmatter(markdown) {
  const normalized = String(markdown || '').replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: normalized.trim() };
  }

  const frontmatter = parseYaml(match[1]) || {};
  return {
    frontmatter: frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter)
      ? frontmatter
      : {},
    body: String(match[2] || '').trim()
  };
}

function normalizeLinkToken(value) {
  const normalized = normalizeString(value, 200);
  return normalized || '';
}

function normalizeMemoryLink(rawLink) {
  if (typeof rawLink === 'string') {
    const normalized = normalizeLinkToken(rawLink);
    if (!normalized) return null;

    const normalizedPath = normalizeMemoryRelativePath(normalized);
    return {
      id: normalizedPath ? '' : normalized,
      path: normalizedPath,
      label: '',
      type: ''
    };
  }

  if (!rawLink || typeof rawLink !== 'object' || Array.isArray(rawLink)) {
    return null;
  }

  const id = normalizeLinkToken(rawLink.id || rawLink.nodeId || rawLink.target);
  const path = normalizeMemoryRelativePath(rawLink.path);
  const label = normalizeString(rawLink.label, 200);
  const type = normalizeString(rawLink.type, 80);

  if (!id && !path) {
    return null;
  }

  return {
    id,
    path,
    label,
    type
  };
}

export function normalizeMemoryLinks(rawLinks) {
  const links = Array.isArray(rawLinks) ? rawLinks : [];
  const collected = [];
  const seenKeys = new Set();

  for (const link of links) {
    const normalized = normalizeMemoryLink(link);
    if (!normalized) {
      continue;
    }

    const dedupeKey = normalized.id || normalized.path;
    if (!dedupeKey || seenKeys.has(dedupeKey)) {
      continue;
    }

    seenKeys.add(dedupeKey);
    collected.push(normalized);
  }

  return collected.slice(0, 50);
}

export function normalizeMemoryAccessScopes(rawAccess) {
  const scopes = Array.isArray(rawAccess?.scopes)
    ? rawAccess.scopes
    : typeof rawAccess?.scopes === 'string'
      ? [rawAccess.scopes]
      : [];

  return Array.from(new Set(
    scopes
      .map((scope) => normalizeString(scope, 120))
      .filter(Boolean)
  )).slice(0, 20);
}

export function stringifyMemoryMarkdown({ frontmatter, body }) {
  const normalizedFrontmatter =
    frontmatter && typeof frontmatter === 'object' && !Array.isArray(frontmatter)
      ? frontmatter
      : {};
  const yamlText = stringifyYaml(normalizedFrontmatter).trimEnd();
  const normalizedBody = String(body || '').replace(/\r\n/g, '\n').trim();

  if (!yamlText) {
    return normalizedBody ? `${normalizedBody}\n` : '';
  }

  if (!normalizedBody) {
    return `---\n${yamlText}\n---\n`;
  }

  return `---\n${yamlText}\n---\n\n${normalizedBody}\n`;
}

export async function readMemoryIndexMarkdown() {
  return readTextFileInDriveSubfolder({
    folderName: config.googleDrive.memoryFolderName,
    relativePath: 'index.md'
  });
}

export async function readMemoryRegistry() {
  const raw = await readTextFileInDriveSubfolder({
    folderName: config.googleDrive.memoryFolderName,
    relativePath: 'node-registry.yaml'
  });

  return normalizeRegistryEntries(parseYaml(raw) || {});
}

export async function readMemoryNodeContent(registryEntry) {
  const path = normalizeMemoryRelativePath(registryEntry?.path);
  if (!path) {
    throw new Error(`Invalid memory node path for: ${String(registryEntry?.id || '').trim() || '(unknown)'}`);
  }

  const markdown = await readTextFileInDriveSubfolder({
    folderName: config.googleDrive.memoryFolderName,
    relativePath: path
  });
  const { frontmatter, body } = parseMemoryFrontmatter(markdown);

  return {
    entry: registryEntry,
    markdown,
    body,
    frontmatter,
    links: normalizeMemoryLinks(frontmatter.links)
  };
}

export async function loadMemoryStore() {
  const [indexMarkdown, registryEntries] = await Promise.all([
    readMemoryIndexMarkdown(),
    readMemoryRegistry()
  ]);

  const registryById = new Map();
  const registryByPath = new Map();

  for (const entry of registryEntries) {
    registryById.set(entry.id, entry);
    registryByPath.set(entry.path, entry);
  }

  return {
    indexMarkdown,
    registryEntries,
    registryById,
    registryByPath
  };
}

export function resolveLinkedRegistryEntries(node, registryById, registryByPath) {
  const resolved = [];
  const seenIds = new Set();

  for (const link of Array.isArray(node?.links) ? node.links : []) {
    const entry = registryById.get(link.id) || registryByPath.get(link.path);
    if (!entry || seenIds.has(entry.id)) {
      continue;
    }

    seenIds.add(entry.id);
    resolved.push({
      entry,
      link: {
        id: link.id,
        path: link.path,
        label: link.label,
        type: link.type
      }
    });
  }

  return resolved;
}
