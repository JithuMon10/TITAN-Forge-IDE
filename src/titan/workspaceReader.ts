import * as vscode from 'vscode';

const MAX_EDITOR_CONTENT = 8000;

export interface ActiveFileContext {
  path: string;
  languageId: string;
  content: string;
  truncated: boolean;
}

export async function getActiveFileContext(): Promise<ActiveFileContext | null> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return null;
  }

  const content = editor.document.getText();
  const truncated = content.length > MAX_EDITOR_CONTENT;

  return {
    path: getDisplayPath(editor.document.uri),
    languageId: editor.document.languageId,
    content: truncated ? content.slice(0, MAX_EDITOR_CONTENT) : content,
    truncated
  };
}

export async function listWorkspaceFiles(): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return [];
  }

  const uris = await vscode.workspace.findFiles('**/*');
  const unique = new Set<string>();
  for (const uri of uris) {
    unique.add(getDisplayPath(uri));
  }
  return Array.from(unique.values()).sort();
}

export async function readWorkspaceFile(targetPath: string): Promise<string | null> {
  const uri = resolveWorkspacePath(targetPath);
  if (!uri) {
    return null;
  }

  try {
    const content = await vscode.workspace.fs.readFile(uri);
    return content.toString();
  } catch (_error) {
    return null;
  }
}

function getDisplayPath(uri: vscode.Uri): string {
  const relative = vscode.workspace.asRelativePath(uri, false);
  return relative && relative !== uri.fsPath ? relative : uri.fsPath;
}

function resolveWorkspacePath(target: string): vscode.Uri | undefined {
  if (pathIsAbsolute(target)) {
    return vscode.Uri.file(target);
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }

  const sanitized = target.replace(/^\.?[\\/]+/, '');
  return vscode.Uri.joinPath(folders[0].uri, sanitized);
}

function pathIsAbsolute(value: string): boolean {
  return /^(?:[a-zA-Z]:\\|\\\\|\/)/.test(value);
}
