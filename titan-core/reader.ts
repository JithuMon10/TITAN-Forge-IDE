import { promises as fs, Stats } from 'fs';
import * as path from 'path';
import { DocumentReadResult, DocumentType } from './types';
import { readTextDocument } from './readers/textReader';
import { readPdfDocument } from './readers/pdfReader';
import { readDocxDocument } from './readers/docxReader';

const TEXT_EXTENSION_MAP = new Map<string, DocumentType>([
  ['.ts', 'code'],
  ['.js', 'code'],
  ['.json', 'json'],
  ['.md', 'text'],
  ['.txt', 'text']
]);

export async function readDocument(rootDir: string, relativePath: string): Promise<DocumentReadResult | null> {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    return null;
  }

  const fullPath = path.join(rootDir, normalized);

  let stat: Stats;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    return null;
  }

  if (!stat.isFile()) {
    return null;
  }

  const ext = path.extname(fullPath).toLowerCase();
  const textType = TEXT_EXTENSION_MAP.get(ext);
  if (textType) {
    return await readTextDocument(fullPath, normalized, textType);
  }

  if (ext === '.pdf') {
    return await readPdfDocument(fullPath, normalized);
  }

  if (ext === '.docx') {
    return await readDocxDocument(fullPath, normalized);
  }

  return null;
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.?\//, '').trim();
}
