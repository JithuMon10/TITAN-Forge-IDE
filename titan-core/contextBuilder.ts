// titan-core/contextBuilder.ts

import { readFileSafe } from "./reader";
import {
  BuildContextInput,
  BuildContextOutput,
  ContextFile
} from "./types";

const DEFAULT_MAX_CHARS = 8000;

export function buildContext(
  input: BuildContextInput
): BuildContextOutput {
  const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
  let usedChars = 0;
  let truncated = false;

  const files: ContextFile[] = [];

  function tryAddFile(relativePath: string) {
    if (files.some(f => f.path === relativePath)) return;

    const file = readFileSafe(input.rootDir, relativePath);
    if (!file) return;

    if (usedChars + file.content.length > maxChars) {
      truncated = true;
      return;
    }

    files.push({
      path: file.path,
      content: file.content
    });

    usedChars += file.content.length;
  }

  // 1. Active file first (highest priority)
  if (input.activeFile) {
    tryAddFile(input.activeFile);
  }

  // 2. Explicitly requested files
  if (input.requestedFiles) {
    for (const file of input.requestedFiles) {
      tryAddFile(file);
    }
  }

  return { files, truncated };
}
