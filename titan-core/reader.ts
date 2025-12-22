// titan-core/reader.ts

import * as fs from "fs";
import * as path from "path";
import { FileContent } from "./types";

const MAX_FILE_SIZE = 50 * 1024; // 50 KB

export function readFileSafe(
  rootDir: string,
  relativePath: string
): FileContent | null {
  const fullPath = path.join(rootDir, relativePath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    return null;
  }

  if (!stat.isFile()) return null;

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(fullPath);
  } catch {
    return null;
  }

  const truncated = buffer.length > MAX_FILE_SIZE;
  const content = truncated
    ? buffer.slice(0, MAX_FILE_SIZE).toString("utf-8")
    : buffer.toString("utf-8");

  return {
    path: relativePath,
    content,
    truncated,
  };
}
