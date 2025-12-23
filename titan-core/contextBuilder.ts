import { readDocument } from './reader';
import {
  BuildContextInput,
  BuildContextOutput,
  ContextFile,
  DocumentOverride,
  DocumentReadResult
} from './types';

const DEFAULT_MAX_CHARS = 8000;

export async function buildContext(input: BuildContextInput): Promise<BuildContextOutput> {
  const rootDir = input.rootDir ?? process.cwd();
  const maxChars =
    typeof input.maxChars === 'number' && input.maxChars > 0 ? input.maxChars : DEFAULT_MAX_CHARS;

  const files: ContextFile[] = [];
  const seen = new Set<string>();
  let usedChars = 0;
  let truncated = false;

  const overrides = buildOverrideMap(input.overrides);
  const protectedPaths = buildProtectedPathSet(input.protectedPaths);

  const tryAddFile = async (relativePath?: string): Promise<void> => {
    if (!relativePath) {
      return;
    }
    const normalized = normalizePath(relativePath);
    if (!normalized || seen.has(normalized)) {
      return;
    }

    if (protectedPaths.has(normalized) && !overrides.has(normalized)) {
      throw new Error(
        `Cannot read ${relativePath} from disk: open editor buffer must be provided as an override.`
      );
    }

    const document = await resolveDocument(rootDir, normalized, overrides);
    if (!document) {
      if (protectedPaths.has(normalized)) {
        throw new Error(`Editor buffer for ${relativePath} was not available.`);
      }
      return;
    }

    const remaining = maxChars - usedChars;
    if (remaining <= 0) {
      truncated = true;
      return;
    }

    const content = document.text.length > remaining ? document.text.slice(0, remaining) : document.text;
    if (content.length < document.text.length || document.truncated) {
      truncated = true;
    }

    files.push({
      path: document.path,
      type: document.type,
      content,
      source: document.source,
      version: document.version,
      capturedAt: document.capturedAt
    });
    seen.add(normalized);
    usedChars += content.length;
  };

  await tryAddFile(input.activeFile);

  for (const file of input.requestedFiles ?? []) {
    await tryAddFile(file);
  }

  return { files, totalChars: usedChars, truncated };
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\?\//, '').trim().toLowerCase();
}

function buildOverrideMap(overrides: DocumentOverride[] | undefined): Map<string, DocumentOverride> {
  const map = new Map<string, DocumentOverride>();
  if (!overrides) {
    return map;
  }
  for (const override of overrides) {
    const key = normalizePath(override.path);
    if (!key) {
      continue;
    }
    map.set(key, { ...override });
  }
  return map;
}

function buildProtectedPathSet(paths: string[] | undefined): Set<string> {
  const set = new Set<string>();
  if (!paths) {
    return set;
  }
  for (const entry of paths) {
    const normalized = normalizePath(entry);
    if (normalized) {
      set.add(normalized);
    }
  }
  return set;
}

async function resolveDocument(
  rootDir: string,
  normalizedPath: string,
  overrides: Map<string, DocumentOverride>
): Promise<DocumentReadResult | null> {
  const override = overrides.get(normalizedPath);
  if (override) {
    return {
      path: override.path,
      type: override.type ?? 'code',
      text: override.content ?? '',
      truncated: Boolean(override.truncated),
      source: 'editor',
      version: override.version,
      capturedAt: override.capturedAt
    };
  }

  return await readDocument(rootDir, normalizedPath);
}
