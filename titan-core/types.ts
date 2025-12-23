// titan-core/types.ts

export type FileInfo = {
  path: string;      // relative to workspace root
  language: string;  // inferred from extension
  size: number;      // bytes
};

// titan-core/types.ts

export type DocumentType = 'code' | 'text' | 'json' | 'pdf' | 'docx';

export type DocumentReadResult = {
  path: string;
  type: DocumentType;
  text: string;
  truncated: boolean;
  source: 'editor' | 'disk';
  version?: number;
  capturedAt?: number;
};

export type DocumentOverride = {
  path: string;
  content: string;
  type?: DocumentType;
  truncated?: boolean;
  version?: number;
  capturedAt?: number;
};

// titan-core/types.ts

export type ContextFile = {
  path: string;
  type: DocumentType;
  content: string;
  source: 'editor' | 'disk';
  version?: number;
  capturedAt?: number;
};

export type BuildContextInput = {
  rootDir: string;
  activeFile?: string;
  requestedFiles?: string[];
  maxChars?: number;
  overrides?: DocumentOverride[];
  protectedPaths?: string[];
};

export type BuildContextOutput = {
  files: ContextFile[];
  totalChars: number;
  truncated: boolean;
};

// titan-core/types.ts

export type ReasoningResult = {
  answer: string;
};
