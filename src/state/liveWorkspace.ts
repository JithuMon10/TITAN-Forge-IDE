import * as vscode from 'vscode';
import * as path from 'path';

export interface LiveDocumentEntry {
  readonly path: string;
  readonly relativePath: string;
  readonly uri: vscode.Uri;
  readonly languageId: string;
  readonly content: string;
  readonly version: number;
  readonly isDirty: boolean;
  readonly lastModified: number;
}

export interface WorkspaceFileInfo {
  relativePath: string;
  languageId: string;
  size: number;
}

// File extensions to include in workspace scan
const SUPPORTED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.rb', '.java', '.kt', '.swift',
  '.c', '.cpp', '.h', '.hpp', '.cs',
  '.sh', '.bash', '.ps1', '.bat',
  '.json', '.yaml', '.yml', '.toml', '.xml',
  '.md', '.txt', '.sql', '.html', '.css', '.scss'
]);

// Folders to ignore
const IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.git/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/target/**'
];

export class LiveWorkspace implements vscode.Disposable {
  private readonly documents = new Map<string, LiveDocumentEntry>();
  private readonly workspaceFiles = new Map<string, WorkspaceFileInfo>();
  private readonly disposables: vscode.Disposable[] = [];
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private onChangeCallbacks: Array<() => void> = [];

  constructor() {
    this.initialize();
    this.registerListeners();
    this.setupFileWatcher();
    this.scanWorkspace();
  }

  public getDocument(fsPath: string): LiveDocumentEntry | undefined {
    return this.documents.get(fsPath);
  }

  public getAllDocuments(): LiveDocumentEntry[] {
    return Array.from(this.documents.values());
  }

  public getWorkspaceFiles(): WorkspaceFileInfo[] {
    return Array.from(this.workspaceFiles.values());
  }

  public async getFileContent(relativePath: string): Promise<string | null> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return null;

    const absolutePath = path.join(folders[0].uri.fsPath, relativePath);

    // Check if we have a live version (open in editor)
    const liveDoc = this.documents.get(absolutePath);
    if (liveDoc) {
      return liveDoc.content;
    }

    // Read from disk
    try {
      const uri = vscode.Uri.file(absolutePath);
      const content = await vscode.workspace.fs.readFile(uri);
      return content.toString();
    } catch {
      return null;
    }
  }

  public onDidChange(callback: () => void): void {
    this.onChangeCallbacks.push(callback);
  }

  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.fileWatcher?.dispose();
    this.documents.clear();
    this.workspaceFiles.clear();
  }

  private initialize(): void {
    vscode.workspace.textDocuments.forEach((doc) => this.captureDocument(doc));
  }

  private registerListeners(): void {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => {
        this.captureDocument(doc);
        this.notifyChange();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.captureDocument(event.document);
        this.notifyChange();
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        this.captureDocument(doc);
        this.notifyChange();
      }),
      vscode.workspace.onDidDeleteFiles((event) => {
        event.files.forEach((uri) => {
          this.documents.delete(uri.fsPath);
          this.removeWorkspaceFile(uri.fsPath);
        });
        this.notifyChange();
      }),
      vscode.workspace.onDidCreateFiles(async (event) => {
        for (const uri of event.files) {
          try {
            this.addWorkspaceFile(uri);
            const document = await vscode.workspace.openTextDocument(uri);
            this.captureDocument(document);
          } catch {
            // ignore
          }
        }
        this.notifyChange();
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        event.files.forEach((file) => {
          this.documents.delete(file.oldUri.fsPath);
          this.removeWorkspaceFile(file.oldUri.fsPath);
          this.addWorkspaceFile(file.newUri);
        });
        this.notifyChange();
      })
    );
  }

  private setupFileWatcher(): void {
    this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');

    this.disposables.push(
      this.fileWatcher.onDidChange(async (uri) => {
        // If file is open, it's handled by document listeners
        if (!this.documents.has(uri.fsPath)) {
          // Update workspace file info
          this.addWorkspaceFile(uri);
          this.notifyChange();
        }
      }),
      this.fileWatcher.onDidCreate((uri) => {
        this.addWorkspaceFile(uri);
        this.notifyChange();
      }),
      this.fileWatcher.onDidDelete((uri) => {
        this.documents.delete(uri.fsPath);
        this.removeWorkspaceFile(uri.fsPath);
        this.notifyChange();
      })
    );
  }

  private async scanWorkspace(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;

    try {
      const excludePattern = `{${IGNORE_PATTERNS.join(',')}}`;
      const files = await vscode.workspace.findFiles('**/*', excludePattern, 500);

      for (const uri of files) {
        this.addWorkspaceFile(uri);
      }
    } catch (error) {
      console.error('Failed to scan workspace:', error);
    }
  }

  private addWorkspaceFile(uri: vscode.Uri): void {
    const ext = path.extname(uri.fsPath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) return;

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;

    const relativePath = path.relative(folders[0].uri.fsPath, uri.fsPath).replace(/\\/g, '/');

    // Skip files in ignored folders
    if (IGNORE_PATTERNS.some(pattern => {
      const simplePattern = pattern.replace(/\*\*/g, '').replace(/\*/g, '');
      return relativePath.includes(simplePattern.replace(/\//g, ''));
    })) return;

    this.workspaceFiles.set(uri.fsPath, {
      relativePath,
      languageId: this.getLanguageId(ext),
      size: 0 // Will be updated when read
    });
  }

  private removeWorkspaceFile(fsPath: string): void {
    this.workspaceFiles.delete(fsPath);
  }

  private getLanguageId(ext: string): string {
    const map: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescriptreact',
      '.js': 'javascript', '.jsx': 'javascriptreact',
      '.py': 'python', '.go': 'go', '.rs': 'rust',
      '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
      '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
      '.sh': 'shellscript', '.bash': 'shellscript', '.ps1': 'powershell',
      '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
      '.md': 'markdown', '.html': 'html', '.css': 'css'
    };
    return map[ext] || 'plaintext';
  }

  private captureDocument(document: vscode.TextDocument): void {
    if (!this.isSupported(document)) return;

    const folders = vscode.workspace.workspaceFolders;
    const relativePath = folders && folders.length > 0
      ? path.relative(folders[0].uri.fsPath, document.uri.fsPath).replace(/\\/g, '/')
      : document.uri.fsPath;

    this.documents.set(document.uri.fsPath, {
      path: document.uri.fsPath,
      relativePath,
      uri: document.uri,
      languageId: document.languageId,
      content: document.getText(),
      version: document.version,
      isDirty: document.isDirty,
      lastModified: Date.now()
    });
  }

  private isSupported(document: vscode.TextDocument): boolean {
    return document.uri.scheme === 'file';
  }

  private notifyChange(): void {
    this.onChangeCallbacks.forEach(cb => cb());
  }
}
