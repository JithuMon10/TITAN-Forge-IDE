import * as fs from 'fs/promises';
import { DocumentReadResult, DocumentType } from '../types';

const MAX_TEXT_BYTES = 50 * 1024; // 50 KB

export async function readTextDocument(
  fullPath: string,
  relativePath: string,
  type: DocumentType
): Promise<DocumentReadResult | null> {
  try {
    const buffer = await fs.readFile(fullPath);
    const truncated = buffer.length > MAX_TEXT_BYTES;
    const slice = truncated ? buffer.slice(0, MAX_TEXT_BYTES) : buffer;
    const text = slice.toString('utf8');
    return {
      path: relativePath,
      type,
      text,
      truncated,
      source: 'disk',
      capturedAt: Date.now()
    };
  } catch {
    return null;
  }
}
