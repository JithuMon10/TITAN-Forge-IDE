import 'vscode';

declare module 'vscode' {
  interface ExtensionContext {
    readonly extensionUri: Uri;
  }

  interface WebviewView {
    readonly webview: Webview;
    title?: string;
    description?: string;
    show?(preserveFocus?: boolean): void;
  }

  interface WebviewViewProvider {
    resolveWebviewView(
      webviewView: WebviewView,
      context?: unknown,
      token?: CancellationToken
    ): void | Thenable<void>;
  }

  namespace window {
    function registerWebviewViewProvider(
      viewType: string,
      provider: WebviewViewProvider,
      options?: {
        webviewOptions?: {
          retainContextWhenHidden?: boolean;
        };
      }
    ): Disposable;
  }
}
