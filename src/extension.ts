import * as vscode from 'vscode';
import { SidebarViewProvider } from './sidebarViewProvider';
import { ChatProvider } from './chatProvider';
import { LiveWorkspace } from './state/liveWorkspace';
import { OllamaClient } from './ollamaClient';
import { VsCodeOllamaConfigurationProvider, VsCodeOutput } from './vscodeAdapters';

let chatProvider: ChatProvider | undefined;
let liveWorkspace: LiveWorkspace | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Titan Forge AI');
  const version = typeof context.extension.packageJSON?.version === 'string'
    ? context.extension.packageJSON.version
    : '0.0.0';

  const configuration = new VsCodeOllamaConfigurationProvider();
  const ollamaOutput = new VsCodeOutput(outputChannel);
  const ollamaClient = new OllamaClient(ollamaOutput, configuration);

  liveWorkspace = new LiveWorkspace();
  chatProvider = new ChatProvider(context, liveWorkspace, ollamaClient, outputChannel, version);
  const sidebarProvider = new SidebarViewProvider(context.extensionUri, chatProvider, version);

  context.subscriptions.push(
    outputChannel,
    liveWorkspace,
    chatProvider,
    vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewType, sidebarProvider),
    vscode.commands.registerCommand('titanForgeAI.readFile', async () => chatProvider?.handleReadFileCommand()),
    vscode.commands.registerCommand('titanForgeAI.editFile', async () => chatProvider?.handleEditFileCommand()),
    vscode.commands.registerCommand('titanForgeAI.saveFile', async () => chatProvider?.handleSaveActiveEditor()),
    vscode.commands.registerCommand('titanForgeAI.createFile', async () => chatProvider?.handleCreateFileCommand()),
    vscode.commands.registerCommand('titanForgeAI.generateScript', async () => chatProvider?.handleGenerateScriptCommand())
  );

  outputChannel.appendLine('Titan Forge AI activated.');
}

export async function deactivate(): Promise<void> {
  await chatProvider?.handleSaveActiveEditor().catch(() => undefined);
  chatProvider?.dispose();
  chatProvider = undefined;

  liveWorkspace?.dispose();
  liveWorkspace = undefined;
}