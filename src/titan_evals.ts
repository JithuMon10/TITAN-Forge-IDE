import assert from 'assert';
import path from 'path';
import type { OutputChannel } from 'vscode';

type ScriptedStream = {
  raw: string;
  sanitized?: string;
};

type EvalCase = {
  name: string;
  prompt: string;
  script: ScriptedStream[];
  requiredTools: string[];
  expectIncludes?: string[];
};

const Module = require('module') as typeof import('module') & {
  _titanPatched?: boolean;
  _load?: (request: string, parent: NodeModule, isMain: boolean) => unknown;
};
const originalLoad = Module._load as ((request: string, parent: NodeModule, isMain: boolean) => unknown) | undefined;

const workspaceRoot = path.join(process.cwd(), 'mock-workspace');

interface WorkspaceNode {
  type: 'file' | 'dir';
  content?: string;
  children?: Record<string, WorkspaceNode>;
}

const workspaceTree: WorkspaceNode = {
  type: 'dir',
  children: {
    'polyadd.ts': {
      type: 'file',
      content: `export function polyadd(a: number, b: number): number {
  return a + b;
}
`
    },
    'README.md': {
      type: 'file',
      content: `# Titan Forge Mock Workspace\n\nThis mock project is used for automated agent evaluation.\n\n- Entry point: src/index.ts\n- Components: src/components/LoginButton.tsx\n`
    },
    'package.json': {
      type: 'file',
      content: `{
  "name": "mock-titan-project",
  "version": "0.0.0"
}
`
    },
    src: {
      type: 'dir',
      children: {
        'index.ts': {
          type: 'file',
          content: `export function start(): void {
  console.log('Starting mock project');
}
`
        },
        'app.tsx': {
          type: 'file',
          content: `import React from 'react';
export function App(): JSX.Element {
  return <div>Mock App</div>;
}
`
        },
        components: {
          type: 'dir',
          children: {
            'LoginButton.tsx': {
              type: 'file',
              content: `export function LoginButton(): JSX.Element {
  return <button>Login</button>;
}
`
            }
          }
        }
      }
    }
  }
};

type FileTypeEnum = {
  File: number;
  Directory: number;
  SymbolicLink: number;
  Unknown: number;
};

const FileType: FileTypeEnum = {
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
  Unknown: 0
};

function createUri(fsPath: string): any {
  const normalized = path.normalize(fsPath);
  return {
    fsPath: normalized,
    path: normalized.replace(/\\/g, '/'),
    toString: () => normalized,
    with: ({ path: newPath }: { path?: string }) => createUri(newPath ?? normalized)
  };
}

class RelativePattern {
  constructor(public readonly base: any, public readonly pattern: string) { }
}

class Memento {
  private store = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T | undefined {
    if (this.store.has(key)) {
      return this.store.get(key) as T;
    }
    return defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
}

class MockTextDocument {
  constructor(private readonly value: string, public readonly uri: any) { }

  getText(): string {
    return this.value;
  }
}

class MockOutputChannel implements OutputChannel {
  readonly name: string;
  private readonly lines: string[] = [];

  constructor(name: string) {
    this.name = name;
  }

  append(value: string): void {
    this.lines.push(value);
  }

  appendLine(line: string): void {
    this.lines.push(line);
  }

  replace(value: string): void {
    this.lines.push(value);
  }

  clear(): void {
    this.lines.length = 0;
  }

  show(): void {
    // no-op for headless evals
  }

  hide(): void {
    // no-op for headless evals
  }

  dispose(): void {
    this.lines.length = 0;
  }
}

function resolveNode(relativePath: string): WorkspaceNode | undefined {
  const cleanPath = relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const segments = cleanPath.length === 0 ? [] : cleanPath.split('/');
  let current: WorkspaceNode | undefined = workspaceTree;
  for (const segment of segments) {
    if (!current || current.type !== 'dir' || !current.children) {
      return undefined;
    }
    current = current.children[segment];
  }
  return current;
}

function listDirectory(relativePath: string): Array<[string, number]> {
  const node = resolveNode(relativePath);
  if (!node || node.type !== 'dir' || !node.children) {
    throw new Error(`Directory not found: ${relativePath}`);
  }
  return Object.entries(node.children).map(([name, child]) => [name, child.type === 'dir' ? FileType.Directory : FileType.File]);
}

function readFileContent(relativePath: string): string {
  const node = resolveNode(relativePath);
  if (!node || node.type !== 'file' || typeof node.content !== 'string') {
    throw new Error(`File not found: ${relativePath}`);
  }
  return node.content;
}

function collectFilePaths(prefix = '', node: WorkspaceNode = workspaceTree): string[] {
  if (node.type === 'file') {
    return [prefix];
  }
  if (!node.children) {
    return [];
  }
  const entries: string[] = [];
  for (const [name, child] of Object.entries(node.children)) {
    const childPath = prefix ? `${prefix}/${name}` : name;
    entries.push(...collectFilePaths(childPath, child));
  }
  return entries;
}

function toRelative(fsPath: string): string {
  const relative = path.relative(workspaceRoot, fsPath).replace(/\\/g, '/');
  return relative === '' ? '' : relative;
}

const mockVscode: any = {
  FileType,
  RelativePattern,
  Uri: {
    file: (fsPath: string) => createUri(fsPath),
    joinPath: (base: any, ...segments: string[]) => createUri(path.join(base.fsPath, ...segments)),
    parse: (value: string) => createUri(value)
  },
  workspace: {
    workspaceFolders: [{ uri: createUri(workspaceRoot) }],
    getConfiguration: () => ({ get: () => undefined }),
    fs: {
      readDirectory: async (uri: any) => {
        return listDirectory(toRelative(uri.fsPath));
      },
      readFile: async (uri: any) => {
        return Buffer.from(readFileContent(toRelative(uri.fsPath)), 'utf8');
      },
      stat: async (uri: any) => {
        const node = resolveNode(toRelative(uri.fsPath));
        if (!node) {
          throw new Error(`No such file: ${uri.fsPath}`);
        }
        return {
          type: node.type === 'dir' ? FileType.Directory : FileType.File,
          ctime: Date.now(),
          mtime: Date.now(),
          size: node.type === 'file' ? readFileContent(toRelative(uri.fsPath)).length : 0
        };
      }
    },
    findFiles: async (include?: string | typeof RelativePattern, _exclude?: string, maxResults?: number) => {
      let files = collectFilePaths();
      if (include instanceof RelativePattern) {
        const basePath = toRelative(include.base.uri?.fsPath ?? workspaceRoot);
        const pattern = include.pattern.replace(/\*\*\/\*/g, '').replace(/\*\*/g, '');
        const prefix = path.posix.join(basePath, pattern).replace(/\\/g, '/').replace(/\*.*$/, '');
        files = files.filter((file) => file.startsWith(prefix));
      }
      if (typeof include === 'string' && include !== '**/*') {
        const normalized = include.replace(/\*\*\/\*/g, '').replace(/\*\*/g, '').replace(/\*.*$/, '');
        files = files.filter((file) => file.startsWith(normalized));
      }
      const uris = files.map((relative) => createUri(path.join(workspaceRoot, relative)));
      return typeof maxResults === 'number' ? uris.slice(0, maxResults) : uris;
    },
    openTextDocument: async (uri: any) => {
      return new MockTextDocument(readFileContent(toRelative(uri.fsPath)), uri);
    }
  },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: (name: string) => new MockOutputChannel(name),
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showTextDocument: async () => undefined
  },
  CancellationTokenSource: class {
    token = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined })
    };
    cancel(): void {
      this.token.isCancellationRequested = true;
    }
    dispose(): void {
      this.token.isCancellationRequested = true;
    }
  }
};

if (!Module._titanPatched) {
  Module._titanPatched = true;
  Module._load = function patchedLoad(this: unknown, request: string, parent: NodeModule, isMain: boolean): unknown {
    if (request === 'vscode') {
      return mockVscode;
    }
    if (!originalLoad) {
      throw new Error('Original module loader unavailable.');
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}

const { ChatProvider } = require('./chatProvider') as typeof import('./chatProvider');

const mockContext: any = {
  extensionUri: mockVscode.Uri.file(workspaceRoot),
  workspaceState: new Memento(),
  globalState: new Memento(),
  extensionPath: workspaceRoot
};

// Mock LiveWorkspace for headless evals
class MockLiveWorkspace {
  getDocument(_fsPath: string): undefined {
    return undefined;
  }
  getAllDocuments(): never[] {
    return [];
  }
  dispose(): void {
    // no-op
  }
}

const mockLiveWorkspace = new MockLiveWorkspace();

const dummyOllama = {
  streamCompletion: async () => {
    throw new Error('streamCompletion should not be called in headless evals');
  }
};

function createHeadlessProvider(scriptQueue: ScriptedStream[]) {
  const provider = new ChatProvider(mockContext, mockLiveWorkspace as any, dummyOllama as any, new MockOutputChannel('Titan Eval Harness'), 'test-eval');
  const sessionId = (provider as any).activeSessionId as string;
  const queue = [...scriptQueue];

  (provider as any).startStream = async () => {
    const next = queue.shift();
    if (!next) {
      throw new Error('Script queue exhausted unexpectedly.');
    }
    return {
      raw: next.raw,
      sanitized: next.sanitized ?? next.raw
    };
  };

  return { provider, sessionId };
}

function assertNoRefusal(caseName: string, message: string): void {
  const normalized = message.toLowerCase();
  const refusalTokens = ['i cannot', "i can't", 'unable to comply', 'refuse'];
  for (const token of refusalTokens) {
    assert(!normalized.includes(token), `${caseName}: final message indicates refusal`);
  }
}

async function runEvalCase(definition: EvalCase): Promise<void> {
  const { provider, sessionId } = createHeadlessProvider(definition.script);
  await (provider as any).handleSendMessage(sessionId, definition.prompt);

  const metadata = provider.getLastTurnMetadata(sessionId);
  assert(metadata, `${definition.name}: missing last-turn metadata`);

  for (const tool of definition.requiredTools) {
    assert(
      metadata!.toolCalls.includes(tool),
      `${definition.name}: expected tool "${tool}" to be used (tools: ${metadata!.toolCalls.join(', ') || '<none>'})`
    );
  }

  assert(metadata!.finalMessage.trim().length > 0, `${definition.name}: final message is empty`);
  assertNoRefusal(definition.name, metadata!.finalMessage);

  if (definition.expectIncludes) {
    for (const fragment of definition.expectIncludes) {
      assert(metadata!.finalMessage.includes(fragment), `${definition.name}: final message missing "${fragment}"`);
    }
  }
}

const EVAL_CASES: EvalCase[] = [
  {
    name: 'polyadd-file-check',
    prompt: 'Is there a file named polyadd?',
    requiredTools: ['list_files'],
    expectIncludes: ['polyadd'],
    script: [
      { raw: '{"tool":"list_files","arguments":{}}' },
      { raw: 'Yes, there is a file named polyadd in the workspace listing.', sanitized: 'Yes, there is a file named polyadd in the workspace listing.' }
    ]
  },
  {
    name: 'entry-point-detection',
    prompt: 'Find the entry point for this project.',
    requiredTools: ['list_files', 'read_file'],
    expectIncludes: ['src/index.ts'],
    script: [
      { raw: '{"tool":"list_files","arguments":{"path":"src"}}' },
      { raw: '{"tool":"read_file","arguments":{"path":"src/index.ts","startLine":1,"endLine":40}}' },
      {
        raw: 'The entry point is src/index.ts; the start() function initializes the project.',
        sanitized: 'The entry point is src/index.ts; the start() function initializes the project.'
      }
    ]
  },
  {
    name: 'readme-inspection',
    prompt: 'Show me the contents of the README.',
    requiredTools: ['read_file'],
    expectIncludes: ['README'],
    script: [
      { raw: '{"tool":"read_file","arguments":{"path":"README.md","startLine":1,"endLine":40}}' },
      {
        raw: 'README excerpt:\n# Titan Forge Mock Workspace\nThis mock project is used for automated agent evaluation.',
        sanitized: 'README excerpt:\n# Titan Forge Mock Workspace\nThis mock project is used for automated agent evaluation.'
      }
    ]
  },
  {
    name: 'loginbutton-search',
    prompt: 'Search the project for "LoginButton".',
    requiredTools: ['grep', 'read_file'],
    expectIncludes: ['LoginButton'],
    script: [
      { raw: '{"tool":"grep","arguments":{"pattern":"LoginButton","path":"src"}}' },
      { raw: '{"tool":"read_file","arguments":{"path":"src/components/LoginButton.tsx","startLine":1,"endLine":120}}' },
      {
        raw: 'Found LoginButton in src/components/LoginButton.tsx; the component renders a simple login button.',
        sanitized: 'Found LoginButton in src/components/LoginButton.tsx; the component renders a simple login button.'
      }
    ]
  },
  {
    name: 'structure-summary',
    prompt: 'Describe the project structure quickly.',
    requiredTools: ['list_files'],
    expectIncludes: ['src', 'components'],
    script: [
      { raw: '{"tool":"list_files","arguments":{}}' },
      {
        raw: 'Workspace summary: top-level files include README.md, package.json, and polyadd.ts with source code under src/.',
        sanitized: 'Workspace summary: top-level files include README.md, package.json, and polyadd.ts with source code under src/.'
      }
    ]
  }
];

export async function runTitanEvals(): Promise<void> {
  for (const testCase of EVAL_CASES) {
    await runEvalCase(testCase);
  }
}

if (require.main === module) {
  runTitanEvals()
    .then(() => {
      console.log('All TITAN evals passed.');
    })
    .catch((error) => {
      console.error('TITAN evals failed:', error instanceof Error ? error.stack ?? error.message : error);
      process.exit(1);
    });
}
