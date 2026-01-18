import * as vscode from 'vscode';

export function applyWorkspaceEdit(edit: vscode.WorkspaceEdit): Promise<boolean> {
  return Promise.resolve(vscode.workspace.applyEdit(edit));
}

export function createReplaceEdit(
  uri: vscode.Uri,
  originalContent: string,
  modifiedContent: string
): vscode.WorkspaceEdit {
  const edit = new vscode.WorkspaceEdit();
  const lines = originalContent.split(/\r?\n/);
  const lastLine = lines.length > 0 ? lines.length - 1 : 0;
  const lastChar = lines.length > 0 ? lines[lastLine].length : 0;
  const fullRange = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine, lastChar));

  edit.replace(uri, fullRange, modifiedContent);
  return edit;
}
