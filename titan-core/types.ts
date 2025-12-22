// titan-core/types.ts

export type FileInfo = {
  path: string;      // relative to workspace root
  language: string;  // inferred from extension
  size: number;      // bytes
};

// titan-core/types.ts

export type FileContent = {
  path: string;     // relative path
  content: string;  // file text (possibly truncated)
  truncated: boolean;
};

// titan-core/types.ts

export type ContextFile = {
  path: string;
  content: string;
};

export type BuildContextInput = {
  rootDir: string;
  activeFile?: string;
  requestedFiles?: string[];
  maxChars?: number;
};

export type BuildContextOutput = {
  files: ContextFile[];
  truncated: boolean;
};
