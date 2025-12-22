import * as vscode from 'vscode';
import { SidebarViewProvider } from './sidebarViewProvider';
import { ChatProvider } from './chatProvider';
import { OllamaClient } from './ollamaClient';
import { VsCodeOllamaConfigurationProvider, VsCodeOutput } from './vscodeAdapters';

let chatProvider: ChatProvider | undefined;
let processHooksRegistered = false;
let rejectionHandler: ((reason: unknown) => void) | undefined;
let exceptionHandler: ((error: Error) => void) | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Titan Forge AI');
  const version = typeof context.extension.packageJSON?.version === 'string'
    ? context.extension.packageJSON.version
    : '0.0.0';

  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    outputChannel.appendLine(`Workspace folder detected: ${folders[0].uri.fsPath}`);
  } else {
    outputChannel.appendLine('No workspace folder detected at activation.');
  }

  const ollamaClient = new OllamaClient(
    new VsCodeOutput(outputChannel),
    new VsCodeOllamaConfigurationProvider()
  );
  chatProvider = new ChatProvider(context, ollamaClient, outputChannel, version);
  const sidebarProvider = new SidebarViewProvider(context.extensionUri, chatProvider, version);

  context.subscriptions.push(
    outputChannel,
    chatProvider,
    vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewType, sidebarProvider),
    vscode.commands.registerCommand('titanForgeAI.readFile', async () => chatProvider?.handleReadFileCommand()),
    vscode.commands.registerCommand('titanForgeAI.editFile', async () => chatProvider?.handleEditFileCommand()),
    vscode.commands.registerCommand('titanForgeAI.saveFile', async () => chatProvider?.handleSaveActiveEditor())
  );

  installProcessGuards(outputChannel);

  console.log('🔥 Titan Forge AI activated');
  chatProvider.log('Titan Forge AI ready.', 'info');
}

export function deactivate(): void {
  chatProvider?.dispose();
  chatProvider = undefined;

  if (processHooksRegistered) {
    if (rejectionHandler) {
      process.off('unhandledRejection', rejectionHandler);
    }
    if (exceptionHandler) {
      process.off('uncaughtException', exceptionHandler);
    }
    processHooksRegistered = false;
    rejectionHandler = undefined;
    exceptionHandler = undefined;
  }
}

function installProcessGuards(outputChannel: vscode.OutputChannel): void {
  if (processHooksRegistered) {
    return;
  }

  rejectionHandler = (reason: unknown): void => {
    const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    outputChannel.appendLine(`[UnhandledRejection] ${message}`);
    chatProvider?.log(`Unhandled promise rejection: ${message}`, 'warn');
  };

  exceptionHandler = (error: Error): void => {
    const message = `${error.name}: ${error.message}`;
    outputChannel.appendLine(`[UncaughtException] ${message}`);
    chatProvider?.log(`Uncaught exception: ${message}`, 'error');
  };

  process.on('unhandledRejection', rejectionHandler);
  process.on('uncaughtException', exceptionHandler);

  processHooksRegistered = true;
}
