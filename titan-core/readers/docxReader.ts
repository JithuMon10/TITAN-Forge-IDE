import AdmZip from 'adm-zip';
import { DocumentReadResult } from '../types';

const MAX_DOCX_CHARS = 50 * 1024; // 50 KB

export async function readDocxDocument(
  fullPath: string,
  relativePath: string
): Promise<DocumentReadResult | null> {
  try {
    const zip = new AdmZip(fullPath);
    const documentEntry = findEntry(zip, 'word/document.xml');
    if (!documentEntry) {
      return null;
    }

    const xml = documentEntry.getData().toString('utf8');
    const matches = Array.from(xml.matchAll(/<w:t[^>]*>(.*?)<\/w:t>/g)) as RegExpMatchArray[];
    const textSegments = matches.map((match) => decodeXml(match[1] ?? ''));
    if (textSegments.length === 0) {
      return null;
    }

    const combined = textSegments.join('').replace(/\r/g, '').replace(/\u0000/g, '');
    const normalized = combined.replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
    const truncated = normalized.length > MAX_DOCX_CHARS;
    const text = truncated ? normalized.slice(0, MAX_DOCX_CHARS) : normalized;

    return {
      path: relativePath,
      type: 'docx',
      text,
      truncated,
      source: 'disk',
      capturedAt: Date.now()
    };
  } catch {
    return null;
  }
}

function findEntry(zip: AdmZip, target: string): AdmZip.IZipEntry | undefined {
  const normalizedTarget = normalizeEntryName(target);
  return zip.getEntries().find((entry) => normalizeEntryName(entry.entryName) === normalizedTarget);
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function normalizeEntryName(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.?\//, '');
}
