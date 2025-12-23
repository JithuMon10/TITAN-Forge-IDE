import * as vscode from 'vscode';
import { DocumentOverride, DocumentType } from '../../titan-core/types';

export interface EditorContextSnapshot {
  path: string;
  languageId: string;
  content: string;
  truncated: boolean;
  version: number;
  capturedAt: number;
  source: 'editor';
}

export interface DiagnosticEntry {
  path: string;
  message: string;
  severity: 'error' | 'warning' | 'information' | 'hint';
  code?: string | number;
  range: {
    startLine: number;
    startCharacter: number;
    endLine: number;
    endCharacter: number;
  };
}

export type WorkspaceChangeEvent = {
  type: 'documents' | 'diagnostics' | 'workspaceFiles' | 'activeEditor';
  path?: string;
  languageId?: string;
  revision: number;
};

export class LiveWorkspaceState {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDidChangeEmitter = new vscode.EventEmitter<WorkspaceChangeEvent>();
  private revision = 0;

  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly maxContent: number) {
    this.disposables.push(this.onDidChangeEmitter);
    this.registerListeners();
  }

  dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
    this.disposables.length = 0;
  }

  getRevision(): number {
    return this.revision;
  }

  getActiveEditorContext(): EditorContextSnapshot | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return null;
    }
    const override = this.createOverrideFromDocument(editor.document);
    return {
      path: override.path,
      languageId: editor.document.languageId,
      content: override.content,
      truncated: Boolean(override.truncated),
      version: editor.document.version,
      capturedAt: override.capturedAt ?? Date.now(),
      source: 'editor'
    };
  }

  async getWorkspaceFiles(): Promise<string[]> {
    const uris = await vscode.workspace.findFiles('**/*');
    const aggregate = new Set<string>();
    for (const uri of uris) {
      aggregate.add(getDisplayPath(uri));
    }
    for (const document of vscode.workspace.textDocuments) {
      aggregate.add(getDisplayPath(document.uri));
    }
    return Array.from(aggregate.values()).sort();
  }

  getDiagnostics(): DiagnosticEntry[] {
    const entries: DiagnosticEntry[] = [];
    const diagnostics = vscode.languages.getDiagnostics();
    for (const [uri, list] of diagnostics) {
      if (!list || list.length === 0) {
        continue;
      }
      const displayPath = getDisplayPath(uri);
      entries.push(
        ...list.map<DiagnosticEntry>((diag) => ({
          path: displayPath,
          message: diag.message,
          severity: mapSeverity(diag.severity),
          code: extractDiagnosticCode(diag.code),
          range: {
            startLine: diag.range.start.line,
            startCharacter: diag.range.start.character,
            endLine: diag.range.end.line,
            endCharacter: diag.range.end.character
          }
        }))
      );
    }
    return entries;
  }

  getOverridesForPaths(requestedPaths: string[], activePath?: string): DocumentOverride[] {
    const needed = new Set<string>();
    for (const entry of requestedPaths) {
      const normalized = normalizePath(entry);
      if (normalized) {
        needed.add(normalized);
      }
    }
    if (activePath) {
      const normalized = normalizePath(activePath);
      if (normalized) {
        needed.add(normalized);
      }
    }

    if (needed.size === 0) {
      return [];
    }

    const overrides: DocumentOverride[] = [];
    for (const document of vscode.workspace.textDocuments) {
      const displayPath = getDisplayPath(document.uri);
      const normalized = normalizePath(displayPath);
      if (normalized && needed.has(normalized)) {
        overrides.push(this.createOverrideFromDocument(document, displayPath));
      }
    }
    return overrides;
  }

  getOpenDocumentPaths(): string[] {
    const paths = new Set<string>();
    for (const document of vscode.workspace.textDocuments) {
      paths.add(getDisplayPath(document.uri));
    }
    return Array.from(paths.values());
  }

  private registerListeners(): void {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((document) => {
        this.emitChange({
          type: 'documents',
          path: getDisplayPath(document.uri),
          languageId: document.languageId
        });
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.emitChange({
          type: 'documents',
          path: getDisplayPath(event.document.uri),
          languageId: event.document.languageId
        });
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.emitChange({
          type: 'documents',
          path: getDisplayPath(document.uri),
          languageId: document.languageId
        });
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.emitChange({
          type: 'documents',
          path: getDisplayPath(document.uri),
          languageId: document.languageId
        });
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.emitChange({
            type: 'activeEditor',
            path: getDisplayPath(editor.document.uri),
            languageId: editor.document.languageId
          });
        } else {
          this.emitChange({ type: 'activeEditor' });
        }
      }),
      vscode.workspace.onDidCreateFiles(() => this.emitChange({ type: 'workspaceFiles' })),
      vscode.workspace.onDidDeleteFiles(() => this.emitChange({ type: 'workspaceFiles' })),
      vscode.workspace.onDidRenameFiles(() => this.emitChange({ type: 'workspaceFiles' })),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.emitChange({ type: 'workspaceFiles' })),
      vscode.languages.onDidChangeDiagnostics(() => this.emitChange({ type: 'diagnostics' }))
    );
  }
  private createOverrideFromDocument(document: vscode.TextDocument, displayPath?: string): DocumentOverride {
    const pathValue = displayPath ?? getDisplayPath(document.uri);
    const { content, truncated } = limitContent(document.getText(), this.maxContent);
    const capturedAt = Date.now();
    return {
      path: pathValue,
      content,
      type: inferDocumentType(document.languageId),
      truncated,
      version: document.version,
      capturedAt
    };
  }

  private emitChange(change: Omit<WorkspaceChangeEvent, 'revision'>): void {
    const revision = this.bumpRevision();
    this.onDidChangeEmitter.fire({ ...change, revision });
  }

  private bumpRevision(): number {
    this.revision += 1;
    return this.revision;
  }
}

function normalizePath(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\\/g, '/').replace(/^\.?\//, '').trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function getDisplayPath(uri: vscode.Uri): string {
  const relative = vscode.workspace.asRelativePath(uri, false);
  if (relative && relative !== uri.fsPath) {
    return relative;
  }
  if (uri.scheme === 'untitled') {
    return uri.path ? uri.path.replace(/^\/?/, '') || 'untitled' : 'untitled';
  }
  return uri.fsPath;
}

function inferDocumentType(languageId: string): DocumentType {
  switch (languageId) {
    case 'json':
    case 'jsonc':
      return 'json';
    case 'markdown':
    case 'plaintext':
    case 'yaml':
    case 'yml':
      return 'text';
    case 'pdf':
      return 'pdf';
    case 'docx':
      return 'docx';
    default:
      return 'code';
  }
}

function mapSeverity(severity: vscode.DiagnosticSeverity): 'error' | 'warning' | 'information' | 'hint' {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'information';
    case vscode.DiagnosticSeverity.Hint:
    default:
      return 'hint';
  }
}

function extractDiagnosticCode(code: string | number | { value: string | number } | undefined): string | number | undefined {
  if (code === undefined) {
    return undefined;
  }
  if (typeof code === 'string' || typeof code === 'number') {
    return code;
  }
  return code.value;
}

function limitContent(value: string, maxContent: number): { content: string; truncated: boolean } {
  if (value.length <= maxContent) {
    return { content: value, truncated: false };
  }
  return { content: value.slice(0, maxContent), truncated: true };
}
