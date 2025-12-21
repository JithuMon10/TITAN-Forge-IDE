import * as vscode from 'vscode';
import * as path from 'path';
import { OllamaClient } from './ollamaClient';
import {
  getActiveFileContext,
  listWorkspaceFiles
} from './titan/workspaceReader';

type LogLevel = 'info' | 'warn' | 'error';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
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
}

interface RequestedFileContext {
  path: string;
  content: string;
}

interface ConversationContext {
  editor?: ActiveEditorContext;
  workspaceFiles: string[];
  requestedFiles: RequestedFileContext[];
}

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
const MAX_EDITOR_CONTENT = 8000;
const MAX_PROMPT_PREVIEW = 2000;
const MAX_WORKSPACE_FILES = 200;
const MAX_HISTORY = 10;
const MAX_PERSISTED_WORKSPACE_CONTEXT = 5;

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
  }

  // -----------------------------
  // Core chat entry
  // -----------------------------
  async handleMessage(input: string): Promise<string> {
    try {
      if (this.isListFilesRequest(input)) {
        return await this.buildWorkspaceFileListMessage();
      }

      const mentionedFiles = this.findMentionedFiles(input);
      const context = await this.collectConversationContext(input, mentionedFiles);
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
  }

  private handleSwitchSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      this.log(`Switch requested for unknown session ${sessionId}`, 'warn');
      return;
    }
    this.activeSessionId = sessionId;
    this.postSessions('sessions');
  }

  private handleClearSession(): void {
    const session = this.sessions.get(this.activeSessionId);
    if (!session) {
      return;
    }
    session.messages = [];
    this.postSessions('sessions');
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

    let context: ConversationContext;
    let prompt: string;
    try {
      const mentionedFiles = this.findMentionedFiles(content);
      context = await this.collectConversationContext(content, mentionedFiles);
      
      // Use promptContent for the last message in the prompt
      const historyForPrompt = [...session.messages];
      if (isOutputRequest && historyForPrompt.length > 0) {
        const lastMsg = historyForPrompt[historyForPrompt.length - 1];
        historyForPrompt[historyForPrompt.length - 1] = { ...lastMsg, content: promptContent };
      }

      prompt = this.composePrompt(historyForPrompt, context);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const message = err.message || 'Failed to prepare context.';
      this.log(`Context preparation failed: ${message}`, 'error');
      this.postChatError(message);
      this.postStatus('idle');
      return;
    }

    this.postContextPreview(context, prompt);
    this.postContextBadges(context);

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
      finalPrompt: this.truncateForPreview(prompt, MAX_PROMPT_PREVIEW)
    };

    this.postToWebview('contextPreview', { preview });
  }

  private postContextBadges(context: ConversationContext): void {
    const sources = {
      hasEditor: Boolean(context.editor),
      hasWorkspace: context.workspaceFiles.length > 0 || context.requestedFiles.length > 0
    };
    this.postToWebview('contextBadges', { sources });
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

  private async collectConversationContext(userMessage: string, mentionedFiles: string[]): Promise<ConversationContext> {
    const [editor, workspaceFilesRaw] = await Promise.all([
      getActiveFileContext(),
      listWorkspaceFiles()
    ]);

    const requestedFiles = await this.getRequestedFiles(mentionedFiles, workspaceFilesRaw);

    return {
      editor: editor ?? undefined,
      workspaceFiles: this.limitWorkspaceFiles(workspaceFilesRaw),
      requestedFiles
    };
  }

  private async getRequestedFiles(requestedNames: string[], workspaceFiles: string[]): Promise<RequestedFileContext[]> {
    if (requestedNames.length === 0) {
      return [];
    }

    const results: RequestedFileContext[] = [];
    const seen = new Set<string>();
    const attemptedPaths = new Set<string>(); // Prevent retry loops for same path

    for (const request of requestedNames) {
      const key = request.trim();
      if (!key || seen.has(key)) {
        continue;
      }
      
      if (attemptedPaths.has(key)) {
        this.log(`Skipping duplicate read attempt for: ${key}`, 'warn');
        continue;
      }
      
      seen.add(key);
      attemptedPaths.add(key);

      try {
        const uri = this.resolveRequestedFileUri(key, workspaceFiles);
        // Additional check for resolved path to ensure uniqueness
        const fsPath = uri.fsPath;
        if (attemptedPaths.has(fsPath)) {
             this.log(`Skipping duplicate read attempt for resolved path: ${fsPath}`, 'warn');
             continue;
        }
        attemptedPaths.add(fsPath);

        const rawContent = await vscode.workspace.fs.readFile(uri);
        results.push({
          path: this.getDisplayPath(uri),
          content: this.textDecoder.decode(rawContent)
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        // We log the error but do NOT throw, allowing the "Reasoning Fallback" to kick in
        this.log(`Failed to read file ${key}: ${err.message}`, 'warn');
        // We do NOT add a partial result, effectively simulating "tool failed" so the LLM must rely on reasoning
      }
    }
    return results;
  }

  private composePrompt(history: ChatMessage[], context: ConversationContext): string {
    // Extract the last user message
    const lastUserMessage = [...history].reverse().find(msg => msg.role === 'user')?.content || '';
    
    // Determine if this is an output request
    const isOutputRequest = /(example|sample|show|provide|what).*output|run.*code|execute/i.test(lastUserMessage);

    const lines: string[] = [
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
        lines.push(`### ${file.path}`, '```', file.content, '```', '');
      });
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

  private normalizePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  }

  private getDisplayPath(uri: vscode.Uri): string {
    const relative = vscode.workspace.asRelativePath(uri, false);
    return relative && relative !== uri.fsPath ? relative : uri.fsPath;
  }

  private isListFilesRequest(message: string): boolean {
    const normalized = message.toLowerCase();
    return /\b(list|show|what|which)\b.*\bfiles\b/.test(normalized);
  }

  private async buildWorkspaceFileListMessage(): Promise<string> {
    const files = await listWorkspaceFiles();
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
