import { promises as fs } from 'fs';
import { DocumentReadResult } from '../types';

type PdfParseResult = {
  text?: string;
};

type PdfParseFn = (data: Buffer) => Promise<PdfParseResult>;

// Force pdf-parse to use the Node.js-specific build to avoid browser-only code.
const pdfParse: PdfParseFn = require('pdf-parse/node');

const MAX_PDF_CHARS = 50 * 1024; // 50 KB

export async function readPdfDocument(
  fullPath: string,
  relativePath: string
): Promise<DocumentReadResult | null> {
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(fullPath);
  } catch {
    return null;
  }

  const parsedText = await tryParsePdf(buffer);
  const normalized = normalizeText(parsedText ?? fallbackText(buffer));
  const safeText = normalized.length > 0 ? normalized : '[PDF contains no readable text]';

  const truncated = safeText.length > MAX_PDF_CHARS;
  const text = truncated ? safeText.slice(0, MAX_PDF_CHARS) : safeText;
  return {
    path: relativePath,
    type: 'pdf',
    text,
    truncated,
    source: 'disk',
    capturedAt: Date.now()
  };
}

async function tryParsePdf(buffer: Buffer): Promise<string | undefined> {
  try {
    const result = await pdfParse(buffer);
    if (result && typeof result.text === 'string' && result.text.trim().length > 0) {
      return result.text;
    }
  } catch {
    // swallow parse failures – fallback will handle
  }
  return undefined;
}

function fallbackText(buffer: Buffer): string {
  const text = buffer
    .toString('utf8')
    .replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, ' ')
    .trim();
  return text;
}

function normalizeText(value: string): string {
  return value
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
