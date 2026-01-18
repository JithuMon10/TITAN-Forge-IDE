import * as vscode from 'vscode';
import * as path from 'path';
import { ChatProvider } from './chatProvider';

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'titanForgeSidebar';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly chatProvider: ChatProvider,
    private readonly version: string
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const mediaRoot = vscode.Uri.file(path.join(this.extensionUri.fsPath, 'media'));
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot]
    };

    try {
      webviewView.webview.html = this.buildHtml(webviewView.webview);
      this.chatProvider.attachWebview(webviewView);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      webviewView.webview.html = this.getFallbackHtml(err);
      this.chatProvider.log(`Failed to initialize sidebar: ${err.message}`, 'error');
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = this.getNonce();
    const versionLabel = this.escapeHtml(this.version);
    const scriptContent = this.getWebviewScript();

    return `<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Titan Forge AI</title>
          <style>
            :root {
              color-scheme: light dark;
            }

            html,
            body {
              height: 100%;
            }

            body {
              margin: 0;
              font-family: "Segoe UI", sans-serif;
              color: var(--vscode-foreground);
              background: var(--vscode-sideBar-background);
              display: flex;
            }

            .app {
              display: flex;
              flex-direction: column;
              width: 100%;
              height: 100%;
            }

            header.header {
              padding: 16px;
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 12px;
            }

            .header-title {
              display: flex;
              flex-direction: column;
              gap: 4px;
            }

            .header-title h1 {
              margin: 0;
              font-size: 16px;
              font-weight: 600;
            }

            .header-subtitle {
              margin: 0;
              font-size: 12px;
              color: var(--vscode-descriptionForeground);
            }

            .header-actions {
              display: flex;
              gap: 8px;
              align-items: center;
            }

            .divider {
              height: 1px;
              background: var(--vscode-border);
              opacity: 0.6;
              margin: 0 16px;
            }

            .chat-area {
              flex: 1;
              overflow-y: auto;
              padding: 16px;
              display: flex;
              flex-direction: column;
              gap: 12px;
              scroll-behavior: smooth;
            }

            .message {
              display: flex;
              width: 100%;
            }

            .message.assistant {
              justify-content: flex-start;
            }

            .message.user {
              justify-content: flex-end;
            }

            .bubble {
              max-width: 92%;
              padding: 12px 14px;
              border-radius: 12px;
              border: 1px solid var(--vscode-border);
              line-height: 1.5;
              background: var(--vscode-editor-background);
              box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
              overflow-wrap: break-word;
              white-space: pre-wrap;
            }

            .message.user .bubble {
              background: color-mix(in srgb, var(--vscode-textLink-foreground) 18%, var(--vscode-sideBar-background));
              border-color: color-mix(in srgb, var(--vscode-textLink-foreground) 35%, var(--vscode-border));
              color: var(--vscode-foreground);
            }

            .message.assistant .bubble {
              background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-sideBar-background));
            }

            .bubble p {
              margin: 0 0 0.8em;
            }

            .bubble p:last-child {
              margin-bottom: 0;
            }

            .bubble pre {
              margin: 0.6em 0;
              padding: 12px;
              border-radius: 8px;
              background: color-mix(in srgb, var(--vscode-editor-background) 80%, var(--vscode-sideBar-background));
              border: 1px solid var(--vscode-border);
              overflow-x: auto;
              font-family: "Cascadia Code", Consolas, monospace;
              font-size: 12px;
            }

            .bubble code {
              font-family: "Cascadia Code", Consolas, monospace;
              font-size: 12px;
              background: color-mix(in srgb, var(--vscode-editor-background) 85%, var(--vscode-sideBar-background));
              padding: 2px 4px;
              border-radius: 4px;
            }

            .bubble a {
              color: var(--vscode-textLink-foreground);
            }

            @keyframes spin {
              0% { transform: rotate(0deg); }
              100% { transform: rotate(360deg); }
            }

            .spinner {
              border: 2px solid var(--vscode-descriptionForeground);
              border-top-color: transparent;
              border-radius: 50%;
              width: 12px;
              height: 12px;
              animation: spin 0.8s linear infinite;
            }

            #thinking-indicator {
              display: none;
              font-size: 12px;
              color: var(--vscode-descriptionForeground);
              padding: 8px 0;
              justify-content: center;
              align-items: center;
              gap: 8px;
            }

            body[data-state="busy"] #thinking-indicator {
              display: flex;
            }

            .composer {
              padding: 16px;
              border-top: 1px solid var(--vscode-border);
              display: flex;
              flex-direction: column;
              gap: 12px;
              background: var(--vscode-sideBar-background);
            }

            .composer textarea {
              width: 100%;
              min-height: 72px;
              max-height: 220px;
              resize: none;
              border: 1px solid var(--vscode-border);
              border-radius: 8px;
              padding: 12px;
              font-size: 13px;
              line-height: 1.6;
              background: var(--vscode-editor-background);
              color: var(--vscode-foreground);
              box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.08);
            }

            .composer textarea:focus {
              outline: 1px solid var(--vscode-textLink-foreground);
              outline-offset: 2px;
            }

            .composer textarea:disabled {
              opacity: 0.7;
            }

            .composer-actions {
              display: flex;
              justify-content: flex-end;
              gap: 8px;
              align-items: center;
            }

            button {
              border-radius: 6px;
              border: 1px solid var(--vscode-border);
              padding: 6px 14px;
              font-size: 13px;
              cursor: pointer;
              background: var(--vscode-button-background);
              color: var(--vscode-button-foreground);
              display: inline-flex;
              align-items: center;
              gap: 6px;
              transition: background 0.15s ease, border-color 0.15s ease;
            }

            button.secondary {
              background: transparent;
              color: var(--vscode-foreground);
            }

            button:disabled {
              opacity: 0.5;
              cursor: default;
            }

            #stop-button {
              display: none;
            }

            body[data-state="busy"] #stop-button {
              display: inline-flex;
            }

            body[data-state="busy"] #send-button {
              opacity: 0.5;
            }

            .empty-state {
              margin: auto;
              text-align: center;
              max-width: 260px;
              color: var(--vscode-descriptionForeground);
              font-size: 13px;
            }

            .empty-state h2 {
              margin: 0 0 8px;
              font-size: 16px;
              font-weight: 500;
              color: var(--vscode-foreground);
            }

            .context-preview-panel {
              border-top: 1px solid var(--vscode-border);
              border-bottom: 1px solid var(--vscode-border);
              background: var(--vscode-editor-background);
              max-height: 300px;
              overflow-y: auto;
              font-size: 12px;
            }

            .context-preview-header {
              padding: 8px 12px;
              display: flex;
              justify-content: space-between;
              align-items: center;
              border-bottom: 1px solid var(--vscode-border);
              background: var(--vscode-sideBar-background);
            }

            .close-button {
              background: transparent;
              border: none;
              color: var(--vscode-foreground);
              font-size: 18px;
              line-height: 1;
              padding: 0 6px;
              cursor: pointer;
              width: auto;
              min-width: auto;
            }

            .close-button:hover {
              opacity: 0.7;
            }

            .context-preview-content {
              padding: 12px;
              font-family: 'Cascadia Code', Consolas, monospace;
              white-space: pre-wrap;
              word-break: break-word;
              color: var(--vscode-descriptionForeground);
            }

            .context-preview-content .section {
              margin-bottom: 16px;
            }

            .context-preview-content .section-title {
              font-weight: 600;
              color: var(--vscode-foreground);
              margin-bottom: 8px;
              font-family: "Segoe UI", sans-serif;
            }

            .context-badges {
              display: flex;
              gap: 6px;
              margin-bottom: 8px;
              flex-wrap: wrap;
            }

            .context-badge {
              font-size: 10px;
              padding: 2px 6px;
              border-radius: 3px;
              background: var(--vscode-badge-background);
              color: var(--vscode-badge-foreground);
              font-weight: 500;
              text-transform: uppercase;
            }

            @media (max-width: 600px) {
              .bubble {
                max-width: 100%;
              }
            }
          </style>
        </head>
        <body data-state="idle">
          <div class="app">
            <header class="header">
              <div class="header-title">
                <h1>TITAN</h1>
                <p class="header-subtitle">Version <span id="version">${versionLabel}</span></p>
              </div>
              <div class="header-actions">
                <select id="chat-session-selector" title="Switch chat" style="min-width:100px;max-width:160px;height:28px;">
                  <!-- chat options rendered here -->
                </select>
                <button id="toggle-context-button" class="secondary" type="button" title="Show Context">👁 Context</button>
                <button id="clear-chat-button" class="secondary" type="button" title="Clear messages in this chat">Clear Chat</button>
                <button id="new-chat-button" class="secondary" type="button">New Chat</button>
              </div>
            </header>
            <div class="divider" role="presentation"></div>
            <div id="context-preview-panel" class="context-preview-panel" style="display:none;">
              <div class="context-preview-header">
                <strong>Context & Prompt Preview</strong>
                <button id="close-context-button" class="close-button" type="button" title="Hide Context">×</button>
              </div>
              <div id="context-preview-content" class="context-preview-content"></div>
            </div>
            <section class="chat-area" id="chat" aria-label="Chat conversation">
              <div id="chat-messages" role="log" aria-live="polite"></div>
                            <div id="thinking-indicator" aria-live="polite">
                <div class="spinner"></div>
                <span id="thinking-label">Thinking…</span>
              </div>
            </section>
            <form id="chat-form" class="composer" autocomplete="off">
              <textarea id="chat-input" placeholder="Ask TITAN…" spellcheck="false"></textarea>
              <div class="composer-actions">
                <button id="stop-button" type="button" class="secondary">Stop</button>
                <button id="send-button" type="submit">Send</button>
              </div>
            </form>
          </div>
          <script nonce="${nonce}">
${scriptContent}
          </script>
        </body>
      </html>`;
  }

  private getWebviewScript(): string {
    return String.raw`
(function () {
  const vscode = acquireVsCodeApi();
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const sendButton = document.getElementById('send-button');
  const stopButton = document.getElementById('stop-button');
  const newChatButton = document.getElementById('new-chat-button');
  const clearChatButton = document.getElementById('clear-chat-button');
  const toggleContextButton = document.getElementById('toggle-context-button');
  const closeContextButton = document.getElementById('close-context-button');
  const contextPreviewPanel = document.getElementById('context-preview-panel');
  const contextPreviewContent = document.getElementById('context-preview-content');
  const chatSessionSelector = document.getElementById('chat-session-selector');
  const chatMessages = document.getElementById('chat-messages');
    const thinkingIndicator = document.getElementById('thinking-indicator');
  const thinkingLabel = document.getElementById('thinking-label');
  const versionLabel = document.getElementById('version');

  if (!form || !input || !sendButton || !stopButton || !newChatButton || !chatMessages || !thinkingIndicator) {
    console.error('Titan Forge AI sidebar: required elements missing');
    return;
  }

  // Context preview elements are optional
  if (!contextPreviewPanel || !contextPreviewContent || !toggleContextButton) {
    console.warn('Titan Forge AI sidebar: context preview elements missing');
  }

  // ---------- Titan Forge AI Multi-Session State ----------
  const state = {
    streaming: false,
    sessions: [], // list of sessions: {id, title, messages, createdAt}
    activeSessionId: null
  };

  const NEAR_BOTTOM_THRESHOLD = 48;
  let userPinnedToBottom = true;
  let showingWorkingIndicator = false;
  let streamHasProducedToken = false;

  // Restore state from webview/local storage if exists
  function restoreWebviewState() {
    const saved = vscode.getState && vscode.getState();
    if (saved && saved.sessions && saved.activeSessionId) {
      state.sessions = saved.sessions;
      state.activeSessionId = saved.activeSessionId;
      return true;
    }
    return false;
  }
  function persistWebviewState() {
    vscode.setState({ sessions: [...state.sessions], activeSessionId: state.activeSessionId });
  }

  // Helper to find active session
  function getActiveSession() {
    return state.sessions.find((s) => s.id === state.activeSessionId) || null;
  }

  // ---------- END session state boilerplate ----------

  let assistantTemp = null;

  const fencePattern = new RegExp('\u0060\u0060\u0060([\\s\\S]*?)\u0060\u0060\u0060', 'g');
  const inlineCodePattern = new RegExp('\u0060([^\u0060]+)\u0060', 'g');

  const contextBlockPatterns = [
    /\[SYSTEM(?:_INSTRUCTIONS)?\][\s\S]*?\[\/SYSTEM(?:_INSTRUCTIONS)?\]/gi,
    /\[SYSTEM\][\s\S]*?\[\/SYSTEM\]/gi,
    /\[WORKSPACE_CONTEXT\][\s\S]*?\[\/WORKSPACE_CONTEXT\]/gi,
    /\[EDITOR_CONTEXT\][\s\S]*?\[\/EDITOR_CONTEXT\]/gi,
    /\[CONTEXT(?: SUMMARY)?\][\s\S]*?\[\/CONTEXT(?: SUMMARY)?\]/gi
  ];

  function isStandaloneJson(value) {
    const trimmed = value.trim();
    if (!trimmed) {
      return false;
    }
    if (!/^\s*[\[{]/.test(trimmed)) {
      return false;
    }
    try {
      JSON.parse(trimmed);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function sanitizeDisplayContent(value) {
    if (typeof value !== 'string') {
      return '';
    }

    let sanitized = value;
    sanitized = sanitized.replace(/\[\/?(?:SYSTEM|EDITOR_CONTEXT|WORKSPACE_CONTEXT|CONTEXT(?: SUMMARY)?)\]/gi, '');
    sanitized = sanitized.replace(/CONTEXT SUMMARY:?[^\n]*\n(?:[\s\S]*?)(?=\n{2,}|$)/gi, '');

    sanitized = sanitized.replace(/\n{3,}/g, '\n\n');

    const trimmed = sanitized.trim();
    if (!trimmed || isStandaloneJson(trimmed)) {
      return '';
    }

    return sanitized;
  }

  function escapeHtml(value) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderMarkdown(source) {
    if (typeof source !== 'string' || source.length === 0) {
      return '';
    }

    const codeBlocks = [];
    let text = source.replace(fencePattern, function (_match, code) {
      const token = '__TF_CODE_BLOCK_' + codeBlocks.length + '__';
      codeBlocks.push(code);
      return token;
    });

    text = escapeHtml(text);

    text = text.replace(/__TF_CODE_BLOCK_(\d+)__/g, function (_, index) {
      const code = escapeHtml(codeBlocks[Number(index)] || '');
      return '<pre><code>' + code + '</code></pre>';
    });

    text = text.replace(inlineCodePattern, '<code>$1</code>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[\w\-./?%&=#+~:]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    const paragraphs = text.split(/\n\n+/).map(function (segment) {
      return segment.replace(/\n/g, '<br />');
    });

    return paragraphs.map(function (segment) {
      return '<p>' + segment + '</p>';
    }).join('');
  }

  function isNearBottom(container) {
    return container.scrollHeight - container.scrollTop - container.clientHeight <= NEAR_BOTTOM_THRESHOLD;
  }

  function scrollToBottom(container, force) {
    if (force || userPinnedToBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }

  function setBubbleContent(bubble, raw, options) {
    if (!options || options.markdown !== false) {
      bubble.innerHTML = renderMarkdown(raw);
    } else {
      bubble.textContent = raw;
    }
  }

  function formatTimestamp(value) {
    if (!value) {
      return 'unknown';
    }
    try {
      return new Date(value).toLocaleTimeString();
    } catch (_error) {
      return 'unknown';
    }
  }

  function renderContextPreview(preview) {
    if (!contextPreviewContent) return;

    if (!preview) {
      contextPreviewContent.textContent = 'No context available for this message.';
      return;
    }

    const sections = [];
    const snapshotLines = [];
    snapshotLines.push('Captured: ' + formatTimestamp(preview.capturedAt));
    snapshotLines.push('Truncated: ' + (preview.truncated ? 'yes' : 'no'));
    sections.push({
      title: '=== SNAPSHOT ===',
      content: snapshotLines.join('\n')
    });

    if (preview.editor && preview.editor.path) {
      const dirtyLabel = preview.editor.isDirty ? ' (unsaved)' : '';
      const editorLines = [
        'File: ' + escapeHtml(preview.editor.path) + dirtyLabel,
        'Language: ' + escapeHtml(preview.editor.languageId || 'unknown'),
        escapeHtml(preview.editor.lines || '')
      ];
      sections.push({
        title: '=== ACTIVE EDITOR ===',
        content: editorLines.join('\n')
      });
    }

    if (Array.isArray(preview.includedFiles) && preview.includedFiles.length > 0) {
      const includedLines = preview.includedFiles.map(function (file) {
        let label = '  • ' + escapeHtml(file);
        if (preview.editor && preview.editor.path === file) {
          label += preview.editor.isDirty ? ' (active · unsaved)' : ' (active)';
        }
        return label;
      });
      sections.push({
        title: '=== INCLUDED FILES (' + preview.includedFiles.length + ') ===',
        content: includedLines.join('\n')
      });
    }

    if (Array.isArray(preview.requestedFiles) && preview.requestedFiles.length > 0) {
      const requestedLines = preview.requestedFiles.map(function (file) {
        const safe = escapeHtml(file);
        if (preview.includedFiles && preview.includedFiles.includes(file)) {
          return '  • ' + safe + ' (included)';
        }
        if (preview.ignoredFiles && preview.ignoredFiles.includes(file)) {
          return '  • ' + safe + ' (ignored)';
        }
        return '  • ' + safe + ' (pending)';
      });
      sections.push({
        title: '=== REQUESTED FILES ===',
        content: requestedLines.join('\n')
      });
    }

    if (Array.isArray(preview.ignoredFiles) && preview.ignoredFiles.length > 0) {
      const ignoredLines = preview.ignoredFiles.map(function (file) {
        return '  • ' + escapeHtml(file);
      });
      sections.push({
        title: '=== IGNORED PATHS ===',
        content: ignoredLines.join('\n')
      });
    }

    if (typeof preview.finalPrompt === 'string' && preview.finalPrompt.trim().length > 0) {
      const snippet = preview.finalPrompt.length > 1200 ? preview.finalPrompt.slice(0, 1200) + '\n…' : preview.finalPrompt;
      sections.push({
        title: '=== PROMPT PAYLOAD (TRUNCATED) ===',
        content: escapeHtml(snippet)
      });
    }

    contextPreviewContent.innerHTML = sections
      .map(function (section) {
        return '<div class="section"><div class="section-title">' + section.title + '</div>' + section.content + '</div>';
      })
      .join('\n');
  }

  function appendMessage(role, content, options) {
    const safeContent = sanitizeDisplayContent(content);
    if (!safeContent) {
      console.warn('Titan Forge AI sidebar suppressed unsafe content for role:', role);
      return null;
    }

    const allowMarkdown = !(options && options.markdown === false);

    const messageEl = document.createElement('div');
    messageEl.className = 'message ' + role;
    
    // Add message ID to prevent duplicates
    if (options && options.messageId) {
      messageEl.dataset.messageId = options.messageId;
    }
    
    if (options && options.local) {
      messageEl.dataset.source = 'local';
    }

    // Add context badges if provided
    if (options && options.badges && options.badges.length > 0) {
      const badgesEl = document.createElement('div');
      badgesEl.className = 'context-badges';
      options.badges.forEach(badge => {
        const badgeEl = document.createElement('span');
        badgeEl.className = 'context-badge';
        badgeEl.textContent = badge;
        badgesEl.appendChild(badgeEl);
      });
      messageEl.appendChild(badgesEl);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    setBubbleContent(bubble, safeContent, { markdown: allowMarkdown });
    messageEl.appendChild(bubble);
    chatMessages.appendChild(messageEl);
    scrollToBottom(chatMessages);
    return { messageEl: messageEl, bubble: bubble, content: safeContent };
  }

  function updateControls() {
    const hasText = input.value.trim().length > 0;
    sendButton.disabled = state.streaming || !hasText;
    stopButton.disabled = !state.streaming;
    input.disabled = state.streaming;
  }

  function setStreaming(streaming, status) {
    state.streaming = streaming;
    document.body.setAttribute('data-state', streaming ? 'busy' : 'idle');

    if (streaming && thinkingLabel) {
      switch (status) {
        case 'thinking':
          thinkingLabel.textContent = 'Titan is thinking...';
          break;
        case 'processing':
          thinkingLabel.textContent = 'Titan is processing...';
          break;
        default:
          thinkingLabel.textContent = 'Titan is working...';
          break;
      }
    } 

    if (!streaming) {
      streamHasProducedToken = false;
    }
    updateControls();
  }

  function showWorkingIndicator() {
    if (!thinkingIndicator) {
      return;
    }

    showingWorkingIndicator = true;
    thinkingIndicator.textContent = 'TITAN is working…';

    if (!state.streaming) {
      setStreaming(true);
    }
  }

  function hideWorkingIndicator() {
    if (!thinkingIndicator) {
      return;
    }

    showingWorkingIndicator = false;
    if (!state.streaming) {
      thinkingIndicator.textContent = '';
    } else if (streamHasProducedToken) {
      thinkingIndicator.textContent = '';
    }
  }

  function resetComposer() {
    input.value = '';
    input.style.height = '';
    updateControls();
  }

  function autoResize() {
    input.style.height = 'auto';
    const next = Math.min(220, Math.max(72, input.scrollHeight + 2));
    input.style.height = String(next) + 'px';
  }

  // Render sessions dropdown (label = session.title || Chat N)
  function renderSessionSelector() {
    if (!chatSessionSelector) return;
    chatSessionSelector.innerHTML = '';
    state.sessions.forEach((session, i) => {
      const opt = document.createElement('option');
      const title = (session.title && session.title.trim()) ? session.title.trim() : ('Chat ' + (i + 1));
      opt.textContent = title;
      opt.value = session.id;
      if (session.id === state.activeSessionId) opt.selected = true;
      chatSessionSelector.appendChild(opt);
    });
  }

  // Renders current session's messages in the DOM
  function renderActiveSession() {
    const currentScrollTop = chatMessages.scrollTop;
    const wasAtBottom = isNearBottom(chatMessages);

    chatMessages.innerHTML = '';
    assistantTemp = null;
    const current = getActiveSession();
    if (current && Array.isArray(current.messages)) {
      current.messages.forEach((entry) => {
        const messageId = generateMessageId(entry.role, entry.content, entry.timestamp);
        appendMessage(entry.role, entry.content, { messageId: messageId });
      });
    }
    renderSessionSelector();

    if (wasAtBottom) {
      scrollToBottom(chatMessages, true);
    } else {
      chatMessages.scrollTop = currentScrollTop;
    }
  }

  // Create a new session (logic only, backend logic is triggered)
  function handleNewSession() {
    // Clear context preview to prevent leak to new session
    if (contextPreviewPanel) {
      contextPreviewPanel.style.display = 'none';
    }
    if (contextPreviewContent) {
      contextPreviewContent.innerHTML = '';
    }
    vscode.postMessage({ type: 'newSession' });
    // Local state will be updated on backend response ("sessions" message type)
  }

  input.addEventListener('input', function () {
    autoResize();
    updateControls();
  });

  newChatButton.addEventListener('click', function () {
    handleNewSession();
    resetComposer();
    input.focus();
  });

  // Handle session switch via dropdown
  if (chatSessionSelector) {
    chatSessionSelector.addEventListener('change', function (e) {
      const id = chatSessionSelector.value;
      if (id && id !== state.activeSessionId) {
        vscode.postMessage({ type: 'switchSession', sessionId: id });
        // State will update/react in response to 'sessions' backend event
      }
    });
  }

  // Clear current session's messages
  if (clearChatButton) {
    clearChatButton.addEventListener('click', function () {
      const current = getActiveSession();
      if (!current) return;
      current.messages = [];
      persistWebviewState();
      renderActiveSession();
    });
  }

  // Toggle context preview panel
  if (toggleContextButton && contextPreviewPanel) {
    toggleContextButton.addEventListener('click', function () {
      if (contextPreviewPanel.style.display === 'none') {
        contextPreviewPanel.style.display = 'block';
      } else {
        contextPreviewPanel.style.display = 'none';
      }
    });
  }

  if (closeContextButton && contextPreviewPanel) {
    closeContextButton.addEventListener('click', function () {
      contextPreviewPanel.style.display = 'none';
    });
  }

  // Track current assistant message for badges
  let currentAssistantMessageEl = null;

  // Track message IDs to prevent duplicates
  const renderedMessageIds = new Set();

  function generateMessageId(role, content, timestamp) {
    return role + ':' + timestamp + ':' + (content.substring(0, 50).replace(/[^a-zA-Z0-9]/g, ''));
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    const value = input.value.trim();
    // Prevent empty messages
    if (!value || value.length === 0 || state.streaming) {
      return;
    }
    const sessionId = state.activeSessionId;
    if (!sessionId) return;
    
    const timestamp = Date.now();
    const messageId = generateMessageId('user', value, timestamp);
    
    // Only add if not already rendered (prevent duplicates)
    if (!renderedMessageIds.has(messageId)) {
      renderedMessageIds.add(messageId);
      const current = getActiveSession();
      if (current) {
        current.messages.push({ role: 'user', content: value, timestamp });
        persistWebviewState();
        // This is handled by the 'sessions' message handler, which calls renderActiveSession
        // appendMessage('user', value, { messageId }); // To prevent double rendering
        renderActiveSession();
      }
    }
    
    vscode.postMessage({ type: 'send', sessionId, content: value });
    setStreaming(true);
    resetComposer();
  });

  stopButton.addEventListener('click', function () {
    if (!state.streaming) {
      return;
    }
    vscode.postMessage({ type: 'cancel' });
  });

  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    }
  });

  if (chatMessages) {
    chatMessages.addEventListener('scroll', function () {
      userPinnedToBottom = isNearBottom(chatMessages);
    });
  }

  window.addEventListener('message', function (event) {
    const message = event.data;
    switch (message.type) {
      case 'chatStreamStarted':
        streamHasProducedToken = false;
        showWorkingIndicator();
        scrollToBottom(chatMessages);
        break;
      case 'sessions':
        if (Array.isArray(message.sessions) && message.activeSessionId) {
          state.sessions = message.sessions;
          state.activeSessionId = message.activeSessionId;
          persistWebviewState();
          renderActiveSession();
        }
        break;
      case 'init':
        // sessions, activeSessionId always sent from backend
        if (Array.isArray(message.sessions) && message.activeSessionId) {
          state.sessions = message.sessions;
          state.activeSessionId = message.activeSessionId;
          persistWebviewState();
          renderActiveSession();
        }
        if (typeof message.version === 'string' && versionLabel) {
          versionLabel.textContent = message.version;
        }
        setStreaming(false);
        input.focus();
        autoResize();
        break;
      case 'contextPreview':
        if (contextPreviewPanel && contextPreviewContent) {
          contextPreviewContent.innerHTML = '';
          renderContextPreview(message.preview);
          // Panel is now manually toggled by the user
          if (contextPreviewContent.innerHTML.trim().length === 0 && contextPreviewPanel.style.display !== 'none') {
            contextPreviewPanel.style.display = 'none';
          }
        }
        break;
      case 'contextBadges':
        // Add badges to the last assistant message
        if (currentAssistantMessageEl) {
          const badgesEl = document.createElement('div');
          badgesEl.className = 'context-badges';
          const badges = [];
          if (message.sources.hasEditor) badges.push('EDITOR');
          if (message.sources.hasWorkspace) badges.push('WORKSPACE');
          if (badges.length === 0) badges.push('MANUAL');
          
          badges.forEach(badge => {
            const badgeEl = document.createElement('span');
            badgeEl.className = 'context-badge';
            badgeEl.textContent = badge;
            badgesEl.appendChild(badgeEl);
          });
          
          if (currentAssistantMessageEl.firstChild) {
            currentAssistantMessageEl.insertBefore(badgesEl, currentAssistantMessageEl.firstChild);
          } else {
            currentAssistantMessageEl.appendChild(badgesEl);
          }
          currentAssistantMessageEl = null;
        }
        break;
      case 'chatMessage': {
        // This is an authoritative response from backend; update only active session
        const current = getActiveSession();
        if (current) {
          const timestamp = Date.now();
          const messageId = generateMessageId(message.role, message.content, timestamp);
          
          // For assistant messages during/after streaming, check if already streamed
          if (message.role === 'assistant' && assistantTemp) {
            // This is the final message after streaming - update the temp message content
            // but don't create a duplicate
            assistantTemp.messageEl.removeAttribute('data-temp');
            const bubble = assistantTemp.messageEl.querySelector('.bubble');
            if (bubble) {
              setBubbleContent(bubble, message.content);
            }
            // Update session state but don't re-render (message already in UI)
            current.messages.push({
              role: message.role,
              content: message.content,
              timestamp
            });
            persistWebviewState();
            assistantTemp = null;
            break;
          }
          
          // Only add if not already rendered (prevent duplicates)
          if (!renderedMessageIds.has(messageId)) {
            renderedMessageIds.add(messageId);
            current.messages.push({
              role: message.role,
              content: message.content,
              timestamp
            });
            persistWebviewState();
            
            // Only render if this is a new message (not already in UI)
            const existingInUI = chatMessages.querySelector('.message.' + message.role + '[data-message-id="' + messageId + '"]');
            if (!existingInUI) {
              renderActiveSession();
            }
            
            // Track assistant messages for badge insertion
            if (message.role === 'assistant') {
              const messages = chatMessages.querySelectorAll('.message.assistant');
              if (messages.length > 0) {
                currentAssistantMessageEl = messages[messages.length - 1];
              }
            }
          }
        }
        break;
      }
      case 'chatStreamChunk':
        if (typeof message.content !== 'string') {
          break;
        }

        const incomingChunk = message.content;
        if (!incomingChunk || incomingChunk.trim().length === 0) {
          break;
        }

        const sanitizedChunk = sanitizeDisplayContent(incomingChunk);
        if (!sanitizedChunk) {
          break;
        }

        if (!streamHasProducedToken) {
          streamHasProducedToken = true;
          hideWorkingIndicator();
        }

        if (!assistantTemp) {
          const streamId = 'stream:' + Date.now() + ':' + Math.random().toString(36).slice(2);
          const created = appendMessage('assistant', sanitizedChunk, { streaming: true, messageId: streamId });
          if (!created) {
            break;
          }
          assistantTemp = {
            messageEl: created.messageEl,
            bubble: created.bubble,
            raw: sanitizedChunk,
            messageId: streamId
          };
          created.messageEl.dataset.temp = 'true';
          currentAssistantMessageEl = created.messageEl;
          renderedMessageIds.add(streamId);
        } else {
          const merged = sanitizeDisplayContent((assistantTemp.raw || '') + incomingChunk);
          if (!merged) {
            break;
          }
          assistantTemp.raw = merged;
          setBubbleContent(assistantTemp.bubble, assistantTemp.raw);
        }
        scrollToBottom(chatMessages);
        break;
      case 'chatStreamCompleted':
        hideWorkingIndicator();
        if (assistantTemp) {
          // Remove temp marker, message is now final
          assistantTemp.messageEl.removeAttribute('data-temp');
          // Mark the final message ID to prevent duplicate final messages
          if (assistantTemp.messageId) {
            renderedMessageIds.add('final:' + assistantTemp.messageId);
          }
          assistantTemp = null;
        }
        setStreaming(false);
        scrollToBottom(chatMessages);
        input.focus();
        autoResize();
        break;
      case 'chatError':
        appendMessage('assistant', '⚠️ ' + message.message, { markdown: false });
        setStreaming(false);
        input.focus();
        autoResize();
        break;
      case 'status':
        setStreaming(message.status !== 'idle', message.status);
        if (message.status === 'idle') {
          input.focus();
          autoResize();
        }
        break;
      case 'log':
        break;
      case 'fileRead':
        appendMessage('assistant', 'Contents of ' + message.path + '\n' + (message.content || ''));
        break;
      case 'fileOpened':
        appendMessage('assistant', 'Opened file: ' + message.path);
        break;
      case 'fileSaved':
        appendMessage('assistant', 'Saved file: ' + message.path);
        break;
      case 'workspace':
        appendMessage('assistant', 'No workspace folder open. Some features are disabled.');
        break;
      case 'version':
        if (versionLabel) {
          versionLabel.textContent = message.value;
        }
        break;
      default:
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
  setTimeout(function () {
    input.focus();
    autoResize();
    updateControls();
  }, 0);
})();
`.trim();
  }

  private getFallbackHtml(error: Error): string {
    const message = this.escapeHtml(error.message);
    return `<!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <title>Titan Forge AI</title>
          <style>
            body {
              font-family: "Segoe UI", sans-serif;
              color: var(--vscode-foreground, #333);
              background: var(--vscode-sideBar-background, #fff);
              padding: 16px;
            }

            h2 {
              margin-top: 0;
            }

            pre {
              background: rgba(0, 0, 0, 0.05);
              padding: 12px;
              border-radius: 6px;
              overflow-x: auto;
            }
          </style>
        </head>
        <body>
          <h2>Titan Forge AI</h2>
          <p>Sidebar initialized successfully</p>
          <p>Unable to render sidebar UI. Please reload the window.</p>
          <pre>${message}</pre>
        </body>
      </html>`;
  }

  private getNonce(): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let index = 0; index < 32; index += 1) {
      text += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return text;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
