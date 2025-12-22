import { readFileSafe } from './reader';
import { BuildContextInput, BuildContextOutput, ContextFile } from './types';

const DEFAULT_MAX_CHARS = 8000;

export function buildContext(input: BuildContextInput): BuildContextOutput {
  const rootDir = input.rootDir ?? process.cwd();
  const maxChars =
    typeof input.maxChars === 'number' && input.maxChars > 0 ? input.maxChars : DEFAULT_MAX_CHARS;

  const files: ContextFile[] = [];
  let usedChars = 0;
  let truncated = false;

  const tryAddFile = (relativePath: string | undefined): void => {
    if (!relativePath) {
      return;
    }
    const normalized = normalizePath(relativePath);
    if (!normalized || files.some((f) => f.path === normalized)) {
      return;
    }

    const file = readFileSafe(rootDir, normalized);
    if (!file) {
      return;
    }

    const remaining = maxChars - usedChars;
    if (remaining <= 0) {
      truncated = true;
      return;
    }

    const content = file.content.length > remaining ? file.content.slice(0, remaining) : file.content;
    if (content.length < file.content.length) {
      truncated = true;
    }

    files.push({ path: file.path, content });
    usedChars += content.length;
  };

  tryAddFile(input.activeFile);

  for (const file of input.requestedFiles ?? []) {
    tryAddFile(file);
  }

  return { files, truncated };
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.?\//, '').trim();
}
