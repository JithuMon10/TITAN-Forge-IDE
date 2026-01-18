import * as vscode from 'vscode';

export interface LiveDocumentEntry {
  readonly path: string;
  readonly uri: vscode.Uri;
  readonly languageId: string;
  readonly content: string;
  readonly version: number;
  readonly isDirty: boolean;
}

export class LiveWorkspace implements vscode.Disposable {
  private readonly documents = new Map<string, LiveDocumentEntry>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.initialize();
    this.registerListeners();
  }

  public getDocument(fsPath: string): LiveDocumentEntry | undefined {
    return this.documents.get(fsPath);
  }

  public getAllDocuments(): LiveDocumentEntry[] {
    return Array.from(this.documents.values());
  }

  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.documents.clear();
  }

  private initialize(): void {
    vscode.workspace.textDocuments.forEach((doc) => this.captureDocument(doc));
  }

  private registerListeners(): void {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.captureDocument(doc)),
      vscode.workspace.onDidChangeTextDocument((event) => this.captureDocument(event.document)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.captureDocument(doc)),
      vscode.workspace.onDidDeleteFiles((event) => {
        event.files.forEach((uri) => {
          this.documents.delete(uri.fsPath);
        });
      }),
      vscode.workspace.onDidCreateFiles(async (event) => {
        for (const uri of event.files) {
          try {
            const document = await vscode.workspace.openTextDocument(uri);
            this.captureDocument(document);
          } catch {
            // ignore
          }
        }
      })
    );
  }

  private captureDocument(document: vscode.TextDocument): void {
    if (!this.isSupported(document)) {
      return;
    }

    this.documents.set(document.uri.fsPath, {
      path: document.uri.fsPath,
      uri: document.uri,
      languageId: document.languageId,
      content: document.getText(),
      version: document.version,
      isDirty: document.isDirty
    });
  }

  private isSupported(document: vscode.TextDocument): boolean {
    return document.uri.scheme === 'file';
  }
}

