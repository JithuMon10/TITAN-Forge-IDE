import * as vscode from 'vscode';
import * as path from 'path';
import { buildContext } from '../titan-core/contextBuilder';
import { DocumentOverride } from '../titan-core/types';
import { OllamaClient } from './ollamaClient';
import {
  LiveWorkspaceState,
  DiagnosticEntry as LiveDiagnosticEntry,
  WorkspaceChangeEvent
} from './state/liveWorkspace';

type LogLevel = 'info' | 'warn' | 'error';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

function mapDiagnosticEntry(entry: LiveDiagnosticEntry): DiagnosticEntry {
  return {
    path: entry.path,
    message: entry.message,
    severity: entry.severity,
    code: entry.code,
    range: {
      startLine: entry.range.startLine,
      startCharacter: entry.range.startCharacter,
      endLine: entry.range.endLine,
      endCharacter: entry.range.endCharacter
    }
  };
}

interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  workspaceContext: string[];
}

interface ActiveEditorContext {
  path: string;
  languageId: string;
  content: string;
  truncated: boolean;
  version: number;
  capturedAt: number;
  source: 'editor';
}

interface RequestedFileContext {
  path: string;
  content: string;
  source: 'editor' | 'disk';
  version?: number;
  capturedAt?: number;
}

interface DiagnosticEntry {
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

interface ConversationContext {
  editor?: ActiveEditorContext;
  workspaceFiles: string[];
  requestedFiles: RequestedFileContext[];
  diagnostics: DiagnosticEntry[];
  revision: number;
  editorOverrides: number;
  diskFiles: number;
}

interface ConversationBuildResult {
  context: ConversationContext;
  requestedPaths: string[];
  missingPaths: string[];
}

interface ConversationSnapshot {
  revision: number;
  context: ConversationContext;
  requestedPaths: string[];
  capturedAt: number;
}

type LastContextInputs = {
  sessionId: string;
  userMessage: string;
  mentionedFiles: string[];
  docMentions: string[];
  historyForPrompt: ChatMessage[];
  requestedPaths: string[];
  revision: number;
};

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'send'; sessionId: string; content: string }
  | { type: 'cancel' }
  | { type: 'newSession'; title?: string }
  | { type: 'switchSession'; sessionId: string }
  | { type: 'clearSession' };

interface StatusMessage {
  type: 'status';
  status: 'idle' | 'thinking' | 'processing' | 'error';
  message?: string;
}

const DEFAULT_SESSION_TITLE = 'Chat';
const DEFAULT_SESSION_ID = 'session-0';
const MAX_EDITOR_CONTENT = 200000;
const MAX_PROMPT_PREVIEW = 2000;
const MAX_WORKSPACE_FILES = 200;
const MAX_HISTORY = 10;
const MAX_PERSISTED_WORKSPACE_CONTEXT = 5;
const MAX_CONTEXT_PREP_ATTEMPTS = 3;
const FILE_INTENT_KEYWORDS = [
  'read',
  'open',
  'summarize',
  'summarise',
  'explain',
  'describe',
  'what is in',
  'what\'s in',
  'what is inside',
  'analyze',
  'analyse',
  'answer questions from'
];
const DOC_LIKE_EXTENSIONS = ['.pdf', '.docx'];
const ACTIVE_EDITOR_ALIASES = [
  'current file',
  'this file',
  'active file',
  'open file',
  'open buffer',
  'current buffer',
  'the file above',
  'the code above',
  'the code here',
  'the code in editor',
  'here in the editor',
  'my editor',
  'what i am editing'
];
const IMPLICIT_CODE_INTENT = [
  'fix',
  'change',
  'update',
  'refactor',
  'bug',
  'error',
  'warn',
  'issue',
  'why does this',
  'what does this',
  'how does this',
  'can you explain this',
  'implement',
  'optimize',
  'improve'
];

export class ChatProvider {
  private readonly context?: vscode.ExtensionContext;
  private readonly ollama?: OllamaClient;
  private readonly outputChannel?: vscode.OutputChannel;
  private readonly version?: string;
  private webviewView?: vscode.WebviewView;
  private readonly sessions = new Map<string, ChatSession>();
  private activeSessionId: string = DEFAULT_SESSION_ID;
  private cancellationTokenSource: vscode.CancellationTokenSource | undefined;
  private readonly textDecoder = new TextDecoder();
  private readonly workspaceState: LiveWorkspaceState;
  private workspaceChangeRevision = 0;
  private workspaceDebounceTimer: NodeJS.Timeout | undefined;
  private contextPreviewTask: Promise<void> | null = null;
  private contextPreviewPending = false;
  private lastPreviewRevision = -1;
  private pendingPreviewRevision: number | null = null;
  private lastConversationSnapshot: ConversationSnapshot | null = null;
  private readonly workspaceChangeHandlers: (() => void)[] = [];
  private lastContextInputs: LastContextInputs | null = null;
  private contextRefreshPromise: Promise<void> | null = null;
  private pendingContextRefresh = false;

  constructor(
    _context?: vscode.ExtensionContext,
    _ollamaClient?: unknown,
    _outputChannel?: vscode.OutputChannel,
    _version?: string
  ) {
    this.context = _context;
    this.outputChannel = _outputChannel;
    this.version = _version;
    this.ollama = this.isOllamaClient(_ollamaClient) ? _ollamaClient : undefined;

    const session = this.createSession(DEFAULT_SESSION_ID, DEFAULT_SESSION_TITLE);
    this.sessions.set(session.id, session);
    this.activeSessionId = session.id;
    this.workspaceState = new LiveWorkspaceState(MAX_EDITOR_CONTENT);
    this.workspaceState.onDidChange((event) => this.handleWorkspaceChange(event));
    this.registerWorkspaceChangeHandler(() => this.triggerIncrementalContextRefresh());
  }

  private isDocLikePath(value: string): boolean {
    const lower = value.toLowerCase();
    return DOC_LIKE_EXTENSIONS.some((ext) => lower.endsWith(ext));
  }

  private normalizeDocName(value: string): string {
    return value.replace(/\\/g, '/').replace(/\s+/g, '').toLowerCase();
  }

  private getWorkspaceRoot(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return null;
    }
    return folders[0].uri.fsPath;
  }

  // -----------------------------
  // Core chat entry
  // -----------------------------
  async handleMessage(input: string): Promise<string> {
    try {
      if (this.isListFilesRequest(input)) {
        return await this.buildWorkspaceFileListMessage();
      }

      const stable = await this.collectStableConversationContext(input, [], [], {
        recomputeMentions: true
      });
      const { context } = stable.buildResult;
      if (!this.diagnosticsAllowResponse(context)) {
        return this.formatDiagnosticsRefusal(context);
      }

      // In handleMessage we don't have a session yet, so we'll just pass a dummy array or modify handleMessage to take a session
      // But handleMessage is the entry point from sidebar presumably?
      // Actually handleMessage is called by tests or external callers.
      // Let's just wrap the input in a ChatMessage for now to satisfy the type.
      const dummyHistory: ChatMessage[] = [{ role: 'user', content: input, timestamp: Date.now() }];
      const prompt = this.composePrompt(dummyHistory, context);
      const response = await this.invokeOllama(prompt);
      return response.trim();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.log(`handleMessage failed: ${err.message}`, 'error');
      return err.message || 'I ran into an error. Please check the Titan Forge AI output channel for details.';
    }
  }

  // -----------------------------
  // Required lifecycle / wiring
  // -----------------------------
  dispose(): void {
    this.cancellationTokenSource?.cancel();
    this.cancellationTokenSource?.dispose();
    this.cancellationTokenSource = undefined;
    this.webviewView = undefined;
    if (this.workspaceDebounceTimer) {
      clearTimeout(this.workspaceDebounceTimer);
      this.workspaceDebounceTimer = undefined;
    }
    this.lastContextInputs = null;
    this.workspaceState.dispose();
  }

  registerWorkspaceChangeHandler(handler: () => void): vscode.Disposable {
    this.workspaceChangeHandlers.push(handler);
    return new vscode.Disposable(() => {
      const index = this.workspaceChangeHandlers.indexOf(handler);
      if (index >= 0) {
        this.workspaceChangeHandlers.splice(index, 1);
      }
    });
  }

  attachWebview(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;

    webviewView.onDidDispose(() => {
      if (this.webviewView === webviewView) {
        this.webviewView = undefined;
      }
    });

    webviewView.webview.onDidReceiveMessage(async (message: IncomingMessage) => {
      try {
        switch (message.type) {
          case 'ready':
            this.postInitialState();
            break;
          case 'send':
            await this.handleSendMessage(message.sessionId, message.content);
            break;
          case 'cancel':
            this.handleCancel();
            break;
          case 'newSession':
            this.handleNewSession(message.title);
            break;
          case 'switchSession':
            this.handleSwitchSession(message.sessionId);
            break;
          case 'clearSession':
            this.handleClearSession();
            break;
          default:
            break;
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.log(`Failed to process webview message: ${err.message}`, 'error');
        this.postChatError('Something went wrong while handling that request.');
        this.postStatus('idle');
      }
    });

    this.postInitialState();
  }

  log(message: string, level: LogLevel = 'info'): void {
    const prefix = `[Titan Forge][${level.toUpperCase()}]`;
    this.outputChannel?.appendLine(`${prefix} ${message}`);
  }

  // -----------------------------
  // Command handlers (disabled)
  // -----------------------------
  async handleReadFileCommand(): Promise<void> {
    return;
  }

  async handleEditFileCommand(): Promise<void> {
    return;
  }

  async handleSaveActiveEditor(): Promise<void> {
    return;
  }

  // -----------------------------
  // Eval / testing hooks
  // -----------------------------
  getLastTurnMetadata(_sessionId: string): {
    toolCalls: string[];
    finalMessage: string;
  } {
    return {
      toolCalls: [],
      finalMessage: ''
    };
  }

  // -----------------------------
  // Internal helpers
  // -----------------------------
  private handleCancel(): void {
    if (this.cancellationTokenSource) {
      this.cancellationTokenSource.cancel();
      this.cancellationTokenSource.dispose();
      this.cancellationTokenSource = undefined;
    }
    this.postStatus('idle');
    this.log('Model request cancelled.', 'warn');
  }

  private handleNewSession(title?: string): void {
    const sessionId = `session-${Date.now()}`;
    const session = this.createSession(sessionId, title?.trim() || DEFAULT_SESSION_TITLE);
    this.sessions.set(session.id, session);
    this.activeSessionId = session.id;
    this.postSessions('sessions');
    this.lastContextInputs = null;
  }

  private handleSwitchSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      this.log(`Switch requested for unknown session ${sessionId}`, 'warn');
      return;
    }
    this.activeSessionId = sessionId;
    this.postSessions('sessions');
    const snapshot = this.lastContextInputs;
    if (!snapshot || snapshot.sessionId !== sessionId) {
      this.lastContextInputs = null;
    }
  }

  private handleClearSession(): void {
    const session = this.sessions.get(this.activeSessionId);
    if (!session) {
      return;
    }
    session.messages = [];
    this.postSessions('sessions');
    if (this.lastContextInputs?.sessionId === session.id) {
      this.lastContextInputs = null;
    }
  }

  private async handleSendMessage(sessionId: string, content: string): Promise<void> {
    const session = this.ensureSession(sessionId);

    let assistantCommitted = false;
    const commitAssistantMessage = (assistantContent: string): void => {
      if (assistantCommitted) {
        return;
      }
      assistantCommitted = true;
      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: assistantContent,
        timestamp: Date.now()
      };
      session.messages.push(assistantMessage);
      this.pruneContext(session);
      this.postSessions('sessions');
      this.postChatMessage('assistant', assistantContent);
    };

    // Detect output request intent
    const isOutputRequest = /example\s+output|sample\s+output|what.*output|show.*output|run.*code/i.test(content);
    let promptContent = content;
    if (isOutputRequest) {
      promptContent += "\n\n[CRITICAL: User wants the ACTUAL program output, not an explanation. Show ONLY what appears on screen when the program runs, formatted in a code block. Simulate the execution step-by-step in your mind, then output ONLY the final result.]";
    }

    const userMessage: ChatMessage = {
      role: 'user',
      content,
      timestamp: Date.now()
    };
    session.messages.push(userMessage);
    this.activeSessionId = session.id;
    this.pruneContext(session);
    this.postSessions('sessions');
    this.postStatus('thinking');

    if (this.isListFilesRequest(content)) {
      try {
        const listing = await this.buildWorkspaceFileListMessage();
        commitAssistantMessage(listing);
        this.postStatus('idle');
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.log(`Failed to list workspace files: ${err.message}`, 'error');
        this.postChatError(err.message);
        this.postStatus('idle');
      }
      return;
    }

    if (!this.ollama) {
      const message = 'Titan Forge AI is not connected to any model client.';
      this.log(message, 'error');
      this.postChatError(message);
      this.postStatus('error', message);
      return;
    }

    try {
      const healthy = await this.ollama.checkHealth();
      if (!healthy) {
        const message = 'Unable to reach Ollama. Make sure `ollama serve` is running.';
        this.postChatError(message);
        this.postStatus('error', message);
        return;
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const message = `Ollama health check failed: ${err.message}`;
      this.postChatError(message);
      this.postStatus('error', message);
      return;
    }

    let buildResult: ConversationBuildResult | null = null;
    let context: ConversationContext | null = null;
    let prompt: string | null = null;
    let mentionedFiles: string[] = [];
    let docMentions: string[] = [];
    let historyForPrompt: ChatMessage[] = [];

    try {
      let prepared = false;

      for (let attempt = 0; attempt < MAX_CONTEXT_PREP_ATTEMPTS && !prepared; attempt += 1) {
        const stable = await this.collectStableConversationContext(content, mentionedFiles, docMentions, {
          recomputeMentions: true
        });

        buildResult = stable.buildResult;
        context = buildResult.context;
        mentionedFiles = stable.mentionedFiles;
        docMentions = stable.docMentions;

        historyForPrompt = this.cloneMessagesForPrompt(
          session.messages,
          isOutputRequest ? promptContent : undefined
        );

        const candidatePrompt = this.composePrompt(historyForPrompt, context);
        const postComposeRevision = this.workspaceState.getRevision();

        if (postComposeRevision !== context.revision) {
          this.log(
            `Workspace changed during prompt composition (rev ${postComposeRevision} != ${context.revision}); retrying context capture...`,
            'info'
          );
          continue;
        }

        prompt = candidatePrompt;
        prepared = true;
      }

      if (!prepared || !buildResult || !context || !prompt) {
        throw new Error(
          'Workspace changed while preparing context. Please pause edits momentarily and resend your request.'
        );
      }

      this.setLastContextInputs({
        sessionId: session.id,
        userMessage: content,
        mentionedFiles,
        docMentions,
        historyForPrompt,
        requestedPaths: buildResult.requestedPaths,
        revision: context.revision
      });
      this.lastConversationSnapshot = {
        revision: context.revision,
        context,
        requestedPaths: [...buildResult.requestedPaths],
        capturedAt: Date.now()
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const message = err.message || 'Failed to prepare context.';
      this.log(`Context preparation failed: ${message}`, 'error');
      this.postChatError(message);
      this.postStatus('idle');
      return;
    }

    if (!context || !buildResult || !prompt) {
      const message = 'Failed to stabilise the workspace context. Please try again.';
      this.log(message, 'error');
      this.postChatError(message);
      this.postStatus('idle');
      return;
    }

    this.postContextPreview(context, prompt);
    this.postContextBadges(context);

    if (!this.diagnosticsAllowResponse(context)) {
      const refusal = this.formatDiagnosticsRefusal(context);
      commitAssistantMessage(refusal);
      this.postStatus('idle');
      return;
    }

    this.postStatus('processing');

    this.cancellationTokenSource?.cancel();
    this.cancellationTokenSource?.dispose();
    this.cancellationTokenSource = new vscode.CancellationTokenSource();

    let assistantReply = '';
    try {
      assistantReply = (await this.invokeOllama(prompt, this.cancellationTokenSource.token)).trim();

      // Post-processing: Retry if output was requested but explanation was given
      if (isOutputRequest && this.responseContainsExplanation(assistantReply)) {
        this.log('Response contained explanation instead of output. Retrying with strict prompt...', 'info');
        
        let fileContent = '';
        if (context.editor) {
          fileContent += `File: ${context.editor.path}\n${context.editor.content}\n\n`;
        }
        context.requestedFiles.forEach((f) => {
          fileContent += `File: ${f.path}\n${f.content}\n\n`;
        });

        const retryPrompt = `You just explained the code, but I need the ACTUAL OUTPUT.
   
Given this code:
${fileContent}

Show me EXACTLY what text appears on the terminal when I run it. Just the output, nothing else.

Example format:
\`\`\`
[actual program output here]
\`\`\`
`;
        assistantReply = (await this.invokeOllama(retryPrompt, this.cancellationTokenSource.token)).trim();
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.message.includes('cancelled by user')) {
        this.log('Ollama request cancelled by user.', 'warn');
        return;
      }
      this.log(`Ollama request failed: ${err.message}`, 'error');
      this.postChatError(err.message);
      return;
    } finally {
      this.cancellationTokenSource?.dispose();
      this.cancellationTokenSource = undefined;
      this.postStatus('idle');
    }

    const safeContext = context;
    if (!safeContext || !prompt) {
      this.postChatError('Failed to prepare response context. Please try again.');
      return;
    }

    const revisionBeforeCommit = this.workspaceState.getRevision();
    if (revisionBeforeCommit !== safeContext.revision) {
      const message = 'Workspace changed while generating the response. Please resend your request to use the latest code.';
      this.log(message, 'warn');
      this.postChatError(message);
      return;
    }

    if (!assistantReply) {
      assistantReply = 'I did not receive a response from the model.';
    }

    commitAssistantMessage(assistantReply);
  }

  private createSession(id: string, title: string): ChatSession {
    return {
      id,
      title,
      messages: [],
      workspaceContext: []
    };
  }

  private pruneContext(session: ChatSession): void {
    // Limit messages to last 6 entries (3 turns)
    if (session.messages.length > MAX_HISTORY) {
      session.messages = session.messages.slice(-MAX_HISTORY);
    }
    
    // Limit workspace context to last 5 blocks
    if (session.workspaceContext.length > MAX_PERSISTED_WORKSPACE_CONTEXT) {
      session.workspaceContext = session.workspaceContext.slice(-MAX_PERSISTED_WORKSPACE_CONTEXT);
    }
  }

  private ensureSession(sessionId: string): ChatSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = this.createSession(sessionId, DEFAULT_SESSION_TITLE);
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private postInitialState(): void {
    this.postSessions('init');
    this.postStatus('idle');
  }

  private postSessions(kind: 'init' | 'sessions'): void {
    const payload = {
      sessions: Array.from(this.sessions.values()).map((session) => ({
        id: session.id,
        title: session.title,
        messages: session.messages.map((message) => ({
          role: message.role,
          content: message.content,
          timestamp: message.timestamp
        }))
      })),
      activeSessionId: this.activeSessionId,
      version: this.version ?? '0.0.0'
    };

    const messageType = kind === 'init' ? 'init' : 'sessions';
    this.postToWebview(messageType, payload);
  }

  private postChatMessage(role: 'user' | 'assistant', content: string): void {
    this.postToWebview('chatMessage', { role, content });
  }

  private postChatError(message: string): void {
    this.postToWebview('chatError', { message });
  }

  private postStatus(status: 'idle' | 'thinking' | 'processing' | 'error', message?: string): void {
    const legacyState = status === 'idle' ? 'idle' : 'busy';
    const statusMessage: StatusMessage & { state: 'busy' | 'idle' } = {
      type: 'status',
      status,
      message,
      state: legacyState
    };
    this.postToWebview('status', statusMessage);
  }

  private postContextPreview(context: ConversationContext, prompt: string): void {
    const preview = {
      hasEditor: Boolean(context.editor),
      editorFile: context.editor?.path ?? '',
      editorLanguage: context.editor?.languageId ?? '',
      editorLines: context.editor ? this.truncateForPreview(context.editor.content, 400) : '',
      hasWorkspace: context.workspaceFiles.length > 0 || context.requestedFiles.length > 0,
      workspaceFiles: [...context.workspaceFiles, ...context.requestedFiles.map((file) => file.path)],
      finalPrompt: this.truncateForPreview(prompt, MAX_PROMPT_PREVIEW),
      revision: context.revision,
      editorOverrides: context.editorOverrides,
      diskFiles: context.diskFiles,
      diagnostics: context.diagnostics.length
    };

    this.postToWebview('contextPreview', { preview });
  }

  private postContextBadges(context: ConversationContext): void {
    const sources = {
      hasEditor: Boolean(context.editor),
      hasWorkspace: context.workspaceFiles.length > 0 || context.requestedFiles.length > 0,
      revision: context.revision,
      diagnostics: context.diagnostics.length
    };
    this.postToWebview('contextBadges', { sources });
  }

  private ensureContextCompleteness(result: ConversationBuildResult): void {
    if (result.missingPaths.length > 0) {
      throw new Error(
        `Live buffers missing for: ${result.missingPaths.join(', ')}. Unable to prepare complete context.`
      );
    }
  }

  private postToWebview(type: string, payload: unknown): void {
    try {
      const message: Record<string, unknown> =
        typeof payload === 'object' && payload !== null
          ? { type, ...(payload as Record<string, unknown>) }
          : { type, payload };
      this.webviewView?.webview.postMessage(message);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.log(`Failed to post message to webview (${type}): ${err.message}`, 'warn');
    }
  }

  private async collectConversationContext(
    userMessage: string,
    mentionedFiles: string[],
    docMentions: string[]
  ): Promise<ConversationBuildResult> {
    const revision = this.workspaceState.getRevision();
    const [editorSnapshot, workspaceFilesRaw, diagnosticsRaw] = await Promise.all([
      this.workspaceState.getActiveEditorContext(),
      this.workspaceState.getWorkspaceFiles(),
      Promise.resolve(this.workspaceState.getDiagnostics())
    ]);

    const workspaceFiles = this.limitWorkspaceFiles(workspaceFilesRaw);
    const diagnostics = diagnosticsRaw.map(mapDiagnosticEntry);

    const docRequestedPaths = this.resolveDocFileMatches(userMessage, docMentions, workspaceFilesRaw);
    const nonDocMentions = mentionedFiles.filter((entry) => !this.isDocLikePath(entry));
    const resolvedNonDocPaths = this.resolveWorkspacePaths(nonDocMentions, workspaceFilesRaw);
    let combinedPaths = this.mergeRequestedPaths(resolvedNonDocPaths, docRequestedPaths);

    const targetsActiveEditor = this.targetsActiveEditor(userMessage, mentionedFiles, docMentions);
    if (targetsActiveEditor && editorSnapshot?.path) {
      combinedPaths = this.mergeRequestedPaths(combinedPaths, [editorSnapshot.path]);
    }

    const overrides = this.workspaceState.getOverridesForPaths(combinedPaths, editorSnapshot?.path);

    const editor: ActiveEditorContext | undefined = editorSnapshot
      ? {
          path: editorSnapshot.path,
          languageId: editorSnapshot.languageId,
          content: editorSnapshot.content,
          truncated: editorSnapshot.truncated,
          version: editorSnapshot.version,
          capturedAt: editorSnapshot.capturedAt,
          source: editorSnapshot.source
        }
      : undefined;

    const contextFiles = await this.buildContextFiles(editor ?? null, combinedPaths, overrides);

    const normalizedToOriginal = new Map<string, string>();
    combinedPaths.forEach((entry) => {
      const normalized = this.normalizePath(entry) ?? entry;
      if (!normalizedToOriginal.has(normalized)) {
        normalizedToOriginal.set(normalized, entry);
      }
    });
    if (editor?.path) {
      const normalizedEditor = this.normalizePath(editor.path) ?? editor.path;
      if (!normalizedToOriginal.has(normalizedEditor)) {
        normalizedToOriginal.set(normalizedEditor, editor.path);
      }
    }

    const seen = new Set<string>();
    contextFiles.forEach((file) => {
      const normalized = this.normalizePath(file.path) ?? file.path;
      seen.add(normalized);
    });
    const missingPaths: string[] = [];
    normalizedToOriginal.forEach((original, normalized) => {
      if (!seen.has(normalized)) {
        missingPaths.push(original);
      }
    });

    const editorOverrides = contextFiles.filter((file) => file.source === 'editor').length;
    const diskFiles = contextFiles.filter((file) => file.source === 'disk').length;

    const context: ConversationContext = {
      editor,
      workspaceFiles,
      requestedFiles: contextFiles,
      diagnostics,
      revision,
      editorOverrides,
      diskFiles
    };

    return {
      context,
      requestedPaths: combinedPaths,
      missingPaths
    };
  }

  private findDocLikeMentions(message: string): string[] {
    const matches = new Set<string>();

    const loosePattern = /([A-Za-z0-9 _()[\]-]+?\.(?:pdf|docx))/gi;
    let result: RegExpExecArray | null;
    while ((result = loosePattern.exec(message)) !== null) {
      const candidate = result[1]?.trim();
      if (candidate) {
        matches.add(candidate);
      }
    }

    this.findMentionedFiles(message)
      .filter((entry) => this.isDocLikePath(entry))
      .forEach((entry) => matches.add(entry));

    return Array.from(matches.values());
  }

  private resolveDocFileMatches(
    userMessage: string,
    docMentions: string[],
    workspaceFiles: string[]
  ): string[] {
    const hasIntent = this.hasDocumentIntent(userMessage);
    if (!hasIntent && docMentions.length === 0) {
      return [];
    }

    const normalizedMentions = new Set<string>(
      docMentions.map((entry) => this.normalizeDocName(entry))
    );

    const matches: string[] = [];
    for (const file of workspaceFiles) {
      if (!this.isDocLikePath(file)) {
        continue;
      }
      const normalizedPath = this.normalizePath(file);
      if (!normalizedPath) {
        continue;
      }
      const normalizedName = this.normalizeDocName(path.basename(file));

      if (normalizedMentions.size === 0) {
        if (hasIntent) {
          matches.push(file);
        }
        continue;
      }

      if (
        normalizedMentions.has(normalizedName) ||
        normalizedMentions.has(this.normalizeDocName(normalizedPath))
      ) {
        matches.push(file);
      }
    }
    return matches;
  }

  private hasDocumentIntent(message: string): boolean {
    const normalized = message.toLowerCase();
    return FILE_INTENT_KEYWORDS.some((keyword) => normalized.includes(keyword));
  }

  private mergeRequestedPaths(primary: string[], secondary: string[]): string[] {
    const normalized = new Set<string>();
    const merged: string[] = [];

    const addPath = (entry: string): void => {
      const normalizedPath = this.normalizePath(entry);
      if (!normalizedPath || normalized.has(normalizedPath)) {
        return;
      }
      normalized.add(normalizedPath);
      merged.push(entry);
    };

    primary.forEach(addPath);
    secondary.forEach(addPath);

    return merged;
  }

  private resolveWorkspacePaths(requestedNames: string[], workspaceFiles: string[]): string[] {
    if (requestedNames.length === 0) {
      return [];
    }

    const resolved: string[] = [];
    const seen = new Set<string>();

    for (const request of requestedNames) {
      const key = request.trim();
      if (!key) {
        continue;
      }

      try {
        const uri = this.resolveRequestedFileUri(key, workspaceFiles);
        const displayPath = this.getDisplayPath(uri);
        const normalized = this.normalizePath(displayPath);
        if (normalized && seen.has(normalized)) {
          continue;
        }
        if (normalized) {
          seen.add(normalized);
        }
        resolved.push(displayPath);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.log(`Failed to resolve file ${key}: ${err.message}`, 'warn');
      }
    }

    return resolved;
  }

  private async buildContextFiles(
    activeEditor: ActiveEditorContext | null,
    requestedPaths: string[],
    overrides: DocumentOverride[]
  ): Promise<RequestedFileContext[]> {
    const rootDir = this.getWorkspaceRoot();
    if (!rootDir) {
      this.log('Cannot build document context: workspace root not found.', 'warn');
      return [];
    }

    const context = await buildContext({
      rootDir,
      activeFile: activeEditor?.path,
      requestedFiles: requestedPaths,
      maxChars: MAX_EDITOR_CONTENT,
      overrides,
      protectedPaths: this.workspaceState.getOpenDocumentPaths()
    });
    return context.files.map((file) => ({
      path: file.path,
      content: file.content,
      source: file.source,
      version: file.version,
      capturedAt: file.capturedAt
    }));
  }

  private handleWorkspaceChange(event: WorkspaceChangeEvent): void {
    if (event.revision <= this.workspaceChangeRevision) {
      return;
    }
    this.workspaceChangeRevision = event.revision;

    const shouldRefresh = this.shouldTriggerContextRefresh(event);
    if (!shouldRefresh) {
      return;
    }

    this.scheduleWorkspaceRefreshNotification();
  }

  private shouldTriggerContextRefresh(event: WorkspaceChangeEvent): boolean {
    switch (event.type) {
      case 'documents':
      case 'workspaceFiles':
      case 'diagnostics':
      case 'activeEditor':
        return true;
      default:
        return false;
    }
  }

  private scheduleWorkspaceRefreshNotification(): void {
    if (this.workspaceDebounceTimer) {
      clearTimeout(this.workspaceDebounceTimer);
    }

    this.workspaceDebounceTimer = setTimeout(() => {
      this.workspaceDebounceTimer = undefined;
      this.workspaceChangeHandlers.forEach((fn: () => void) => {
        try {
          fn();
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.log(`Workspace change handler failed: ${err.message}`, 'warn');
        }
      });
    }, 75);
  }

  private triggerIncrementalContextRefresh(): void {
    if (!this.lastContextInputs) {
      return;
    }

    if (this.contextRefreshPromise) {
      this.pendingContextRefresh = true;
      return;
    }

    this.contextRefreshPromise = this.performIncrementalContextRefresh()
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.log(`Incremental context refresh failed: ${err.message}`, 'warn');
      })
      .finally(() => {
        this.contextRefreshPromise = null;
        if (this.pendingContextRefresh) {
          this.pendingContextRefresh = false;
          this.triggerIncrementalContextRefresh();
        }
      });
  }

  private async performIncrementalContextRefresh(): Promise<void> {
    const snapshot = this.lastContextInputs;
    if (!snapshot) {
      return;
    }

    const session = this.sessions.get(snapshot.sessionId);
    if (!session) {
      this.lastContextInputs = null;
      return;
    }

    try {
      const stable = await this.collectStableConversationContext(
        snapshot.userMessage,
        snapshot.mentionedFiles,
        snapshot.docMentions,
        { recomputeMentions: true }
      );

      const buildResult = stable.buildResult;
      const context = buildResult.context;
      const prompt = this.composePrompt(snapshot.historyForPrompt, context);
      const postComposeRevision = this.workspaceState.getRevision();

      if (postComposeRevision !== context.revision) {
        this.log(
          `Workspace changed during incremental refresh (rev ${postComposeRevision} != ${context.revision}); deferring update.`,
          'info'
        );
        return;
      }

      this.setLastContextInputs({
        sessionId: snapshot.sessionId,
        userMessage: snapshot.userMessage,
        mentionedFiles: stable.mentionedFiles,
        docMentions: stable.docMentions,
        historyForPrompt: snapshot.historyForPrompt,
        requestedPaths: buildResult.requestedPaths,
        revision: context.revision
      });

      this.postContextPreview(context, prompt);
      this.postContextBadges(context);
      this.lastConversationSnapshot = {
        revision: context.revision,
        context,
        requestedPaths: [...buildResult.requestedPaths],
        capturedAt: Date.now()
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.log(`Failed to refresh context after workspace change: ${err.message}`, 'warn');
    }
  }

  private ensureContextHasFiles(context: ConversationContext): void {
    if (!context.editor && context.requestedFiles.length === 0) {
      throw new Error('No live workspace files captured. Open or reference the relevant file before asking.');
    }
  }

  private diagnosticsAllowResponse(context: ConversationContext): boolean {
    const blocking = this.getBlockingDiagnostics(context);
    return blocking.length === 0;
  }

  private getBlockingDiagnostics(context: ConversationContext): DiagnosticEntry[] {
    const trackedPaths = new Set<string>();
    if (context.editor?.path) {
      trackedPaths.add(this.normalizePath(context.editor.path) ?? context.editor.path);
    }
    context.requestedFiles.forEach((file) => {
      const normalized = this.normalizePath(file.path) ?? file.path;
      trackedPaths.add(normalized);
    });

    return context.diagnostics.filter((diag) => {
      if (diag.severity !== 'error') {
        return false;
      }
      const normalized = this.normalizePath(diag.path) ?? diag.path;
      return trackedPaths.size === 0 || trackedPaths.has(normalized);
    });
  }

  private formatDiagnosticsRefusal(context: ConversationContext): string {
    const blocking = this.getBlockingDiagnostics(context);
    if (blocking.length === 0) {
      return 'Workspace diagnostics are clean.';
    }

    const lines: string[] = [
      'I cannot proceed because the live workspace has blocking diagnostics:',
      ''
    ];

    blocking.slice(0, 10).forEach((diag) => {
      lines.push(
        `- ${diag.path}:${diag.range.startLine + 1}:${diag.range.startCharacter + 1} — ${diag.message}`
      );
    });

    if (blocking.length > 10) {
      lines.push(`- …and ${blocking.length - 10} more issues.`);
    }

    lines.push('', 'Resolve these diagnostics, then resend your request.');
    return lines.join('\n');
  }

  private async collectStableConversationContext(
    userMessage: string,
    mentionedFiles: string[],
    docMentions: string[],
    options?: { recomputeMentions?: boolean; maxAttempts?: number }
  ): Promise<{
    buildResult: ConversationBuildResult;
    mentionedFiles: string[];
    docMentions: string[];
  }> {
    const attempts = options?.maxAttempts ?? MAX_CONTEXT_PREP_ATTEMPTS;
    let currentMentioned = mentionedFiles;
    let currentDocMentions = docMentions;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (options?.recomputeMentions !== false) {
        currentMentioned = this.findMentionedFiles(userMessage);
        currentDocMentions = this.findDocLikeMentions(userMessage);
      }

      const buildResult = await this.collectConversationContext(
        userMessage,
        currentMentioned,
        currentDocMentions
      );

      this.ensureContextCompleteness(buildResult);
      this.ensureContextHasFiles(buildResult.context);

      const revisionAfterBuild = this.workspaceState.getRevision();
      if (revisionAfterBuild === buildResult.context.revision) {
        return {
          buildResult,
          mentionedFiles: currentMentioned,
          docMentions: currentDocMentions
        };
      }

      this.log(
        `Workspace changed during context capture (rev ${revisionAfterBuild} != ${buildResult.context.revision}); retrying...`,
        'info'
      );
    }

    throw new Error(
      'Workspace changed repeatedly while preparing context. Wait for edits to settle and resend your request.'
    );
  }

  private targetsActiveEditor(
    userMessage: string,
    mentionedFiles: string[],
    docMentions: string[]
  ): boolean {
    const normalized = userMessage.toLowerCase();
    const mentionsActiveAlias = ACTIVE_EDITOR_ALIASES.some((alias) => normalized.includes(alias));
    if (mentionsActiveAlias) {
      return true;
    }

    const mentionsAnyFile = mentionedFiles.length > 0 || docMentions.length > 0;
    const hasCodeIntent = IMPLICIT_CODE_INTENT.some((token) => normalized.includes(token));
    if (hasCodeIntent && !mentionsAnyFile) {
      return true;
    }

    return false;
  }

  private cloneMessagesForPrompt(messages: ChatMessage[], overrideLastContent?: string): ChatMessage[] {
    const cloned = messages.map((message) => ({ ...message }));
    if (overrideLastContent && cloned.length > 0) {
      const lastIndex = cloned.length - 1;
      cloned[lastIndex] = { ...cloned[lastIndex], content: overrideLastContent };
    }
    return cloned;
  }

  private setLastContextInputs(inputs: LastContextInputs): void {
    this.lastContextInputs = {
      sessionId: inputs.sessionId,
      userMessage: inputs.userMessage,
      mentionedFiles: [...inputs.mentionedFiles],
      docMentions: [...inputs.docMentions],
      historyForPrompt: inputs.historyForPrompt.map((message) => ({ ...message })),
      requestedPaths: [...inputs.requestedPaths],
      revision: inputs.revision
    };
  }

  private composePrompt(history: ChatMessage[], context: ConversationContext): string {
    // Extract the last user message
    const lastUserMessage = [...history].reverse().find(msg => msg.role === 'user')?.content || '';
    
    // Determine if this is an output request
    const isOutputRequest = /(example|sample|show|provide|what).*output|run.*code|execute/i.test(lastUserMessage);

    const lines: string[] = [
      `Context Revision: ${context.revision} (editor overrides: ${context.editorOverrides}, disk files: ${context.diskFiles})`,
      '' ,
      '# SYSTEM INSTRUCTIONS - READ CAREFULLY',
      'You are TITAN, a precise and deterministic coding assistant.',
      'Your responses must be based SOLELY on the files and context provided below.',
      '',
      '# CORE BEHAVIOR',
      '1. **PRIORITY OF DISCOVERY**: When information is missing, immediately call `list_files`, `read_file`, or `grep` (without asking for permission) until you have the required code context.',
      '2. **ACTION-FIRST REASONING**: Think in three internal stages — [PLAN] what you need, [ACT] by executing the required tool calls, [VERIFY] the gathered results before replying.',
      '3. **SILENT EXECUTION**: Do not narrate tool calls. Execute them internally and only produce a final response once the required context is gathered and verified.',
      '4. **NO HALLUCINATIONS**: Only reference files that are explicitly shown below or retrieved through tool calls.',
      '5. **PRECISION OVER VERBOSITY**: Be concise and technical; avoid filler language and apologies.',
      '',
      '# RESPONSE FORMAT RULES',
      '## FOR OUTPUT REQUESTS:',
      '1. Show ONLY the exact terminal output in a code block',
      '2. Do NOT explain the code',
      '3. Do NOT include the program code',
      '4. If inputs are needed, use the most common case',
      '',
      '## FOR EXPLANATION REQUESTS:',
      '1. Reference specific line numbers',
      '2. Be technical and detailed',
      '3. Explain the control flow and logic',
      '',
      '# FEW-SHOT EXAMPLES',
      '---',
      'USER: "what does sum.c output?"',
      'ASSISTANT:',
      '```',
      'Enter the first number: 5',
      'Enter the second number: 3',
      'Sum of 5 and 3 is 8',
      '```',
      '---',
      'USER: "explain sum.c"',
      'ASSISTANT:',
      'sum.c is a C program that:',
      '1. Declares three integers (num1, num2, sum)',
      '2. Prompts for two numbers using printf/scanf',
      '3. Adds them and displays the result',
      '---',
      'USER: "show output"',
      'ASSISTANT:',
      '```',
      'Enter the first number: 10',
      'Enter the second number: 20',
      'Sum of 10 and 20 is 30',
      '```',
      '---',
      '',
      '# ACTIVE FILES - READ THESE CAREFULLY'
    ];

    // Add active editor content if available
    if (context.editor) {
      lines.push(`## ACTIVE EDITOR: ${context.editor.path}`, '');
      lines.push('```' + context.editor.languageId);
      lines.push(context.editor.content);
      lines.push('```', '');
    }

    // Add requested files
    if (context.requestedFiles.length > 0) {
      lines.push('## REQUESTED FILES', '');
      context.requestedFiles.forEach(file => {
        const metadata: string[] = [`Source: ${file.source}`];
        if (file.version !== undefined) {
          metadata.push(`Version: ${file.version}`);
        }
        if (file.capturedAt !== undefined) {
          metadata.push(`Captured: ${new Date(file.capturedAt).toISOString()}`);
        }
        lines.push(`### ${file.path}`, `<!-- ${metadata.join(' | ')} -->`, '```', file.content, '```', '');
      });
    }

    if (context.diagnostics.length > 0) {
      lines.push('## DIAGNOSTICS (AUTHORITATIVE)', '');
      context.diagnostics.forEach((diag) => {
        lines.push(`- [${diag.severity.toUpperCase()}] ${diag.path}:${diag.range.startLine + 1}:${diag.range.startCharacter + 1} – ${diag.message}`);
      });
      lines.push('');
    }

    // Add workspace files list (not content)
    if (context.workspaceFiles.length > 0) {
      lines.push('## AVAILABLE WORKSPACE FILES', '');
      const preview = context.workspaceFiles.slice(0, 30);
      preview.forEach(file => lines.push(`- ${file}`));
      if (context.workspaceFiles.length > 30) {
        lines.push(`... and ${context.workspaceFiles.length - 30} more files`);
      }
      lines.push('');
    }

    // Add conversation history
    lines.push('# CONVERSATION HISTORY', '');
    const recentHistory = history.slice(-6); // Last 3 turns
    recentHistory.forEach(msg => {
      lines.push(`## ${msg.role.toUpperCase()}`, msg.content, '');
    });

    // Add final instructions based on request type
    if (isOutputRequest) {
      lines.push(
        '# INSTRUCTION: SHOW OUTPUT ONLY',
        'Based on the code above, show ONLY the program output in a code block:',
        '```'
      );
    } else {
      lines.push(
        '# INSTRUCTION: RESPOND',
        'Based on the files and conversation above, provide a helpful response:'
      );
    }

    return lines.join('\n');
  }

  private truncateForPreview(value: string, max: number): string {
    if (value.length <= max) {
      return value;
    }
    return `${value.slice(0, max)}\n…[truncated]`;
  }

  private limitWorkspaceFiles(files: string[]): string[] {
    if (files.length <= MAX_WORKSPACE_FILES) {
      return files;
    }
    const trimmed = files.slice(0, MAX_WORKSPACE_FILES);
    trimmed.push(`... (${files.length - MAX_WORKSPACE_FILES} more files not listed)`);
    return trimmed;
  }

  private async invokeOllama(prompt: string, cancellationToken?: vscode.CancellationToken): Promise<string> {
    if (!this.ollama) {
      throw new Error('Ollama client is not available.');
    }

    if (!this.isOllamaClient(this.ollama)) {
      throw new Error('Ollama client not initialized.');
    }

    this.log('Sending prompt to Ollama…', 'info');

    if (cancellationToken?.isCancellationRequested) {
      throw new Error('Request cancelled by user.');
    }

    let cancellationDisposable: vscode.Disposable | undefined;

    try {
      const generatePromise = this.ollama.generate({ prompt });

      const result = await (cancellationToken
        ? Promise.race([
            generatePromise,
            new Promise<never>((_, reject) => {
              cancellationDisposable = cancellationToken.onCancellationRequested(() => {
                cancellationDisposable?.dispose();
                reject(new Error('Request cancelled by user.'));
              });
            })
          ])
        : generatePromise);

      cancellationDisposable?.dispose();

      this.log('Ollama response received.', 'info');

      if (typeof result === 'string') {
        return result;
      }

      if (result && typeof result === 'object') {
        const responseField = (result as { response?: unknown }).response;
        if (typeof responseField === 'string') {
          return responseField;
        }

        const messageField = (result as { message?: { content?: unknown } }).message;
        if (messageField && typeof messageField.content === 'string') {
          return messageField.content;
        }
      }

      return JSON.stringify(result);
    } catch (error) {
      cancellationDisposable?.dispose();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private isOllamaClient(value: unknown): value is OllamaClient {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    return typeof (value as OllamaClient).generate === 'function';
  }

  private resolveRequestedFileUri(request: string, workspaceFiles: string[]): vscode.Uri {
    const normalizedRequest = this.normalizePath(request);
    const candidates = workspaceFiles.filter((entry) => {
      const normalizedEntry = this.normalizePath(entry);
      if (!normalizedEntry || !normalizedRequest) {
        return false;
      }
      return (
        normalizedEntry === normalizedRequest ||
        normalizedEntry.endsWith(`/${normalizedRequest}`)
      );
    });

    const matchedEntry = candidates[0];
    if (!matchedEntry) {
      throw new Error(`Failed to read file ${request}: file not found in workspace.`);
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      throw new Error(`Failed to read file ${request}: no workspace folder available.`);
    }

    if (path.isAbsolute(matchedEntry)) {
      return vscode.Uri.file(matchedEntry);
    }

    return vscode.Uri.joinPath(workspaceFolders[0].uri, matchedEntry);
  }

  private getDisplayPath(uri: vscode.Uri): string {
    const relative = vscode.workspace.asRelativePath(uri, false);
    return relative && relative !== uri.fsPath ? relative : uri.fsPath;
  }

  private normalizePath(value: string): string | null {
    if (!value) {
      return null;
    }
    const normalized = value.replace(/\\/g, '/').replace(/^\.?\//, '').trim().toLowerCase();
    return normalized.length > 0 ? normalized : null;
  }

  private isListFilesRequest(message: string): boolean {
    const normalized = message.toLowerCase();
    return /\b(list|show|what|which)\b.*\bfiles\b/.test(normalized);
  }

  private async buildWorkspaceFileListMessage(): Promise<string> {
    const files = await this.workspaceState.getWorkspaceFiles();
    if (files.length === 0) {
      return 'No files found in the current workspace.';
    }
    const lines = files.map((file) => `- ${file}`);
    return ['Workspace files:', ...lines].join('\n');
  }

  private findMentionedFiles(message: string): string[] {
    const pattern = /[A-Za-z0-9_\/\\.-]+\.[A-Za-z0-9]{1,10}/g;
    const matches = message.match(pattern);
    if (!matches) {
      return [];
    }

    const cleaned = matches.map((entry) => entry.replace(/[\s,;:]+$/, ''));
    const unique = new Set<string>();
    for (const candidate of cleaned) {
      const normalized = candidate.trim();
      if (normalized.length > 0) {
        unique.add(normalized);
      }
    }
    return Array.from(unique.values());
  }

  private responseContainsExplanation(response: string): boolean {
    const educationalPhrases = [
      "explanation:",
      "code analysis:",
      "breakdown:",
      "how it works:",
      "the code defines",
      "the function takes",
      "variable is declared",
      "loop iterates",
      "condition checks"
    ];
    const lower = response.toLowerCase();
    return educationalPhrases.some(phrase => lower.includes(phrase));
  }
}
