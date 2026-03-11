import { parse as parseYaml } from 'yaml';
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
  const segments = withoutPrefix.split('/').map((segment) => segment.trim()).filter(Boolean);
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

export function normalizeMemoryLinks(rawLinks) {
  const links = Array.isArray(rawLinks) ? rawLinks : [];
  const collected = [];

  for (const link of links) {
    if (typeof link === 'string') {
      const normalized = normalizeLinkToken(link);
      if (normalized) collected.push(normalized);
      continue;
    }

    if (!link || typeof link !== 'object' || Array.isArray(link)) {
      continue;
    }

    const normalized = [
      normalizeLinkToken(link.id),
      normalizeLinkToken(link.nodeId),
      normalizeLinkToken(link.target),
      normalizeMemoryRelativePath(link.path)
    ].find(Boolean);

    if (normalized) {
      collected.push(normalized);
    }
  }

  return Array.from(new Set(collected)).slice(0, 50);
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
    const entry = registryById.get(link) || registryByPath.get(normalizeMemoryRelativePath(link));
    if (!entry || seenIds.has(entry.id)) {
      continue;
    }

    seenIds.add(entry.id);
    resolved.push(entry);
  }

  return resolved;
}
