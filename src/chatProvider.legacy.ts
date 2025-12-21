/**
 * TITAN Forge Chat Provider — Deterministic Agent (2025 refactor)
 * ----------------------------------------------------------------
 * This module now hosts a minimal, deterministic pipeline:
 *   • Step 0: Regex-based chat fast path. Greetings and pleasantries return immediately.
 *   • Step 1: Intent routing. Non-chat requests resolve to WORKSPACE flow.
 *   • Step 2: ContextManager harvests editor/workspace/chat state.
 *   • Step 3: Action-first agent loop executes silently, enforcing tool evidence before answers.
 *   • Step 4: Only the final assistant reply is streamed to the UI.
 *
 * Legacy refusal logic, authority prompts, and fallback text have been removed to guarantee
 * deterministic behaviour and silent tool execution.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { OllamaClient } from './ollamaClient';

type ChatRole = 'user' | 'assistant';

interface ChatMessage {
  role: ChatRole;
  content: string;
  timestamp: number;
}

interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  workspaceContext: string[];
  workspaceFiles: string[];
}

interface SerializedSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  workspaceContext?: string[];
  workspaceFiles?: string[];
}

type LogLevel = 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: number;
}

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'send'; sessionId: string; content: string }
  | { type: 'cancel'; sessionId: string }
  | { type: 'newSession'; title?: string }
  | { type: 'switchSession'; sessionId: string }
  | { type: 'renameSession'; sessionId: string; title: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'debug'; level: LogLevel; message: string };

type NormalizedIntent = 'INTENT_REFLECTION' | 'INTENT_EMERGENCY' | 'INTENT_FRUSTRATION';

interface IntentInterpretation {
  kind: 'EDIT' | 'DESCRIBE' | 'READ' | 'QUESTION';
  requiresEditor: boolean;
  requiresWorkspace: boolean;
  detectedPhrases: string[];
}
interface ReasoningPlan {
  intent: IntentInterpretation;
  contextualNotes: string[];
  requestedFileHints?: string[];
  highConfidenceFiles?: string[];
  requiredTools: string[];
}

type IntentRoute = 'CHAT' | 'WORKSPACE';

interface IntentRouteResult {
  route: IntentRoute;
  requiresEditor: boolean;
  requiresWorkspace: boolean;
  normalizedIntents: Set<NormalizedIntent>;
  requestedFiles: string[];
  highConfidenceFiles: string[];
  missingFiles: string[];
  finalReply?: string;
  intent: IntentInterpretation;
}

interface ContextSnapshot {
  contextBlocks: string[];
  conversation: AgentMessage[];
  contextSources: { hasEditor: boolean; hasWorkspace: boolean };
  editorMetadata?: { file: string; language: string; lines: string };
  workspaceFiles: string[];
  preview: ContextPreview;
}

interface StreamResult {
  raw: string;
  sanitized: string;
}

interface StreamState {
  cts: vscode.CancellationTokenSource;
  buffer: string;
  rawBuffer: string;
  sessionId: string;
  contextSources?: { hasEditor: boolean; hasWorkspace: boolean };
  intents?: Set<NormalizedIntent>;
  plan?: ReasoningPlan;
  emitToUI: boolean;
  keepBusy: boolean;
  resolve?: (value: StreamResult) => void;
  reject?: (error: Error) => void;
}

interface ContextPreview {
  hasEditor: boolean;
  editorFile?: string;
  editorLanguage?: string;
  editorLines?: string;
  hasWorkspace: boolean;
  workspaceFiles?: string[];
  finalPrompt: string;
}

interface PromptPayload {
  readonly systemPrompt: string;
  readonly reasoningPlan: string;
  readonly contextBlocks: readonly string[];
  readonly conversation: readonly AgentMessage[];
}

type AgentMessageRole = 'user' | 'assistant' | 'tool' | 'system';

interface AgentMessage {
  role: AgentMessageRole;
  content: string;
}

interface ToolCall {
  name: 'list_files' | 'read_file' | 'grep';
  args: Record<string, unknown>;
  raw: string;
}

interface ToolExecutionResult {
  success: boolean;
  message: string;
  fallbackMessage?: string;
  contextBlock?: string;
  hasData?: boolean;
  workspaceFiles?: string[];
  summary?: string;
  searchedFor?: string;
  similarFiles?: string[];
}

type AgentResponse =
  | { kind: 'tool'; call: ToolCall; raw: string }
  | { kind: 'message'; content: string; raw: string };

interface AgentLoopResult {
  finalMessage: string;
  conversation: AgentMessage[];
  contextBlocks: string[];
  contextSources: { hasEditor: boolean; hasWorkspace: boolean };
  toolCalls: string[];
}

const MAX_LOG_ENTRIES = 200;
const MAX_HISTORY = 100;
const MAX_FILE_CONTENT_LENGTH = 8000;
const MAX_EDITOR_CONTEXT_LENGTH = 12000;
const MAX_WORKSPACE_FILES = 10;
const MAX_TOOL_ATTEMPTS = 2;
const MAX_TOOL_RESULT_LINES = 200;
const MAX_GREP_RESULTS = 40;
const TOOL_RESULT_CHARACTER_LIMIT = 4000;
const MAX_PERSISTED_WORKSPACE_CONTEXT = 20;
const MAX_PERSISTED_WORKSPACE_FILES = 200;
const MAX_RESPONSE_VALIDATION_RETRIES = 1;
const SESSIONS_STORAGE_KEY = 'titanForgeAI.sessions';
const ACTIVE_SESSION_STORAGE_KEY = 'titanForgeAI.sessions.activeId';
const LOG_STORAGE_KEY = 'titanForgeAI.activityLog';
const DEFAULT_SESSION_TITLE = 'Untitled Chat';

const TOOL_DEFINITIONS_FOR_PROMPT = `[TOOLS]
- list_files(path?): discover files and directories before referencing them.
- read_file(path, startLine?, endLine?): fetch concrete code excerpts.
- grep(pattern, path?, caseSensitive?, useRegex?): locate definitions or usages.
Emit tool calls as JSON {"tool":"<name>","arguments":{...}}. Await tool results before drafting the reply.
[/TOOLS]`;

// Keywords that trigger workspace search
const INTENT_NORMALIZATION_RULES: Array<{ tag: NormalizedIntent; patterns: RegExp[] }> = [
  {
    tag: 'INTENT_REFLECTION',
    patterns: [/\blet that sink in\b/i, /\btake a breather\b/i, /\bstep back for a moment\b/i]
  },
  {
    tag: 'INTENT_EMERGENCY',
    patterns: [/\bcall 911\b/i, /\burgent\b/i, /\bhelp now\b/i, /\bemergency\b/i, /\bneed help asap\b/i]
  },
  {
    tag: 'INTENT_FRUSTRATION',
    patterns: [/\bdriving me crazy\b/i, /\bat my wit'?s end\b/i, /\bso frustrating\b/i, /\bthis is killing me\b/i]
  }
];

const EDIT_KEYWORDS = ['fix', 'modify', 'refactor', 'change', 'update', 'rewrite', 'implement', 'patch', 'adjust', 'add', 'remove', 'rename'];
const DESCRIBE_KEYWORDS = ['explain', 'describe', 'summarize', 'document', 'walk through', 'clarify', 'comment'];
const READ_KEYWORDS = ['read', 'show', 'view', 'open', 'display', 'print'];
const POINTER_TERMS = ['this', 'it', 'that', 'current file', 'this file', 'the file', 'here'];
const WORKSPACE_TERMS = ['workspace', 'project', 'repo', 'repository', 'folder', 'directory', 'files', 'file list', 'codebase'];
const FILE_REFERENCE_REGEX = /[A-Za-z0-9_\-/.]+\.(?:ts|tsx|js|jsx|json|py|java|go|rb|cs|cpp|c|md|txt|yml|yaml|toml|xml|html|css|scss|rs|php|kt|swift|sh)/gi;

export class ContextManager {
  private readonly contextBlocks: string[] = [];
  private readonly conversation: AgentMessage[] = [];
  private contextSources: { hasEditor: boolean; hasWorkspace: boolean } = { hasEditor: false, hasWorkspace: false };
  private editorMetadata: { file: string; language: string; lines: string } | undefined;
  private readonly preview: ContextPreview;
  private workspaceFiles: string[] = [];

  constructor(
    private readonly provider: ChatProvider,
    private readonly session: ChatSession,
    private readonly prompt: string,
    private readonly route: IntentRouteResult,
    private readonly pendingEditorSymbols?: string
  ) {
    this.conversation.push({ role: 'user', content: prompt });
    this.workspaceFiles = [...(session.workspaceFiles ?? [])];
    this.preview = {
      hasEditor: false,
      hasWorkspace: false,
      workspaceFiles: this.workspaceFiles.slice(0, MAX_PERSISTED_WORKSPACE_FILES),
      finalPrompt: ''
    };
  }

  public async build(): Promise<ContextSnapshot> {
    await Promise.all([this.captureEditorContext(), this.captureWorkspaceContext(), this.captureHistoricalMessages()]);

    this.preview.hasEditor = this.contextSources.hasEditor;
    this.preview.hasWorkspace = this.contextSources.hasWorkspace;
    if (this.editorMetadata) {
      this.preview.editorFile = this.editorMetadata.file;
      this.preview.editorLanguage = this.editorMetadata.language;
      this.preview.editorLines = this.editorMetadata.lines;
    }

    return {
      contextBlocks: this.contextBlocks,
      conversation: this.conversation,
      contextSources: this.contextSources,
      editorMetadata: this.editorMetadata,
      workspaceFiles: this.workspaceFiles,
      preview: this.preview
    };
  }

  private async captureEditorContext(): Promise<void> {
    if (!this.route.requiresEditor) {
      return;
    }

    const editorContext = this.provider.collectEditorContext();
    if (editorContext.context) {
      this.contextBlocks.push(editorContext.context);
      this.contextSources.hasEditor = true;
      this.editorMetadata = editorContext.metadata;
    }

    if (this.pendingEditorSymbols) {
      this.contextBlocks.push(this.pendingEditorSymbols);
      this.contextSources.hasWorkspace = true;
      this.provider.appendWorkspaceContext(this.session, this.pendingEditorSymbols);
    }
  }

  private async captureWorkspaceContext(): Promise<void> {
    const persisted = this.session.workspaceContext ?? [];
    if (persisted.length > 0) {
      this.contextBlocks.push(...persisted);
      this.contextSources.hasWorkspace = true;
    }
    if (this.session.workspaceFiles && this.session.workspaceFiles.length > 0) {
      this.contextSources.hasWorkspace = true;
    }
  }

  private async captureHistoricalMessages(): Promise<void> {
    const priorMessages = this.session.messages.slice(-6);
    priorMessages.forEach((message) => {
      this.conversation.unshift({ role: message.role, content: message.content });
    });
  }

  public injectContextBlock(block: string): void {
    if (block.trim().length === 0) {
      return;
    }
    this.contextBlocks.push(block);
    if (block.includes('[EDITOR_CONTEXT]')) {
      this.contextSources.hasEditor = true;
    }
    if (block.includes('[WORKSPACE_CONTEXT]')) {
      this.contextSources.hasWorkspace = true;
    }
  }
}

export class ChatProvider implements vscode.Disposable {
  private webviewView: vscode.WebviewView | undefined;
  private readonly logs: LogEntry[] = [];
  private readonly sessions = new Map<string, ChatSession>();
  private activeSessionId: string;
  private streamState: StreamState | undefined;
  private currentTurnToolCalls: Set<string> = new Set();
  private readonly lastTurnMetadata = new Map<string, { toolCalls: string[]; finalMessage: string }>();
  private readonly disposables: vscode.Disposable[] = [];
  private editorSymbolContext: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly ollama: OllamaClient,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly version: string
  ) {
    const storedSessions = this.context.workspaceState.get<SerializedSession[]>(SESSIONS_STORAGE_KEY);
    if (Array.isArray(storedSessions) && storedSessions.length > 0) {
      storedSessions.forEach((raw) => {
        const session = this.hydrateSession(raw);
        this.sessions.set(session.id, session);
      });
    }

    if (this.sessions.size === 0) {
      const initial = this.createSession();
      this.sessions.set(initial.id, initial);
    }

    const storedActiveId = this.context.workspaceState.get<string>(ACTIVE_SESSION_STORAGE_KEY);
    const fallbackId = this.sessions.keys().next().value as string;
    this.activeSessionId = storedActiveId && this.sessions.has(storedActiveId) ? storedActiveId : fallbackId;

    const storedLogs = this.context.workspaceState.get<LogEntry[]>(LOG_STORAGE_KEY);
    if (Array.isArray(storedLogs)) {
      storedLogs.slice(-MAX_LOG_ENTRIES).forEach((entry) => this.logs.push(entry));
    }

    this.log('Chat provider initialized.', 'info');

    const editorListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
      this.handleActiveEditorChange(editor);
    });
    this.disposables.push(editorListener);
    this.context.subscriptions.push(editorListener);

    this.handleActiveEditorChange(vscode.window.activeTextEditor);
  }

  public getSessionSnapshot(sessionId: string): { messages: Array<{ role: string; content: string; timestamp: number }>; workspaceContext: string[] } | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return undefined;
    }

    return {
      messages: session.messages.map((message) => ({ role: message.role, content: message.content, timestamp: message.timestamp })),
      workspaceContext: [...session.workspaceContext]
    };
  }

  public getLastTurnMetadata(sessionId: string): { toolCalls: string[]; finalMessage: string } | undefined {
    const metadata = this.lastTurnMetadata.get(sessionId);
    if (!metadata) {
      return undefined;
    }
    return {
      toolCalls: [...metadata.toolCalls],
      finalMessage: metadata.finalMessage
    };
  }

  dispose(): void {
    this.cancelStream('Disposing chat provider.', false);
    for (const disposable of this.disposables) {
      try {
        disposable.dispose();
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        this.log(`Listener disposal failed: ${err}`, 'warn');
      }
    }
  }

  attachWebview(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;

    webviewView.onDidDispose(() => {
      if (this.webviewView === webviewView) {
        this.webviewView = undefined;
      }
    });

    webviewView.webview.onDidReceiveMessage(async (message: IncomingMessage) => {
      switch (message.type) {
        case 'ready':
          this.log('Webview signaled ready.', 'info');
          this.postInitialState();
          break;
        case 'send':
          this.log(`Webview submitted prompt (${message.content.length} chars).`, 'info');
          await this.handleSendMessage(message.sessionId, message.content);
          break;
        case 'cancel':
          this.log('Webview requested cancellation.', 'warn');
          this.cancelStream('Generation cancelled by user.', true, message.sessionId);
          break;
        case 'newSession':
          this.handleNewSession(message.title);
          break;
        case 'switchSession':
          this.handleSwitchSession(message.sessionId);
          break;
        case 'renameSession':
          this.handleRenameSession(message.sessionId, message.title);
          break;
        case 'deleteSession':
          this.handleDeleteSession(message.sessionId);
          break;
        case 'debug':
          this.log(`Webview: ${message.message}`, message.level);
          break;
        default:
          break;
      }
    });

    if (this.streamState) {
      this.postStatus('busy', this.streamState.sessionId);
    }
  }

  async handleReadFileCommand(): Promise<void> {
    const folder = this.ensureWorkspaceFolder();
    if (!folder) {
      return;
    }

    try {
      const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,.vscode,out,dist}/**', 200);
      if (files.length === 0) {
        vscode.window.showWarningMessage('Titan Forge AI: No files found in workspace.');
        return;
      }

      const picks = files
        .map((uri) => ({
          label: this.getRelativePath(uri),
          uri
        }))
        .sort((a, b) => a.label.localeCompare(b.label));

      const selection = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a file to read'
      });

      if (!selection) {
        return;
      }

      const contentBuffer = await vscode.workspace.fs.readFile(selection.uri);
      const content = this.truncateContent(this.bufferToString(contentBuffer), MAX_FILE_CONTENT_LENGTH);

      this.log(`Read file: ${selection.label}`, 'info');
      this.postMessage({
        type: 'fileRead',
        path: selection.label,
        content
      });
    } catch (error) {
      this.handleCommandError('read file', error);
    }
  }

  async handleEditFileCommand(): Promise<void> {
    const folder = this.ensureWorkspaceFolder();
    if (!folder) {
      return;
    }

    try {
      const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,.vscode,out,dist}/**', 200);
      if (files.length === 0) {
        vscode.window.showWarningMessage('Titan Forge AI: No files found in workspace.');
        return;
      }

      const picks = files
        .map((uri) => ({
          label: this.getRelativePath(uri),
          uri
        }))
        .sort((a, b) => a.label.localeCompare(b.label));

      const selection = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a file to open for editing'
      });

      if (!selection) {
        return;
      }

      const document = await vscode.workspace.openTextDocument(selection.uri);
      await vscode.window.showTextDocument(document, { preview: false });

      this.log(`Opened file: ${selection.label}`, 'info');
      this.postMessage({
        type: 'fileOpened',
        path: selection.label
      });
    } catch (error) {
      this.handleCommandError('open file', error);
    }
  }

  async handleSaveActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('Titan Forge AI: No active editor to save.');
      return;
    }

    try {
      const saved = await editor.document.save();
      if (saved) {
        const path = this.getRelativePath(editor.document.uri);
        this.log(`Saved file: ${path}`, 'info');
        this.postMessage({
          type: 'fileSaved',
          path
        });
      } else {
        this.log('Save cancelled or failed.', 'warn');
      }
    } catch (error) {
      this.handleCommandError('save file', error);
    }
  }

  log(message: string, level: LogLevel = 'info'): void {
    const entry: LogEntry = {
      level,
      message,
      timestamp: Date.now()
    };

    this.logs.push(entry);
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_ENTRIES);
    }
    this.persistLogs();

    this.outputChannel.appendLine(`[${level.toUpperCase()}] ${message}`);

    this.postMessage({
      type: 'log',
      level,
      message,
      timestamp: entry.timestamp
    });
  }

  public collectEditorContext(): { context: string; metadata?: { file: string; language: string; lines: string } } {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return { context: '' };
    }

    const document = editor.document;
    const selection = editor.selection;
    const fileName = this.getRelativePath(document.uri);
    const languageId = document.languageId || 'plaintext';

    const extractRange = (): { text: string; start: number; end: number } => {
      if (!selection.isEmpty) {
        const selectedText = document.getText(selection);
        if (selectedText.trim().length > 0) {
          return {
            text: selectedText,
            start: selection.start.line + 1,
            end: selection.end.line + 1
          };
        }
      }
      return {
        text: document.getText(),
        start: 1,
        end: Math.min(document.lineCount, MAX_TOOL_RESULT_LINES)
      };
    };

    try {
      const range = extractRange();
      let content = range.text;
      if (content.length > MAX_EDITOR_CONTEXT_LENGTH) {
        content = this.truncateContent(content, MAX_EDITOR_CONTEXT_LENGTH);
      }

      if (content.trim().length === 0) {
        return { context: '' };
      }

      const lineInfo = range.start === range.end ? `Line: ${range.start}` : `Lines: ${range.start}–${range.end}`;
      return {
        context: `[EDITOR_CONTEXT]\nFile: ${fileName}\nLanguage: ${languageId}\n${lineInfo}\n---\n${content}\n[/EDITOR_CONTEXT]`,
        metadata: {
          file: fileName,
          language: languageId,
          lines: lineInfo
        }
      };
    } catch {
      return { context: '' };
    }
  }

  // Entry point for a turn. Routes prompts through the intent router and deterministic agent workflow.
  private async handleSendMessage(sessionId: string, content: string): Promise<void> {
    const prompt = content.trim();
    if (prompt.length === 0) {
      this.postMessage({ type: 'chatError', sessionId, message: 'Please enter a prompt.' });
      return;
    }

    const session = this.getOrCreateSession(sessionId);
    this.activeSessionId = session.id;
    this.persistActiveSession();
    this.currentTurnToolCalls = new Set();
    this.lastTurnMetadata.delete(session.id);

    this.log('Routing prompt to TITAN.', 'info');
    const timestamp = Date.now();
    this.addMessage(session.id, { role: 'user', content: prompt, timestamp });
    this.postMessage({ type: 'chatMessage', sessionId: session.id, role: 'user', content: prompt });

    const greetingFastPath = /^(hi|hello|hey|yo|howdy|gm|good\s+(morning|afternoon|evening)|thank\s+you|thanks|appreciate\s+it)\b/i;
    if (greetingFastPath.test(prompt)) {
      const reply = 'Hi there! I am ready when you want to work on the project.';
      this.completeWithAssistantResponse(session, reply);
      return;
    }

    const route = this.routeIntent(session, prompt);
    if (route.route === 'CHAT') {
      const reply = route.finalReply ?? 'All set. Let me know when you want to work on the codebase.';
      this.completeWithAssistantResponse(session, reply);
      return;
    }

    const contextManager = new ContextManager(this, session, prompt, route, this.editorSymbolContext);
    this.editorSymbolContext = undefined;
    const snapshot = await contextManager.build();

    const reasoningPlan = this.createReasoningPlan(route, snapshot);
    const systemPrompt = this.buildSystemPrompt(route, snapshot, reasoningPlan);
    const planSection = this.buildPlanSection(reasoningPlan);

    const promptPayload = this.buildPromptPayload(systemPrompt, planSection, snapshot.contextBlocks, snapshot.conversation);
    snapshot.preview.finalPrompt = this.stripReasoningPlanContent(this.composePrompt(promptPayload));

    this.postMessage({ type: 'contextPreview', sessionId: session.id, preview: snapshot.preview });
    this.postStatus('busy', session.id);
    this.postMessage({ type: 'chatStreamStarted', sessionId: session.id });

    const agentResult = await this.runAgentWorkflow(
      session,
      prompt,
      systemPrompt,
      planSection,
      snapshot,
      route,
      reasoningPlan
    );

    const finalMessage = agentResult.finalMessage.trim() || this.buildWorkspaceSummary(session.workspaceFiles ?? []);
    this.deliverFinalResponse(session, finalMessage, agentResult);
  }

  private routeIntent(session: ChatSession, prompt: string): IntentRouteResult {
    const normalizedIntents = this.detectNormalizedIntents(prompt);
    const intent = this.interpretIntent(prompt);
    const requestedFiles = this.extractFileMentions(prompt);
    const knownFiles = session.workspaceFiles ?? [];
    const { highConfidence, missing } = this.partitionFileHints(requestedFiles, knownFiles);

    const trimmed = prompt.trim();
    const conversational = this.isGreetingPrompt(trimmed) || (/^(thank|thanks|appreciate)/i.test(trimmed) && trimmed.length < 160);
    const requiresWorkspace = intent.requiresWorkspace || requestedFiles.length > 0 || missing.length > 0 || highConfidence.length > 0;
    const requiresEditor = intent.requiresEditor;

    if (!requiresWorkspace && !requiresEditor && conversational) {
      return {
        route: 'CHAT',
        requiresEditor: false,
        requiresWorkspace: false,
        normalizedIntents,
        requestedFiles,
        highConfidenceFiles: highConfidence,
        missingFiles: missing,
        finalReply: 'All set. Let me know when you want to work on the codebase.',
        intent
      };
    }

    return {
      route: 'WORKSPACE',
      requiresEditor,
      requiresWorkspace: true,
      normalizedIntents,
      requestedFiles,
      highConfidenceFiles: highConfidence,
      missingFiles: missing,
      intent
    };
  }

  private createReasoningPlan(route: IntentRouteResult, snapshot: ContextSnapshot): ReasoningPlan {
    const contextualNotes: string[] = [];

    contextualNotes.push(
      snapshot.contextSources.hasEditor
        ? 'Editor selection captured for this turn.'
        : 'Editor context absent; fetch code with read_file if needed.'
    );

    contextualNotes.push(
      snapshot.contextSources.hasWorkspace
        ? 'Workspace snapshot already cached.'
        : 'Workspace discovery pending; call list_files before claiming file knowledge.'
    );

    if (route.highConfidenceFiles.length > 0) {
      contextualNotes.push(`High-confidence file references: ${route.highConfidenceFiles.join(', ')}`);
    }

    if (route.missingFiles.length > 0) {
      contextualNotes.push(`Unresolved file references: ${route.missingFiles.join(', ')}`);
    }

    const requiredTools: string[] = [];
    if (route.requiresWorkspace && !snapshot.contextSources.hasWorkspace) {
      requiredTools.push('list_files');
    }
    if (route.requiresEditor && !snapshot.contextSources.hasEditor) {
      requiredTools.push('read_file');
    }
    if (route.requiresWorkspace && snapshot.workspaceFiles.length === 0 && !requiredTools.includes('list_files')) {
      requiredTools.push('list_files');
    }

    return {
      intent: route.intent,
      contextualNotes,
      requestedFileHints: route.requestedFiles.length > 0 ? route.requestedFiles : undefined,
      highConfidenceFiles: route.highConfidenceFiles.length > 0 ? route.highConfidenceFiles : undefined,
      requiredTools
    };
  }

  private buildPlanSection(plan: ReasoningPlan): string {
    return `[REASONING_PLAN]\n${this.formatReasoningPlan(plan)}\n[/REASONING_PLAN]`;
  }

  private buildSystemPrompt(route: IntentRouteResult, snapshot: ContextSnapshot, plan: ReasoningPlan): string {
    const sections: string[] = [];

    const contextSummary: string[] = [];
    if (snapshot.contextSources.hasEditor && snapshot.editorMetadata) {
      contextSummary.push(`Editor: ${snapshot.editorMetadata.file} (${snapshot.editorMetadata.language}, ${snapshot.editorMetadata.lines}).`);
    }
    if (snapshot.contextSources.hasWorkspace && snapshot.workspaceFiles.length > 0) {
      const preview = snapshot.workspaceFiles.slice(0, 5).join(', ');
      contextSummary.push(`Workspace files: ${preview}${snapshot.workspaceFiles.length > 5 ? '…' : ''}.`);
    }
    if (contextSummary.length === 0) {
      contextSummary.push('Workspace evidence missing. Call list_files before referencing files.');
    }

    const naturalGuidance = this.buildNaturalLanguageGuidance(route.normalizedIntents);
    const executionSummary = this.buildReasoningActionSummary(plan);
    const requiredTools = plan.requiredTools.length > 0 ? plan.requiredTools.join(', ') : 'none';

    sections.push('[IDENTITY]\nYou are TITAN, a disciplined developer co-pilot.\n[/IDENTITY]');
    sections.push('[BEHAVIOR]\n- Think silently.\n- Call tools before citing code or files.\n- Provide one concise, verified answer.\n[/BEHAVIOR]');
    sections.push(`[CONTEXT]\n${contextSummary.join('\n')}\n[/CONTEXT]`);
    sections.push(`[PLAN_HINTS]\nRequired tools this turn: ${requiredTools}.\n[/PLAN_HINTS]`);
    sections.push(`[GUIDANCE]\n${naturalGuidance}\n[/GUIDANCE]`);
    sections.push(`[EXECUTION]\n${executionSummary}\n[/EXECUTION]`);

    return sections.join('\n\n');
  }

  private async runAgentWorkflow(
    session: ChatSession,
    prompt: string,
    systemPrompt: string,
    planSection: string,
    snapshot: ContextSnapshot,
    route: IntentRouteResult,
    plan: ReasoningPlan
  ): Promise<AgentLoopResult> {
    const contextBlocks = [...snapshot.contextBlocks];
    const conversation = [...snapshot.conversation];
    let sources = { ...snapshot.contextSources };

    const primeContext = async (toolName: 'list_files' | 'read_file'): Promise<void> => {
      if (toolName === 'list_files') {
        const discovery = await this.executeListFilesTool({});
        this.currentTurnToolCalls.add('list_files');
        if (discovery.contextBlock) {
          contextBlocks.push(discovery.contextBlock);
          this.appendWorkspaceContext(session, discovery.contextBlock, discovery.workspaceFiles);
          sources.hasWorkspace = true;
        }
        return;
      }

      const targetFile = route.highConfidenceFiles[0] ?? route.requestedFiles[0];
      if (!targetFile) {
        return;
      }

      const readResult = await this.executeReadFileTool({ path: targetFile }, sources);
      this.currentTurnToolCalls.add('read_file');
      if (readResult.contextBlock) {
        contextBlocks.push(readResult.contextBlock);
        this.appendWorkspaceContext(session, readResult.contextBlock, readResult.workspaceFiles);
        sources.hasWorkspace = true;
        if (readResult.contextBlock.includes('[EDITOR_CONTEXT]')) {
          sources.hasEditor = true;
        }
      }
    };

    for (const required of plan.requiredTools) {
      if (required === 'list_files' && sources.hasWorkspace) {
        continue;
      }
      await primeContext(required as 'list_files' | 'read_file');
    }

    let result = await this.runAgentLoop(
      session,
      systemPrompt,
      planSection,
      result.contextBlocks,
      result.conversation,
      result.contextSources,
      route.normalizedIntents,
      plan
    );
  }

  return result;
}

private async runAgentLoop(
  session: ChatSession,
  systemPrompt: string,
  planSection: string,
  contextBlocks: string[],
  conversation: AgentMessage[],
  contextSources: { hasEditor: boolean; hasWorkspace: boolean },
  intents: Set<NormalizedIntent>,
  plan: ReasoningPlan
): Promise<AgentLoopResult> {
  const workingConversation = [...conversation];
  const workingContextBlocks = [...contextBlocks];
  let sources = { ...contextSources };
  const toolCalls: string[] = [];
  const MAX_TURNS = 6;

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const payload = this.buildPromptPayload(systemPrompt, planSection, workingContextBlocks, workingConversation);
    let stream: StreamResult;

    try {
      stream = await this.startStream(session, payload, sources, intents, plan, {
        emitToUI: false,
        keepBusy: true,
        signalStart: turn === 0
          contextSources: sources,
          toolCalls
        };
      }

      toolCalls.push(parsed.call.name);
      this.currentTurnToolCalls.add(parsed.call.name);
      const toolResult = await this.executeTool(parsed.call, sources);
      const summary = this.formatToolResultMessage(parsed.call.name, parsed.call.args, toolResult);
      workingConversation.push({ role: 'tool', content: summary });

      if (toolResult.contextBlock) {
        workingContextBlocks.push(toolResult.contextBlock);
        this.appendWorkspaceContext(session, toolResult.contextBlock, toolResult.workspaceFiles);
        sources = {
          hasEditor: sources.hasEditor || toolResult.contextBlock.includes('[EDITOR_CONTEXT]'),
          hasWorkspace: true
        };
      }

      if (!toolResult.success && toolResult.fallbackMessage) {
        workingConversation.push({ role: 'assistant', content: toolResult.fallbackMessage });
        return {
          finalMessage: toolResult.fallbackMessage,
          conversation: workingConversation,
          contextBlocks: workingContextBlocks,
          contextSources: sources,
          toolCalls
        };
      }
    }

    return {
      finalMessage: '',
      conversation: workingConversation,
      contextBlocks: workingContextBlocks,
      contextSources: sources,
      toolCalls
    };
  }

  private buildWorkspaceSummary(workspaceFiles: string[]): string {
    if (!workspaceFiles || workspaceFiles.length === 0) {
      return 'Workspace summary: no files indexed yet. Ask me to list directories to explore.';
    }

    const unique = Array.from(new Set(workspaceFiles));
    const top = unique.slice(-12).reverse();
    const header = `Workspace summary (${unique.length} files cached):`;
    const bullets = top.map((file) => `- ${file}`).join('\n');
    return `${header}\n${bullets}`;
  }

  private completeWithAssistantResponse(session: ChatSession, message: string): void {
    const responseTimestamp = Date.now();
    this.addMessage(session.id, { role: 'assistant', content: message, timestamp: responseTimestamp });
    this.postMessage({ type: 'chatMessage', sessionId: session.id, role: 'assistant', content: message });
    this.lastTurnMetadata.set(session.id, { toolCalls: [], finalMessage: message });
    this.postMessage({ type: 'chatStreamCompleted', sessionId: session.id });
    this.postStatus('idle', session.id);
  }

  private deliverFinalResponse(
    session: ChatSession,
    finalMessage: string,
    agentResult: AgentLoopResult
  ): void {
    const responseTimestamp = Date.now();
    this.addMessage(session.id, { role: 'assistant', content: finalMessage, timestamp: responseTimestamp });
    this.postMessage({ type: 'chatMessage', sessionId: session.id, role: 'assistant', content: finalMessage });
    this.log('Response received from TITAN.', 'info');

    this.lastTurnMetadata.set(session.id, {
      toolCalls: agentResult.toolCalls,
      finalMessage
    });

    this.postMessage({
      type: 'contextBadges',
      sessionId: session.id,
      sources: agentResult.contextSources
    });

    this.postMessage({ type: 'chatStreamCompleted', sessionId: session.id });
    this.postStatus('idle', session.id);
  }

  private startStream(
    session: ChatSession,
    payload: PromptPayload,
    contextSources: { hasEditor: boolean; hasWorkspace: boolean } | undefined,
    intents: Set<NormalizedIntent> | undefined,
    plan: ReasoningPlan | undefined,
    options: { emitToUI: boolean; keepBusy?: boolean; signalStart?: boolean }
  ): Promise<StreamResult> {
    this.cancelStream('Starting new response.', false);

    const { emitToUI, keepBusy = false, signalStart = true } = options;
    const cts = new vscode.CancellationTokenSource();
    const finalPrompt = this.composePrompt(payload);

    return new Promise<StreamResult>((resolve, reject) => {
      this.streamState = {
        cts,
        buffer: '',
        rawBuffer: '',
        sessionId: session.id,
        contextSources,
        intents,
        plan,
        emitToUI,
        keepBusy,
        resolve,
        reject
      };

      if (signalStart && emitToUI) {
        this.postStatus('busy', session.id);
        this.postMessage({ type: 'chatStreamStarted', sessionId: session.id });
      } else if (signalStart && !keepBusy) {
        this.postStatus('busy', session.id);
      }

      this.ollama
        .streamCompletion(
          { prompt: finalPrompt },
          {
            onToken: (token: string) => this.handleStreamToken(cts, token),
            onError: (error: Error) => this.handleStreamError(cts, error),
            onEnd: () => this.handleStreamEnd(cts)
          },
          cts.token
        )
        .catch((error) => this.handleStreamError(cts, error));
    });
  }

  private handleStreamToken(cts: vscode.CancellationTokenSource, token: string): void {
    const state = this.streamState;
    if (!state || state.cts !== cts || cts.token.isCancellationRequested) {
      return;
    }

    state.rawBuffer += token;
    const sanitized = this.sanitizeVisibleOutput(state.rawBuffer);
    if (sanitized.length <= state.buffer.length) {
      state.buffer = sanitized;
      return;
    }

    const diff = sanitized.slice(state.buffer.length);
    state.buffer = sanitized;
    if (!diff || !state.emitToUI) {
      return;
    }

    this.postMessage({
      type: 'chatStreamChunk',
      sessionId: state.sessionId,
      content: diff
    });
  }

  private handleStreamEnd(cts: vscode.CancellationTokenSource): void {
    const state = this.streamState;
    if (!state || state.cts !== cts) {
      return;
    }

    const session = this.sessions.get(state.sessionId);
    const raw = state.rawBuffer;
    const sanitized = state.buffer.trim();

    if (!session) {
      state.resolve?.({ raw, sanitized });
      this.finishStream(cts, state.keepBusy);
      return;
    }

    if (!state.emitToUI) {
      state.resolve?.({ raw, sanitized });
      this.finishStream(cts, state.keepBusy);
      return;
    }

    if (sanitized) {
      this.addMessage(session.id, { role: 'assistant', content: sanitized, timestamp: Date.now() });
      this.postMessage({
        type: 'chatMessage',
        sessionId: session.id,
        role: 'assistant',
        content: sanitized
      });
      this.log('Response received from Ollama.', 'info');
    } else {
      this.log('Ollama returned no response.', 'warn');
    }

    if (state.contextSources) {
      this.postMessage({
        type: 'contextBadges',
        sessionId: session.id,
        sources: state.contextSources
      });
    }

    this.postMessage({ type: 'chatStreamCompleted', sessionId: session.id });
    state.resolve?.({ raw, sanitized });
    this.finishStream(cts, state.keepBusy);
  }

  private sanitizeVisibleOutput(content: string): string {
    if (!content) {
      return '';
    }

    let sanitized = content;

    const blockPatterns: RegExp[] = [
      /\[SYSTEM(?:_INSTRUCTIONS)?\][\s\S]*?\[\/SYSTEM(?:_INSTRUCTIONS)?\]/gi,
      /\[SYSTEM\][\s\S]*?\[\/SYSTEM\]/gi,
      /\[WORKSPACE_CONTEXT\][\s\S]*?\[\/WORKSPACE_CONTEXT\]/gi,
      /\[EDITOR_CONTEXT\][\s\S]*?\[\/EDITOR_CONTEXT\]/gi,
      /\[CONTEXT(?: SUMMARY)?\][\s\S]*?\[\/CONTEXT(?: SUMMARY)?\]/gi,
      /\[REASONING_PLAN\][\s\S]*?\[\/REASONING_PLAN\]/gi
    ];

    blockPatterns.forEach((pattern) => {
      sanitized = sanitized.replace(pattern, '');
    });

    sanitized = sanitized.replace(/CONTEXT SUMMARY:?[^\n]*\n(?:[\s\S]*?)(?=\n{2,}|$)/gi, '');

    sanitized = sanitized.replace(/```(?:json)?([\s\S]*?)```/gi, (match, group1: string) => {
      const inner = group1 ?? '';
      const normalized = inner.toLowerCase();
      if (normalized.includes('"role"') || normalized.includes('[workspace_context]') || normalized.includes('[editor_context]')) {
        return '';
      }
      return match;
    });

    sanitized = sanitized.replace(/\n{3,}/g, '\n\n');

    return sanitized;
  }

  private detectNormalizedIntents(message: string): Set<NormalizedIntent> {
    const intents = new Set<NormalizedIntent>();
    const text = message.trim();
    if (!text) {
      return intents;
    }

    for (const rule of INTENT_NORMALIZATION_RULES) {
      if (rule.patterns.some((pattern) => pattern.test(text))) {
        intents.add(rule.tag);
      }
    }

    return intents;
  }

  private buildPromptPayload(
    systemPrompt: string,
    reasoningPlan: string,
    contextBlocks: string[],
    conversation: AgentMessage[]
  ): PromptPayload {
    const immutableConversation = conversation.map((message) => ({
      role: message.role,
      content: message.content
    })) as AgentMessage[];

    return Object.freeze({
      systemPrompt,
      reasoningPlan,
      contextBlocks: Object.freeze([...contextBlocks]),
      conversation: Object.freeze(immutableConversation)
    }) as PromptPayload;
  }

  private composePrompt(payload: PromptPayload): string {
    const segments: string[] = [];
    const coreSections = [payload.systemPrompt, TOOL_DEFINITIONS_FOR_PROMPT, payload.reasoningPlan];
    coreSections.forEach((section) => {
      const trimmed = section.trim();
      if (trimmed.length > 0) {
        segments.push(trimmed);
      }
    });

    for (const block of payload.contextBlocks) {
      const trimmed = block.trim();
      if (trimmed.length > 0) {
        segments.push(trimmed);
      }
    }

    payload.conversation.forEach((message) => {
      const roleLabel = message.role === 'tool' ? 'TOOL RESULT' : message.role.toUpperCase();
      const content = message.content.trim();
      if (content.length > 0) {
        segments.push(`[${roleLabel}]\n${content}`);
      }
    });

    return segments.join('\n\n');
  }

  // ACTION_LOOP helper: keep tool call summaries deterministic for agent self-review.
  private summarizeToolCall(name: ToolCall['name'], args: Record<string, unknown>): string {
    const argSummary = this.formatArgsForSummary(args);
    return `TOOL_CALL ${name}${argSummary ? ` ${argSummary}` : ''}`;
  }

  private formatArgsForSummary(args: Record<string, unknown>): string {
    const entries = Object.entries(args)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .slice(0, 3);

    if (entries.length === 0) {
      return '';
    }

    const suffix = Object.keys(args).length > entries.length ? ' …' : '';
    return `[${entries.join(', ')}${suffix}]`;
  }

  private formatToolResultMessage(
    name: ToolCall['name'],
    args: Record<string, unknown>,
    result: ToolExecutionResult
  ): string {
    if (result.summary && result.summary.trim().length > 0) {
      return this.toSingleLine(result.summary);
    }

    const truncated = this.normalizeToolMessage(result.message, name);
    const argSummary = this.formatArgsForSummary(args);
    const singleLine = this.toSingleLine(truncated);
    return argSummary ? `${singleLine} Args ${argSummary}` : singleLine;
  }

  private buildToolContextSummary(toolResult: ToolExecutionResult): string | undefined {
    if (!toolResult.contextBlock) {
      return toolResult.summary ? this.toSingleLine(toolResult.summary) : undefined;
    }

    const block = toolResult.contextBlock;
    const headerMatch = block.match(/\[WORKSPACE_CONTEXT\]\n([^\n]+)\n---/i);
    const header = headerMatch ? headerMatch[1]?.trim() : undefined;

    const bodyMatch = block.match(/---\n([\s\S]*?)\n\[\/WORKSPACE_CONTEXT\]/i);
    const body = bodyMatch ? bodyMatch[1]?.trim() : undefined;
    if (!body) {
      return toolResult.summary ?? header;
    }

    const lines = body.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    if (lines.length === 0) {
      return toolResult.summary ? this.toSingleLine(toolResult.summary) : header;
    }

    const snippetPreview = lines.slice(0, 3).join(' | ');
    if (toolResult.summary) {
      return `${this.toSingleLine(toolResult.summary)} → ${snippetPreview}`;
    }

    return header ? `${header}: ${snippetPreview}` : snippetPreview;
  }

  private hasEvidenceContext(blocks: string[]): boolean {
    const evidencePattern = /\[(?:WORKSPACE|EDITOR)_CONTEXT\]/i;
    return blocks.some((block) => evidencePattern.test(block));
  }

  private shouldEnforceEvidenceGate(reasoningPlan: ReasoningPlan | undefined, contextBlocks: string[]): boolean {
    if (!reasoningPlan) {
      return false;
    }

    const intent = reasoningPlan.intent;
    if (!intent.requiresEditor && !intent.requiresWorkspace) {
      return false;
    }

    return !this.hasEvidenceContext(contextBlocks);
  }

  private pushEvidenceReminder(conversation: AgentMessage[]): void {
    const reminder = 'Self-review: Evidence missing. Call list_files, read_file, or grep before final answer.';
    const last = conversation[conversation.length - 1];
    if (!last || last.role !== 'system' || last.content !== reminder) {
      conversation.push({ role: 'system', content: reminder });
    }
  }

  private async runAgentLoop(
    session: ChatSession,
    systemPrompt: string,
    planSection: string,
    contextBlocks: string[],
    contextSources: { hasEditor: boolean; hasWorkspace: boolean } | undefined,
    conversation: AgentMessage[],
    intents: Set<NormalizedIntent> | undefined,
    reasoningPlan: ReasoningPlan | undefined,
    options?: { allowTools?: boolean }
  ): Promise<AgentLoopResult> {
    const allowTools = options?.allowTools ?? true;
    const workingConversation: AgentMessage[] = [...conversation];
    const workingContextBlocks: string[] = [...contextBlocks];
    let workingContextSources: { hasEditor: boolean; hasWorkspace: boolean } = {
      hasEditor: Boolean(contextSources?.hasEditor),
      hasWorkspace: Boolean(contextSources?.hasWorkspace)
    };
    const toolAttempts = new Map<string, number>();
    let attempts = 0;
    let lastToolFallback: { message: string; call: ToolCall } | undefined;

    while (attempts < 12) {
      attempts++;
      const payload = this.buildPromptPayload(systemPrompt, planSection, workingContextBlocks, workingConversation);

      let stream: StreamResult;
      try {
        stream = await this.startStream(
          session,
          payload,
          workingContextSources,
          intents,
          reasoningPlan,
          { emitToUI: false, keepBusy: true, signalStart: attempts === 1 }
        );
      } catch (error) {
        const err = error instanceof Error ? error.message : String(error);
        workingConversation.push({ role: 'assistant', content: `Tool loop error: ${err}` });
        break;
      }

      const rawAssistant = stream.raw.trim();
      const sanitizedAssistant = stream.sanitized.trim();
      const assistantContent = sanitizedAssistant.length > 0 ? sanitizedAssistant : rawAssistant;
      if (assistantContent.length > 0) {
        workingConversation.push({ role: 'assistant', content: assistantContent });
      }

      const agentResponse = this.parseAgentResponse(rawAssistant);

      if (!agentResponse) {
        const sanitized = stream.sanitized.trim();
        if (sanitized.length > 0) {
          return {
            finalMessage: sanitized,
            conversation: workingConversation,
            contextBlocks: [...workingContextBlocks],
            contextSources: { ...workingContextSources }
          };
        }
        break;
      }

      if (agentResponse.kind === 'message') {
        const trimmedMessage = agentResponse.content.trim();
        if (workingConversation.length > 0 && workingConversation[workingConversation.length - 1].role === 'assistant') {
          workingConversation[workingConversation.length - 1] = {
            role: 'assistant',
            content: trimmedMessage
          };
        } else if (trimmedMessage.length > 0) {
          workingConversation.push({ role: 'assistant', content: trimmedMessage });
        }

        if (toolAttempts.size === 0) {
          if (this.shouldEnforceEvidenceGate(reasoningPlan, workingContextBlocks)) {
            this.pushEvidenceReminder(workingConversation);
            continue;
          }

          if (trimmedMessage.length === 0) {
            continue;
          }

          return {
            finalMessage: trimmedMessage,
            conversation: workingConversation,
            contextBlocks: [...workingContextBlocks],
            contextSources: { ...workingContextSources }
          };
        }

        if (trimmedMessage.length === 0) {
          continue;
        }

        const hasToolContext = workingContextBlocks.length > contextBlocks.length;
        if (!hasToolContext && this.shouldEnforceEvidenceGate(reasoningPlan, workingContextBlocks)) {
          this.pushEvidenceReminder(workingConversation);
          continue;
        }

        if (!hasToolContext) {
          continue;
        }

        return {
          finalMessage: trimmedMessage,
          conversation: workingConversation,
          contextBlocks: [...workingContextBlocks],
          contextSources: { ...workingContextSources }
        };
      }

      if (!allowTools) {
        workingConversation.push({ role: 'system', content: 'Tools are disabled for this turn. Provide the best answer using existing context.' });
        continue;
      }

      const toolKey = `${agentResponse.call.name}:${JSON.stringify(agentResponse.call.args)}`;
      const currentAttempts = (toolAttempts.get(toolKey) ?? 0) + 1;
      toolAttempts.set(toolKey, currentAttempts);

      if (currentAttempts > MAX_TOOL_ATTEMPTS) {
        const fallbackMessage = lastToolFallback?.message ?? this.buildToolFallbackMessage(session, agentResponse.call);
        lastToolFallback = { message: fallbackMessage, call: agentResponse.call };
        return {
          finalMessage: fallbackMessage,
          conversation: workingConversation,
          contextBlocks: [...workingContextBlocks],
          contextSources: { ...workingContextSources }
        };
      }

      this.currentTurnToolCalls.add(agentResponse.call.name);
      this.postTransientStatus(session.id, this.describeToolCall(agentResponse.call));

      if (workingConversation.length > 0 && workingConversation[workingConversation.length - 1].role === 'assistant') {
        workingConversation[workingConversation.length - 1] = {
          role: 'assistant',
          content: this.summarizeToolCall(agentResponse.call.name, agentResponse.call.args)
        };
      } else {
        workingConversation.push({
          role: 'assistant',
          content: this.summarizeToolCall(agentResponse.call.name, agentResponse.call.args)
        });
      }

      const toolResult = await this.executeTool(agentResponse.call, workingContextSources);
      const fallbackForTool =
        toolResult.hasData === false
          ? this.buildNoDataFallbackMessage(session, toolResult)
          : this.buildToolFallbackMessage(session, agentResponse.call, toolResult);
      const toolMessage =
        this.buildToolContextSummary(toolResult) ?? this.formatToolResultMessage(agentResponse.call.name, agentResponse.call.args, toolResult);
      workingConversation.push({
        role: 'tool',
        content: toolMessage
      });
      this.postTransientStatus(session.id, `${this.describeToolCall(agentResponse.call)} ✓`);

      if (toolResult.contextBlock) {
        workingContextBlocks.push(toolResult.contextBlock);
        this.appendWorkspaceContext(session, toolResult.contextBlock, toolResult.workspaceFiles);
        workingContextSources = {
          hasEditor: workingContextSources.hasEditor,
          hasWorkspace: true
        };
      }

      if (!toolResult.success) {
        lastToolFallback = { message: fallbackForTool, call: agentResponse.call };
        if (currentAttempts >= MAX_TOOL_ATTEMPTS) {
          return {
            finalMessage: fallbackForTool,
            conversation: workingConversation,
            contextBlocks: [...workingContextBlocks],
            contextSources: { ...workingContextSources }
          };
        }
        continue;
      }

      if (toolResult.hasData === false) {
        lastToolFallback = { message: fallbackForTool, call: agentResponse.call };
        continue;
      }

      lastToolFallback = undefined;
    }

    return {
      finalMessage: lastToolFallback?.message ?? this.buildGenericFallbackMessage(session),
      conversation: workingConversation,
      contextBlocks: [...workingContextBlocks],
      contextSources: { ...workingContextSources }
    };
  }

  private parseAgentResponse(output: string): AgentResponse | undefined {
    if (!output) {
      return undefined;
    }

    const trimmed = output.trim();
    const candidates = this.extractJsonCandidates(output);
    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as { tool?: unknown; arguments?: unknown };
        const toolName = typeof parsed.tool === 'string' ? parsed.tool : undefined;
        if (toolName && this.isSupportedTool(toolName)) {
          const argsValue = parsed.arguments;
          const toolArgs = argsValue && typeof argsValue === 'object' ? (argsValue as Record<string, unknown>) : {};
          return {
            kind: 'tool',
            call: {
              name: toolName,
              args: toolArgs,
              raw: candidate
            },
            raw: candidate
          };
        }
      } catch {
        // Ignore parse errors and try the next candidate
      }
    }

    return {
      kind: 'message',
      content: trimmed,
      raw: trimmed
    };
  }

  private async executeTool(call: ToolCall, contextSources: { hasEditor: boolean; hasWorkspace: boolean }): Promise<ToolExecutionResult> {
    switch (call.name) {
      case 'list_files':
        return this.executeListFilesTool(call.args);
      case 'read_file':
        return this.executeReadFileTool(call.args, contextSources);
      case 'grep':
        return this.executeGrepTool(call.args);
      default:
        return {
          success: false,
          message: `Unknown tool: ${call.name}`,
          fallbackMessage: "I wasn't able to retrieve that information."
        };
    }
  }

  private extractJsonCandidates(output: string): string[] {
    const matches: string[] = [];
    const toolRegex = /\{"tool":\s*".*?"\s*,\s*"arguments":\s*\{[\s\S]*?\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = toolRegex.exec(output)) !== null) {
      matches.push(match[0]);
    }

    if (matches.length === 0) {
      const trimmed = output.trim();
      if (trimmed.length > 0) {
        matches.push(trimmed);
      }
    }

    return matches;
  }

  private isSupportedTool(name: string): name is ToolCall['name'] {
    return name === 'list_files' || name === 'read_file' || name === 'grep';
  }

  private normalizeToolMessage(message: string, toolName: ToolCall['name']): string {
    const trimmed = (message ?? '').trim();
    if (!trimmed) {
      return `Tool ${toolName} result:\n(no output)`;
    }

    if (trimmed.length <= TOOL_RESULT_CHARACTER_LIMIT) {
      return trimmed;
    }

    const truncated = trimmed.slice(0, TOOL_RESULT_CHARACTER_LIMIT);
    const remaining = trimmed.length - TOOL_RESULT_CHARACTER_LIMIT;
    return `${truncated}\n... (truncated ${remaining} more characters)`;
  }

  private validateResponse(response: string, userQuery: string, toolsUsed: Set<string>): { valid: boolean; errors?: string[] } {
    const trimmed = response.trim();
    if (!trimmed) {
      return { valid: true };
    }

    const errors: string[] = [];
    const referencedFiles = new Set<string>();
    const matches = trimmed.match(FILE_REFERENCE_REGEX) ?? [];
    matches.forEach((match) => referencedFiles.add(match));

    if (/\bcodebase\b/i.test(trimmed) && !toolsUsed.has('list_files')) {
      errors.push('Error: You mentioned the codebase but have not listed files. Call list_files before referencing the codebase.');
    }

    if (referencedFiles.size > 0 && !toolsUsed.has('read_file')) {
      referencedFiles.forEach((file) => {
        errors.push(`Error: You mentioned file ${file} but have not read it. You must call read_file before claiming knowledge of its content.`);
      });
    }

    if (errors.length === 0) {
      return { valid: true };
    }

    return { valid: false, errors };
  }

  public appendWorkspaceContext(session: ChatSession, contextBlock: string, workspaceFiles?: string[]): void {
    const trimmed = contextBlock.trim();
    if (!trimmed) {
      return;
    }

    let mutated = false;

    if (!session.workspaceContext.includes(trimmed)) {
      session.workspaceContext.push(trimmed);
      if (session.workspaceContext.length > MAX_PERSISTED_WORKSPACE_CONTEXT) {
        session.workspaceContext.splice(0, session.workspaceContext.length - MAX_PERSISTED_WORKSPACE_CONTEXT);
      }
      mutated = true;
    }

    if (workspaceFiles && workspaceFiles.length > 0) {
      const seen = new Set(session.workspaceFiles);
      for (const file of workspaceFiles) {
        const normalized = file.trim();
        if (normalized && !seen.has(normalized)) {
          session.workspaceFiles.push(normalized);
          seen.add(normalized);
          mutated = true;
        }
      }
      if (session.workspaceFiles.length > MAX_PERSISTED_WORKSPACE_FILES) {
        session.workspaceFiles = session.workspaceFiles.slice(-MAX_PERSISTED_WORKSPACE_FILES);
      }
    }

    if (mutated) {
      this.sessions.set(session.id, session);
      this.persistSessions();
    }
  }

  private pruneContext(session: ChatSession): void {
    if (session.messages.length <= 10) {
      return;
    }

    const [firstMessage] = session.messages;
    const hasExistingSummary = Boolean(firstMessage && firstMessage.role === 'assistant' && firstMessage.content.startsWith('[Summary]'));
    const baseMessages = hasExistingSummary ? session.messages.slice(1) : session.messages;

    if (baseMessages.length <= 10) {
      return;
    }

    const segment = baseMessages.slice(0, 5);
    if (segment.length === 0) {
      return;
    }

    const summaryContent = this.buildHistoricalSummary(segment, hasExistingSummary ? firstMessage : undefined);
    const summaryTimestamp = segment[segment.length - 1]?.timestamp ?? Date.now();

    const summaryMessage: ChatMessage = {
      role: 'assistant',
      content: summaryContent,
      timestamp: summaryTimestamp
    };

    const remaining = baseMessages.slice(5);
    session.messages = [summaryMessage, ...remaining];
  }

  private buildHistoricalSummary(messages: ChatMessage[], previousSummary?: ChatMessage): string {
    const lines: string[] = [];

    if (previousSummary && previousSummary.content.startsWith('[Summary]')) {
      const priorLines = previousSummary.content
        .split('\n')
        .slice(1)
        .map((line) => line.replace(/^[-•]\s*/, '').trim())
        .filter((line) => line.length > 0);
      const carryOver = priorLines.slice(-5);
      lines.push(...carryOver);
    }

    messages.forEach((message) => {
      const roleLabel = message.role === 'user' ? 'User' : 'Assistant';
      const snippet = this.truncateForSummary(message.content);
      if (snippet.length > 0) {
        lines.push(`${roleLabel}: ${snippet}`);
      }
    });

    const limited = lines.slice(-10);
    const content = limited.map((line) => `- ${line}`).join('\n');
    return `[Summary]\n${content}`;
  }

  private truncateForSummary(content: string): string {
    const singleLine = this.toSingleLine(content);
    const MAX_LENGTH = 160;
    return singleLine.length > MAX_LENGTH ? `${singleLine.slice(0, MAX_LENGTH)}…` : singleLine;
  }

  private extractFileMentions(message: string): string[] {
    if (!message || message.trim().length === 0) {
      return [];
    }

    const matches = message.match(FILE_REFERENCE_REGEX) ?? [];
    const normalized = matches
      .map((match) => match.replace(/^[./\\]+/, ''))
      .map((match) => match.replace(/\\/g, '/').trim())
      .filter((match) => match.length > 0)
      .map((match) => match.toLowerCase());

    return Array.from(new Set(normalized)).slice(0, 10);
  }

  private isGreetingPrompt(message: string): boolean {
    if (!message) {
      return false;
    }

    const normalized = message.trim().toLowerCase();
    if (normalized.length === 0) {
      return false;
    }

    const shortGreetings = ['hi', 'hello', 'hey', 'howdy', 'yo'];
    if (shortGreetings.includes(normalized)) {
      return true;
    }

    const compact = normalized.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const conversationalPrompts = [
      'who are you',
      'what are you',
      'who is this',
      'what is your name',
      'whats your name',
      'whats yr name',
      'tell me about yourself'
    ];

    return conversationalPrompts.some((phrase) => compact === phrase || compact.startsWith(`${phrase}?`));
  }

  private partitionFileHints(
    hints: string[],
    knownFiles: string[]
  ): { highConfidence: string[]; missing: string[] } {
    if (hints.length === 0) {
      return { highConfidence: [], missing: [] };
    }

    const normalizedKnown = new Map<string, string>();
    knownFiles.forEach((file) => {
      const lowered = file.toLowerCase();
      if (!normalizedKnown.has(lowered)) {
        normalizedKnown.set(lowered, file);
      }
    });

    const highConfidence: string[] = [];
    const missing: string[] = [];

    hints.forEach((hint) => {
      if (normalizedKnown.has(hint)) {
        highConfidence.push(normalizedKnown.get(hint) ?? hint);
      } else {
        missing.push(hint);
      }
    });

    return {
      highConfidence,
      missing
    };
  }

  private handleActiveEditorChange(editor: vscode.TextEditor | undefined): void {
    if (!editor) {
      this.editorSymbolContext = undefined;
      return;
    }

    try {
      this.editorSymbolContext = this.buildEditorSymbolContext(editor.document);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      this.log(`Failed to analyze editor symbols: ${err}`, 'warn');
      this.editorSymbolContext = undefined;
    }
  }

  private buildEditorSymbolContext(document: vscode.TextDocument): string | undefined {
    if (document.isClosed || document.isUntitled) {
      return undefined;
    }

    const relativePath = this.getRelativePath(document.uri);
    const maxLines = Math.min(400, document.lineCount);
    const lines: string[] = [];
    for (let index = 0; index < maxLines; index += 1) {
      lines.push(document.lineAt(index).text);
    }

    const exportPattern = /^export\s+(?:default\s+)?(class|function|const|let|var|interface|type|enum)\s+([A-Za-z0-9_$]+)/;
    const namedExportPattern = /^export\s*\{([^}]+)}/;
    const classPattern = /^class\s+([A-Za-z0-9_$]+)/;
    const functionPattern = /^function\s+([A-Za-z0-9_$]+)/;

    const exports = new Set<string>();
    const classes = new Set<string>();
    const functions = new Set<string>();

    lines.forEach((rawLine) => {
      const line = rawLine.trim();
      if (!line) {
        return;
      }

      const exportMatch = exportPattern.exec(line);
      if (exportMatch) {
        exports.add(`${exportMatch[1]} ${exportMatch[2]}`);
        if (exportMatch[1] === 'class') {
          classes.add(exportMatch[2]);
        } else if (exportMatch[1] === 'function') {
          functions.add(exportMatch[2]);
        }
        return;
      }

      const namedExportMatch = namedExportPattern.exec(line);
      if (namedExportMatch) {
        namedExportMatch[1]
          .split(',')
          .map((token) => token.trim())
          .filter((token) => token.length > 0)
          .forEach((token) => exports.add(token));
      }

      const classMatch = classPattern.exec(line);
      if (classMatch) {
        classes.add(classMatch[1]);
      }

      const functionMatch = functionPattern.exec(line);
      if (functionMatch) {
        functions.add(functionMatch[1]);
      }
    });

    const parts: string[] = [];
    const exportList = Array.from(exports).slice(0, 8);
    if (exportList.length > 0) {
      parts.push(`Exports: ${exportList.join(', ')}`);
    }
    const classList = Array.from(classes).slice(0, 8);
    if (classList.length > 0) {
      parts.push(`Classes: ${classList.join(', ')}`);
    }
    const functionList = Array.from(functions).slice(0, 8);
    if (functionList.length > 0) {
      parts.push(`Functions: ${functionList.join(', ')}`);
    }

    if (parts.length === 0) {
      return undefined;
    }

    return `[EDITOR_SYMBOLS]\nFile: ${relativePath}\n${parts.join('\n')}\n[/EDITOR_SYMBOLS]`;
  }

  private describeToolCall(call: ToolCall): string {
    switch (call.name) {
      case 'read_file': {
        const file = typeof call.args.path === 'string' ? call.args.path : '(unknown file)';
        const start = typeof call.args.startLine === 'number' ? call.args.startLine : undefined;
        const end = typeof call.args.endLine === 'number' ? call.args.endLine : undefined;
        const range = start !== undefined && end !== undefined ? ` lines ${start}-${end}` : start !== undefined ? ` from line ${start}` : '';
        return `Reading ${file}${range}`;
      }
      case 'list_files': {
        const scope = typeof call.args.path === 'string' && call.args.path.length > 0 ? call.args.path : '/';
        return `Listing files in ${scope}`;
      }
      case 'grep': {
        const pattern = typeof call.args.pattern === 'string' ? call.args.pattern : '(pattern)';
        const scope = typeof call.args.path === 'string' && call.args.path.length > 0 ? call.args.path : 'workspace';
        return `Searching "${pattern}" in ${scope}`;
      }
      default:
        return `Running ${call.name}`;
    }
  }

  private buildToolFallbackMessage(session: ChatSession, call: ToolCall, result?: ToolExecutionResult): string {
    const descriptor = this.describeFallbackTarget(call);
    const searchedFor = result?.searchedFor ?? descriptor.display;
    const hint = result?.searchedFor ?? descriptor.hint ?? descriptor.display;
    const similarCandidates = result?.similarFiles ?? this.findSimilarWorkspaceFiles(session, hint);
    const suggestions = similarCandidates.slice(0, 5);

    const base = searchedFor ? `I searched for ${searchedFor} but couldn't find it.` : 'I searched but could not find the requested information.';
    const suffix =
      suggestions.length > 0
        ? ` I see these similar files: ${suggestions.join(', ')}. Should I check one of those?`
        : ' Should I try a different path or search?';

    return `${base}${suffix}`;
  }

  private buildGenericFallbackMessage(session: ChatSession): string {
    const suggestions = this.findSimilarWorkspaceFiles(session);
    if (suggestions.length > 0) {
      return `I searched the workspace but couldn't find what you asked for. I do see these files: ${suggestions.join(', ')}. Let me know if any of them look right, or share another path and I'll check.`;
    }
    return 'I searched the workspace but could not find the requested information. Could you share a different filename or more details?';
  }

  private buildNoDataFallbackMessage(session: ChatSession, result?: ToolExecutionResult): string {
    const candidates: string[] = [];
    if (result?.workspaceFiles && result.workspaceFiles.length > 0) {
      candidates.push(...result.workspaceFiles);
    }
    if (result?.similarFiles && result.similarFiles.length > 0) {
      candidates.push(...result.similarFiles);
    }

    if (candidates.length === 0) {
      candidates.push(...this.findSimilarWorkspaceFiles(session));
    }

    const unique = Array.from(new Set(candidates)).slice(0, 5);
    const list = unique.length > 0 ? unique.join(', ') : '(none yet)';
    return `I couldn't find a direct match. Here are the files I CAN see: ${list}. Should I try reading one of those?`;
  }

  private describeFallbackTarget(call: ToolCall): { display: string; hint?: string } {
    switch (call.name) {
      case 'list_files': {
        const rawPath = typeof call.args.path === 'string' ? call.args.path.trim() : '';
        if (!rawPath) {
          return { display: 'the workspace root' };
        }
        return { display: `files in "${rawPath}"`, hint: rawPath };
      }
      case 'read_file': {
        const rawPath = typeof call.args.path === 'string' ? call.args.path.trim() : '';
        if (!rawPath) {
          return { display: 'the requested file' };
        }
        return { display: `"${rawPath}"`, hint: rawPath };
      }
      case 'grep': {
        const pattern = typeof call.args.pattern === 'string' ? call.args.pattern.trim() : '';
        if (!pattern) {
          return { display: 'the requested pattern' };
        }
        return { display: `matches for "${pattern}"`, hint: pattern };
      }
      default:
        return { display: 'the requested resource' };
    }
  }

  private findSimilarWorkspaceFiles(session: ChatSession, hint?: string, limit = 5): string[] {
    const uniqueFiles = Array.from(new Set(session.workspaceFiles ?? []));
    if (uniqueFiles.length === 0) {
      return [];
    }

    if (!hint) {
      return uniqueFiles.slice(-limit);
    }

    const sanitizedHint = hint.replace(/"/g, '').replace(/files in\s+/i, '').trim();
    if (!sanitizedHint) {
      return uniqueFiles.slice(-limit);
    }

    const normalizedHint = sanitizedHint.toLowerCase();
    const directMatches = uniqueFiles.filter((file) => file.toLowerCase().includes(normalizedHint));

    if (directMatches.length >= limit) {
      return directMatches.slice(0, limit);
    }

    const basenameHint = path.basename(sanitizedHint).toLowerCase();
    const basenameMatches = basenameHint && basenameHint !== '.' && basenameHint !== '..'
      ? uniqueFiles.filter((file) => file.toLowerCase().includes(basenameHint))
      : [];

    const fallback = uniqueFiles.slice(-limit);
    const merged = [...directMatches, ...basenameMatches, ...fallback];
    const deduped: string[] = [];
    for (const file of merged) {
      if (!deduped.includes(file)) {
        deduped.push(file);
      }
      if (deduped.length >= limit) {
        break;
      }
    }

    return deduped.slice(0, limit);
  }

  private async executeListFilesTool(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const folder = this.ensureWorkspaceFolder();
    if (!folder) {
      return {
        success: false,
        message: 'Workspace folder not available.',
        fallbackMessage: "I wasn't able to retrieve that information."
      };
    }

    const relativePath = typeof args.path === 'string' ? args.path.trim() : '';
    const targetUri = relativePath
      ? vscode.Uri.joinPath(folder.uri, relativePath.replace(/^[\\/]+/, ''))
      : folder.uri;

    try {
      const entries = await vscode.workspace.fs.readDirectory(targetUri);
      const visibleEntries = entries.filter(([name]) => !name.startsWith('.')).slice(0, 200);
      const workspaceFiles = visibleEntries.map(([name]) => {
        const fileUri = vscode.Uri.joinPath(targetUri, name);
        return path.relative(folder.uri.fsPath, fileUri.fsPath).replace(/\\/g, '/');
      });

      const lines = visibleEntries.map(([name, fileType]) => {
        const kind = fileType === vscode.FileType.Directory ? 'dir' : 'file';
        const relative = path.relative(folder.uri.fsPath, vscode.Uri.joinPath(targetUri, name).fsPath).replace(/\\/g, '/');
        return `- (${kind}) ${relative}`;
      });

      const hasData = workspaceFiles.length > 0;
      const contextBlock = hasData
        ? `[WORKSPACE_CONTEXT]\nlist_files${relativePath ? `(${relativePath})` : ''}\n---\n${lines.join('\n')}\n[/WORKSPACE_CONTEXT]`
        : undefined;

      const previewEntries = lines
        .map((line) => line.replace(/^- \((dir|file)\) /, ''))
        .slice(0, 3);
      const previewList = previewEntries.join(', ');
      const previewSuffix = workspaceFiles.length > previewEntries.length ? ', …' : '';
      const previewText = previewList ? ` (${previewList}${previewSuffix})` : '';

      return {
        success: true,
        message: hasData ? `Tool list_files result:\n${lines.join('\n')}` : 'Tool list_files result:\nNo entries found.',
        contextBlock,
        hasData,
        fallbackMessage: hasData ? undefined : 'I could not find any files at that location.',
        workspaceFiles: workspaceFiles,
        summary: hasData
          ? `list_files${relativePath ? `(${relativePath})` : ''}: ${workspaceFiles.length} entr${workspaceFiles.length === 1 ? 'y' : 'ies'}${previewText}`
          : `list_files${relativePath ? `(${relativePath})` : ''}: no entries`
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        message: `Tool list_files failed: ${err.message}`,
        fallbackMessage: "I wasn't able to retrieve that information.",
        summary: `list_files error: ${err.message}`
      };
    }
  }

  private async executeGrepTool(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const folder = this.ensureWorkspaceFolder();
    if (!folder) {
      return {
        success: false,
        message: 'Workspace folder not available.',
        fallbackMessage: "I wasn't able to retrieve that information."
      };
    }

    const patternValue = typeof args.pattern === 'string' ? args.pattern.trim() : '';
    if (!patternValue) {
      return {
        success: false,
        message: 'Tool grep requires a "pattern" argument.',
        fallbackMessage: "I wasn't able to retrieve that information."
      };
    }

    const relativePathArg = typeof args.path === 'string' ? args.path.trim() : '';
    const caseSensitive = typeof args.caseSensitive === 'boolean' ? args.caseSensitive : false;
    const useRegex = typeof args.useRegex === 'boolean' ? args.useRegex : false;

    let regex: RegExp;
    try {
      const source = useRegex ? patternValue : this.escapeRegex(patternValue);
      const flags = caseSensitive ? 'm' : 'im';
      regex = new RegExp(source, flags);
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Tool grep failed: invalid pattern (${err}).`,
        fallbackMessage: "I wasn't able to retrieve that information."
      };
    }

    const normalizedPath = relativePathArg.replace(/^[\\/]+/, '').replace(/\\/g, '/');
    let targetUris: vscode.Uri[] = [];

    try {
      if (normalizedPath) {
        const targetUri = vscode.Uri.joinPath(folder.uri, normalizedPath);
        let stat: vscode.FileStat | undefined;
        try {
          stat = await vscode.workspace.fs.stat(targetUri);
        } catch {
          stat = undefined;
        }
        if (!stat) {
          return {
            success: false,
            message: `Tool grep failed: path "${normalizedPath}" not found.`,
            fallbackMessage: "I wasn't able to retrieve that information."
          };
        }

        if (stat.type === vscode.FileType.Directory) {
          const include = new vscode.RelativePattern(folder, `${normalizedPath}/**/*`);
          targetUris = await vscode.workspace.findFiles(include, '**/{node_modules,.git,.vscode,out,dist,build}/**', 200);
        } else {
          targetUris = [targetUri];
        }
      } else {
        const include = new vscode.RelativePattern(folder, '**/*');
        targetUris = await vscode.workspace.findFiles(include, '**/{node_modules,.git,.vscode,out,dist,build}/**', 200);
      }
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Tool grep failed to enumerate files: ${err}`,
        fallbackMessage: "I wasn't able to retrieve that information."
      };
    }

    if (targetUris.length === 0) {
      return {
        success: true,
        message: 'Tool grep result:\nNo matches found.',
        hasData: false,
        fallbackMessage: 'No matches were found for that pattern.',
        summary: `grep("${patternValue}"): no matches`
      };
    }

    const results: string[] = [];
    const matchedFiles = new Set<string>();

    for (const uri of targetUris) {
      if (results.length >= MAX_GREP_RESULTS) {
        break;
      }

      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(uri);
      } catch {
        continue;
      }

      const text = document.getText();
      if (!text || text.includes('\u0000')) {
        continue;
      }

      const lines = text.split(/\r?\n/);
      const relativeFile = this.getRelativePath(uri);

      for (let i = 0; i < lines.length; i++) {
        if (results.length >= MAX_GREP_RESULTS) {
          break;
        }

        const line = lines[i];
        if (!regex.test(line)) {
          continue;
        }

        const trimmedLine = line.length > 240 ? `${line.slice(0, 240)}…` : line;
        results.push(`File: ${relativeFile} (line ${i + 1})\n${trimmedLine.trimEnd()}`);
        matchedFiles.add(relativeFile.replace(/\\/g, '/'));
      }
    }

    if (results.length === 0) {
      return {
        success: true,
        message: 'Tool grep result:\nNo matches found.',
        hasData: false,
        fallbackMessage: 'No matches were found for that pattern.',
        summary: `grep("${patternValue}"): no matches`
      };
    }

    if (results.length > MAX_GREP_RESULTS) {
      results.length = MAX_GREP_RESULTS;
    }

    const formatted = results.join('\n\n');
    return {
      success: true,
      message: `Tool grep result:\n${formatted}`,
      contextBlock: `[WORKSPACE_CONTEXT]\nGrep results:\n---\n${formatted}\n[/WORKSPACE_CONTEXT]`,
      hasData: true,
      workspaceFiles: Array.from(matchedFiles),
      summary: `grep("${patternValue}"${normalizedPath ? ` in ${normalizedPath}` : ''}): ${results.length} hit${
        results.length === 1 ? '' : 's'
      } across ${matchedFiles.size} file${matchedFiles.size === 1 ? '' : 's'}`
    };
  }

  private async executeReadFileTool(
    args: Record<string, unknown>,
    contextSources: { hasEditor: boolean; hasWorkspace: boolean }
  ): Promise<ToolExecutionResult> {
    const folder = this.ensureWorkspaceFolder();
    if (!folder) {
      return {
        success: false,
        message: 'Workspace folder not available.',
        fallbackMessage: "I wasn't able to retrieve that information."
      };
    }

    const relativePath = typeof args.path === 'string' ? args.path.trim() : '';
    if (!relativePath) {
      return {
        success: false,
        message: 'Tool read_file requires a "path" argument.',
        fallbackMessage: "I wasn't able to retrieve that information.",
        summary: 'read_file error: missing path argument'
      };
    }

    const startLine = typeof args.startLine === 'number' ? Math.max(1, Math.floor(args.startLine)) : undefined;
    const endLine = typeof args.endLine === 'number' ? Math.max(1, Math.floor(args.endLine)) : undefined;

    try {
      const targetUri = vscode.Uri.joinPath(folder.uri, relativePath.replace(/^[\\/]+/, ''));
      const document = await vscode.workspace.openTextDocument(targetUri);
      const lines = document.getText().split(/\r?\n/);

      const start = startLine ? Math.min(startLine, lines.length) : 1;
      const end = endLine ? Math.min(endLine, lines.length) : Math.min(lines.length, start + MAX_TOOL_RESULT_LINES - 1);

      const excerpt = lines.slice(start - 1, end).join('\n');
      const lineInfo = start === end ? `Line ${start}` : `Lines ${start}-${end}`;
      const hasData = excerpt.trim().length > 0;
      const contextBlock = hasData
        ? `[WORKSPACE_CONTEXT]\nFile: ${path.relative(folder.uri.fsPath, targetUri.fsPath).replace(/\\/g, '/')}\n${lineInfo}\n---\n${excerpt}\n[/WORKSPACE_CONTEXT]`
        : undefined;

      return {
        success: true,
        message: `Tool read_file result (${lineInfo}):\n${excerpt}`,
        contextBlock,
        hasData,
        fallbackMessage: hasData ? undefined : 'The requested file region is empty.',
        workspaceFiles: [path.relative(folder.uri.fsPath, targetUri.fsPath).replace(/\\/g, '/')],
        summary: hasData
          ? `read_file ${relativePath} (${lineInfo})`
          : `read_file ${relativePath} (${lineInfo}): empty`
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      return {
        success: false,
        message: `Tool read_file failed: ${err.message}`,
        fallbackMessage: "I don't have that information in the current context.",
        summary: `read_file error: ${err.message}`
      };
    }
  }

  private buildNaturalLanguageGuidance(intents?: Set<NormalizedIntent>): string {
    const guidance: string[] = [
      '- You may interpret idioms, urgency cues, and emotional expressions to clarify the user’s conversational intent.',
      '- Never infer code behavior, file contents, or workspace facts beyond the provided context.'
    ];

    if (!intents || intents.size === 0) {
      return guidance.join('\n');
    }

    if (intents.has('INTENT_EMERGENCY')) {
      guidance.push('- When urgency or emergency language is present, acknowledge it calmly, avoid literal clarification questions, and never execute actions automatically.');
    }

    if (intents.has('INTENT_FRUSTRATION')) {
      guidance.push('- When the user sounds frustrated, respond steadily and help de-escalate while staying concise.');
    }

    if (intents.has('INTENT_REFLECTION')) {
      guidance.push('- If the user uses reflective idioms, you can briefly acknowledge before moving to the actionable portion of the request.');
    }

    return guidance.join('\n');
  }

  private buildReasoningActionSummary(plan?: ReasoningPlan): string {
    if (!plan) {
      return 'Operate in PLAN → ACT → VERIFY. Use tools first, respond only after verifying the answer.';
    }

    const rationale = plan.decision.rationale?.trim();
    const reminders: string[] = [];
    if (plan.intent.requiresEditor) {
      reminders.push('Fetch the necessary editor code via read_file before forming conclusions.');
    }
    if (plan.intent.requiresWorkspace) {
      reminders.push('Discover missing workspace details with list_files, grep, and read_file.');
    }

    const summaryParts = [rationale, ...reminders].filter((part) => !!part && part.trim().length > 0);
    if (summaryParts.length === 0) {
      summaryParts.push('Call tools immediately to gather the needed context, then verify before answering.');
    }

    return summaryParts.join(' ');
  }

  private determineAuthority(hasEditor: boolean, hasWorkspace: boolean): AuthorityLevel {
    if (hasEditor && hasWorkspace) {
      return 'EDITOR_AND_WORKSPACE';
    }
    if (hasEditor) {
      return 'EDITOR';
    }
    if (hasWorkspace) {
      return 'WORKSPACE';
    }
    return 'NONE';
  }

  private interpretIntent(message: string): IntentInterpretation {
    const normalized = message.trim().toLowerCase();
    const detectedPhrases = new Set<string>();

    const editMatches = this.matchKeywords(normalized, EDIT_KEYWORDS);
    editMatches.forEach((phrase) => detectedPhrases.add(phrase));

    const describeMatches = this.matchKeywords(normalized, DESCRIBE_KEYWORDS);
    describeMatches.forEach((phrase) => detectedPhrases.add(phrase));

    const readMatches = this.matchKeywords(normalized, READ_KEYWORDS);
    readMatches.forEach((phrase) => detectedPhrases.add(phrase));

    const pointerMatches = this.matchKeywords(normalized, POINTER_TERMS);
    pointerMatches.forEach((phrase) => detectedPhrases.add(phrase));

    const workspaceMatches = this.matchKeywords(normalized, WORKSPACE_TERMS);
    workspaceMatches.forEach((phrase) => detectedPhrases.add(phrase));

    let kind: IntentInterpretation['kind'] = 'QUESTION';
    if (editMatches.length > 0) {
      kind = 'EDIT';
    } else if (describeMatches.length > 0) {
      kind = 'DESCRIBE';
    } else if (readMatches.length > 0) {
      kind = 'READ';
    }

    const requiresEditor = kind === 'EDIT' || pointerMatches.length > 0;
    const requiresWorkspace = workspaceMatches.length > 0 && !requiresEditor;

    return {
      kind,
      requiresEditor,
      requiresWorkspace,
      detectedPhrases: Array.from(detectedPhrases)
    };
  }

  private decideAction(authority: AuthorityLevel, intent: IntentInterpretation): ActionDecision {
    const hasEditorAuthority = authority === 'EDITOR' || authority === 'EDITOR_AND_WORKSPACE';
    const hasWorkspaceAuthority = authority === 'WORKSPACE' || authority === 'EDITOR_AND_WORKSPACE';
    const rationaleParts: string[] = [];

    if (intent.requiresEditor && !hasEditorAuthority) {
      rationaleParts.push('Intent references editor content that is not visible. Use read_file to fetch the necessary code immediately.');
    }

    if (intent.requiresWorkspace && !hasWorkspaceAuthority) {
      rationaleParts.push('Intent depends on workspace context. Escalate with list_files, grep, and read_file until the data is gathered.');
    }

    if (hasEditorAuthority) {
      rationaleParts.push('Editor context supplied.');
      if (intent.kind === 'EDIT') {
        rationaleParts.push('Editing stays scoped to the visible selection or fetched excerpts.');
      } else {
        rationaleParts.push('You may read or describe the visible editor content.');
      }
    } else {
      rationaleParts.push('Editor context missing; rely on tool reads for specifics.');
    }

    if (hasWorkspaceAuthority) {
      rationaleParts.push('Workspace context already gathered; build on it with further tool calls if needed.');
    } else {
      rationaleParts.push('Workspace discovery is pending; call list_files, grep, and read_file to obtain details.');
    }

    return {
      rationale: rationaleParts.join(' ')
    };
  }

  private buildContextualNotes(
    authority: AuthorityLevel,
    intent: IntentInterpretation,
    hasEditor: boolean,
    hasWorkspace: boolean
  ): string[] {
    const notes: string[] = [];
    notes.push(hasEditor ? 'Editor context supplied for this turn.' : 'Editor context pending discovery via tools.');
    notes.push(hasWorkspace ? 'Workspace context supplied for this turn.' : 'Workspace context pending discovery via tools.');

    if (intent.requiresEditor && !hasEditor) {
      notes.push('Intent targets editor code. Plan to fetch the file content with read_file.');
    }

    if (intent.requiresWorkspace && !hasWorkspace) {
      notes.push('Intent targets workspace code. Discover the relevant files using list_files and grep.');
    }

    return notes;
  }

  private formatReasoningPlan(plan: ReasoningPlan): string {
    const detected = plan.intent.detectedPhrases.length > 0 ? plan.intent.detectedPhrases.join(', ') : 'None';
    const contextualLines = plan.contextualNotes.length > 0
      ? plan.contextualNotes.map((note) => `  - ${note}`)
      : ['  - No additional context notes.'];

    const lines: string[] = [
      '[PLAN]',
      `- Intent kind: ${plan.intent.kind}`,
      `- Requires editor: ${plan.intent.requiresEditor ? 'Yes' : 'No'}`,
      `- Requires workspace: ${plan.intent.requiresWorkspace ? 'Yes' : 'No'}`,
      `- Detected phrases: ${detected}`,
      '',
      '[ACT]',
      ...contextualLines,
      '  - Tool strategy: ' + (plan.decision.rationale || 'Call discovery tools immediately.'),
      '',
      '[VERIFY]',
      '- Confirm gathered snippets answer the question before drafting the reply.'
    ];

    return lines.join('\n');
  }

  private stripReasoningPlanContent(input: string): string {
    return input.replace(/\[REASONING_PLAN\][\s\S]*?\[\/REASONING_PLAN\]\n?/gi, '').trim();
  }

  private evaluateReasoningPlan(_plan: ReasoningPlan): { refuse: boolean; message: string } | undefined {
    return undefined;
  }

  private matchKeywords(normalizedMessage: string, keywords: string[]): string[] {
    const matches: string[] = [];
    for (const keyword of keywords) {
      const lowered = keyword.toLowerCase();
      if (lowered.includes(' ')) {
        if (normalizedMessage.includes(lowered)) {
          matches.push(keyword);
        }
      } else {
        const pattern = new RegExp(`\\b${this.escapeRegex(lowered)}\\b`, 'i');
        if (pattern.test(normalizedMessage)) {
          matches.push(keyword);
        }
      }
    }
    return matches;
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private handleStreamError(cts: vscode.CancellationTokenSource, error: unknown): void {
    const state = this.streamState;
    if (!state || state.cts !== cts) {
      return;
    }

    const err = error instanceof Error ? error : new Error(String(error));

    if (!state.emitToUI) {
      state.reject?.(err);
      this.finishStream(cts, state.keepBusy);
      return;
    }

    this.log(`Ollama error: ${err.message}`, 'error');
    this.postMessage({ type: 'chatError', sessionId: state.sessionId, message: err.message });
    state.reject?.(err);
    this.finishStream(cts, state.keepBusy);
  }

  private finishStream(cts: vscode.CancellationTokenSource, keepBusy?: boolean): void {
    if (!this.streamState || this.streamState.cts !== cts) {
      return;
    }

    const sessionId = this.streamState.sessionId;
    cts.dispose();
    this.streamState = undefined;
    if (!keepBusy) {
      this.postStatus('idle', sessionId);
    }
  }

  private cancelStream(reason: string, notify: boolean, sessionId?: string): void {
    const state = this.streamState;
    if (!state) {
      return;
    }

    if (sessionId && state.sessionId !== sessionId) {
      return;
    }

    if (!state.cts.token.isCancellationRequested) {
      state.cts.cancel();
    }

    if (notify) {
      this.log(reason, 'warn');
      this.postMessage({ type: 'chatError', sessionId: state.sessionId, message: reason });
      this.postMessage({ type: 'chatStreamCompleted', sessionId: state.sessionId });
    } else {
      this.log(reason, 'info');
    }

    this.finishStream(state.cts);
  }

  private addMessage(sessionId: string, message: ChatMessage): void {
    const session = this.getOrCreateSession(sessionId);
    session.messages.push(message);
    if (session.messages.length > MAX_HISTORY) {
      session.messages.splice(0, session.messages.length - MAX_HISTORY);
    }
    this.pruneContext(session);
    session.updatedAt = message.timestamp;
    if (message.role === 'user' && (session.title === DEFAULT_SESSION_TITLE || session.title.trim().length === 0)) {
      session.title = this.deriveTitleFromContent(message.content, session.createdAt);
    }
    this.sessions.set(session.id, session);
    this.persistSessions();
    this.postSessions();
  }

  private postInitialState(): void {
    this.postMessage({
      type: 'init',
      sessions: this.serializeSessions(),
      activeSessionId: this.activeSessionId,
      logs: [...this.logs],
      version: this.version,
      stream: this.streamState ? { state: 'busy', sessionId: this.streamState.sessionId } : undefined
    });

    if (this.streamState) {
      this.postStatus('busy', this.streamState.sessionId);
    }
  }

  private postSessions(): void {
    this.postMessage({
      type: 'sessions',
      sessions: this.serializeSessions(),
      activeSessionId: this.activeSessionId
    });
  }

  private postStatus(state: 'busy' | 'idle', sessionId: string, message?: string): void {
    this.postMessage({
      type: 'status',
      state,
      sessionId,
      message
    });
  }

  private postTransientStatus(sessionId: string, message: string): void {
    this.postMessage({
      type: 'statusUpdate',
      sessionId,
      message,
      timestamp: Date.now()
    });
  }

  private toSingleLine(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private postMessage(message: unknown): void {
    void this.webviewView?.webview.postMessage(message);
  }

  private createSession(title?: string): ChatSession {
    const id = this.generateSessionId();
    const now = Date.now();
    return {
      id,
      title: this.normalizeTitle(title) ?? DEFAULT_SESSION_TITLE,
      messages: [],
      createdAt: now,
      updatedAt: now,
      workspaceContext: [],
      workspaceFiles: []
    };
  }

  private handleNewSession(title?: string): void {
    this.cancelStream('Switching sessions.', false);
    const session = this.createSession(title);
    this.sessions.set(session.id, session);
    this.activeSessionId = session.id;
    this.persistSessions();
    this.persistActiveSession();
    this.postSessions();
  }

  private handleSwitchSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      return;
    }

    this.cancelStream('Switching sessions.', false, sessionId);
    this.activeSessionId = sessionId;
    this.persistActiveSession();
    this.postSessions();
  }

  private handleRenameSession(sessionId: string, title: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.title = this.normalizeTitle(title) ?? DEFAULT_SESSION_TITLE;
    session.updatedAt = Date.now();
    this.sessions.set(session.id, session);
    this.persistSessions();
    this.postSessions();
  }

  private handleDeleteSession(sessionId: string): void {
    if (!this.sessions.delete(sessionId)) {
      return;
    }

    if (this.streamState && this.streamState.sessionId === sessionId) {
      this.cancelStream('Session deleted.', false, sessionId);
    }

    if (this.activeSessionId === sessionId) {
      const nextId = this.sessions.keys().next().value as string | undefined;
      if (nextId) {
        this.activeSessionId = nextId;
      } else {
        const session = this.createSession();
        this.sessions.set(session.id, session);
        this.activeSessionId = session.id;
      }
      this.persistActiveSession();
    }

    this.persistSessions();
    this.postSessions();
  }

  private getOrCreateSession(sessionId: string): ChatSession {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const session = this.createSession();
    this.sessions.set(session.id, session);
    this.persistSessions();
    return session;
  }

  private ensureWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      const warning = 'Titan Forge AI requires an open workspace folder for file operations.';
      vscode.window.showWarningMessage(warning);
      this.log(warning, 'warn');
      this.postMessage({ type: 'workspace' });
      return undefined;
    }
    return folders[0];
  }

  private getRelativePath(uri: vscode.Uri): string {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (workspaceFolder) {
      return vscode.workspace.asRelativePath(uri, false);
    }
    return uri.fsPath;
  }

  private bufferToString(buffer: Uint8Array): string {
    return new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }

  private truncateContent(content: string, maxLength: number): string {
    if (content.length <= maxLength) {
      return content;
    }
    return `${content.slice(0, maxLength)}\n\n... (truncated, ${content.length - maxLength} more characters)`;
  }

  private handleCommandError(action: string, error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    const message = `Failed to ${action}: ${err.message}`;
    this.log(message, 'error');
    vscode.window.showErrorMessage(`Titan Forge AI: ${message}`);
  }

  private persistLogs(): void {
    void this.context.workspaceState.update(LOG_STORAGE_KEY, [...this.logs]);
  }

  private persistSessions(): void {
    const serialized = this.serializeSessions();
    void this.context.workspaceState.update(SESSIONS_STORAGE_KEY, serialized);
  }

  private persistActiveSession(): void {
    void this.context.workspaceState.update(ACTIVE_SESSION_STORAGE_KEY, this.activeSessionId);
  }

  private serializeSessions(): SerializedSession[] {
    return Array.from(this.sessions.values()).map((session) => ({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages.slice(-MAX_HISTORY),
      workspaceContext: session.workspaceContext.slice(-MAX_PERSISTED_WORKSPACE_CONTEXT)
    }));
  }

  private hydrateSession(raw: SerializedSession): ChatSession {
    return {
      id: raw.id,
      title: this.normalizeTitle(raw.title) ?? DEFAULT_SESSION_TITLE,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
      messages: Array.isArray(raw.messages)
        ? raw.messages.slice(-MAX_HISTORY).map((message) => ({
            role: message.role === 'assistant' ? 'assistant' : 'user',
            content: typeof message.content === 'string' ? message.content : '',
            timestamp: typeof message.timestamp === 'number' ? message.timestamp : Date.now()
          }))
        : [],
      workspaceContext: Array.isArray(raw.workspaceContext)
        ? raw.workspaceContext.slice(-MAX_PERSISTED_WORKSPACE_CONTEXT)
        : [],
      workspaceFiles: Array.isArray(raw.workspaceFiles)
        ? raw.workspaceFiles.slice(0, MAX_PERSISTED_WORKSPACE_FILES)
        : []
    };
  }

  private generateSessionId(): string {
    return `session-${Math.random().toString(36).slice(2, 11)}`;
  }

  private deriveTitleFromContent(content: string, createdAt: number): string {
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      return DEFAULT_SESSION_TITLE;
    }

    const firstLine = trimmed.split(/\r?\n/)[0];
    const normalized = firstLine.replace(/[^\p{L}\p{N}\s]/gu, '').trim();
    if (normalized.length >= 4) {
      return normalized.slice(0, 60);
    }

    const date = new Date(createdAt);
    return `Chat ${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  }

  private normalizeTitle(input: string | undefined): string | undefined {
    if (typeof input !== 'string') {
      return undefined;
    }

    const title = input.trim();
    return title.length > 0 ? title.slice(0, 80) : undefined;
  }
}
