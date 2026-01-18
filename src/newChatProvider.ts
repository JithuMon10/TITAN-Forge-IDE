import * as vscode from 'vscode';
import { languageClient } from './language_client';
import { GetCompletionsRequest, Document, Metadata } from '@/gen/src/proto/language_server_pb';

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
}

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'send'; sessionId: string; content: string }
  | { type: 'cancel' }
  | { type: 'newSession'; title?: string }
  | { type: 'switchSession'; sessionId: string }
  | { type: 'clearSession' };

const DEFAULT_SESSION_TITLE = 'Chat';
const DEFAULT_SESSION_ID = 'session-0';

export class NewChatProvider implements vscode.Disposable {
  private webviewView?: vscode.WebviewView;
  private readonly sessions = new Map<string, ChatSession>();
  private activeSessionId: string;
  private cancellationTokenSource: vscode.CancellationTokenSource | undefined;

  constructor() {
    this.activeSessionId = DEFAULT_SESSION_ID;
    const session = this.createSession(DEFAULT_SESSION_ID, DEFAULT_SESSION_TITLE);
    this.sessions.set(session.id, session);
  }

  dispose(): void {
    this.cancellationTokenSource?.cancel();
    this.cancellationTokenSource?.dispose();
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

  public log(message: string, level: LogLevel = 'info'): void {
    console.log(`[Titan Forge][${level.toUpperCase()}] ${message}`);
  }

  public async handleReadFileCommand(): Promise<void> {
    this.log('handleReadFileCommand not implemented', 'warn');
  }

  public async handleEditFileCommand(): Promise<void> {
    this.log('handleEditFileCommand not implemented', 'warn');
  }

  public async handleSaveActiveEditor(): Promise<void> {
    this.log('handleSaveActiveEditor not implemented', 'warn');
  }

  private handleCancel(): void {
    this.cancellationTokenSource?.cancel();
    this.cancellationTokenSource = undefined;
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
    if (this.sessions.has(sessionId)) {
      this.activeSessionId = sessionId;
      this.postSessions('sessions');
    }
  }

  private handleClearSession(): void {
    const session = this.sessions.get(this.activeSessionId);
    if (session) {
      session.messages = [];
      this.postSessions('sessions');
    }
  }

  private async handleSendMessage(sessionId: string, content: string): Promise<void> {
    const session = this.ensureSession(sessionId);
    const userMessage: ChatMessage = { role: 'user', content, timestamp: Date.now() };
    session.messages.push(userMessage);
    this.activeSessionId = session.id;
    this.postSessions('sessions');
    this.postStatus('thinking');

    try {
      const editor = vscode.window.activeTextEditor;
      const document = new Document({
        text: editor?.document.getText() || '',
        cursorOffset: editor ? BigInt(editor.document.offsetAt(editor.selection.active)) : BigInt(0),
        editorLanguage: editor?.document.languageId || '',
      });

      const request = new GetCompletionsRequest({
        document,
        metadata: new Metadata({ ideName: 'vscode' })
      });

      this.postStatus('processing');
      const response = await languageClient.getCompletions(request);

      // For now, we just join the completion IDs as a placeholder response.
      const assistantReply = response.completionItems.map(item => item.completion?.completionId ?? '').join('\n');

      const finalMessage: ChatMessage = { role: 'assistant', content: assistantReply || 'I did not receive a response from the model.', timestamp: Date.now() };
      session.messages.push(finalMessage);
      this.postSessions('sessions');
      this.postChatMessage('assistant', finalMessage.content);

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.log(`Message handling failed: ${err.message}`, 'error');
      this.postChatError(err.message);
    } finally {
      this.postStatus('idle');
    }
  }

  private createSession(id: string, title: string): ChatSession {
    return { id, title, messages: [] };
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
      sessions: Array.from(this.sessions.values()),
      activeSessionId: this.activeSessionId,
    };
    this.postToWebview(kind, payload);
  }

  private postChatMessage(role: 'user' | 'assistant', content: string): void {
    this.postToWebview('chatMessage', { role, content });
  }

  private postChatError(message: string): void {
    this.postToWebview('chatError', { message });
  }

  private postStatus(status: 'idle' | 'thinking' | 'processing' | 'error', message?: string): void {
    this.postToWebview('status', { status, message });
  }

  private postToWebview(type: string, payload: object): void {
    this.webviewView?.webview.postMessage({ type, ...payload });
  }
}
