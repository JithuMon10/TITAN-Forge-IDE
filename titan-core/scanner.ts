// titan-core/scanner.ts

import * as fs from "fs";
import * as path from "path";
import { FileInfo } from "./types";

/** Folders we NEVER scan */
const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".vscode",
]);

/** File extensions we care about */
const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".js": "javascript",
  ".py": "python",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".java": "java",
  ".json": "json",
  ".md": "markdown",
  ".txt": "text",
  ".pdf": "pdf",
  ".docx": "docx",
};

export function scanWorkspace(rootDir: string): FileInfo[] {
  const results: FileInfo[] = [];

  function walk(currentDir: string) {
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory → skip safely
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name);
      const language = EXTENSION_LANGUAGE_MAP[ext];
      if (!language) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      results.push({
        path: path.relative(rootDir, fullPath),
        language,
        size: stat.size,
      });
    }
  }

  walk(rootDir);
  return results;
}
