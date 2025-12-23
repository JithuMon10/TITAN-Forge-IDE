import * as vscode from "vscode";

export interface EditorDocument {
  path: string;
  text: string;
  isDirty: boolean;
}

export function getActiveDocument(): EditorDocument | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;

  const doc = editor.document;

  return {
    path: doc.uri.fsPath,
    text: doc.getText(),
    isDirty: doc.isDirty
  };
}

export function getOpenDocuments(): EditorDocument[] {
  const docs: EditorDocument[] = [];

  for (const editor of vscode.window.visibleTextEditors) {
    const doc = editor.document;

    docs.push({
      path: doc.uri.fsPath,
      text: doc.getText(),
      isDirty: doc.isDirty
    });
  }

  return docs;
}
