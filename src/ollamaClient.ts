import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';

export const DEFAULT_MODEL = 'qwen2.5-coder:7b';
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_TIMEOUT_MS = 60_000;

export interface OllamaRequestOptions {
  prompt: string;
  model?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  numPredict?: number;
  numCtx?: number;
}

interface OllamaStreamChunk {
  response?: string;
  delta?: string;
  done?: boolean;
  error?: string;
}

export interface StreamCallbacks {
  onToken(data: string): void;
  onError(error: Error): void;
  onEnd(): void;
}

function ensureMinimumTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(10_000, value);
}

export class OllamaClient {
  constructor(private readonly outputChannel: vscode.OutputChannel) {}

  async checkHealth(): Promise<boolean> {
    try {
      const configuration = vscode.workspace.getConfiguration('titanForgeAI');
      const baseUrlSetting = (configuration.get<string>('ollamaUrl') ?? DEFAULT_OLLAMA_URL).trim();
      const baseUrl = baseUrlSetting.replace(/\/$/, '');

      const endpoint = new URL('/api/tags', `${baseUrl}/`);
      
      return new Promise((resolve) => {
        const transport = endpoint.protocol === 'https:' ? https : http;
        const requestOptions: https.RequestOptions = {
          protocol: endpoint.protocol,
          hostname: endpoint.hostname,
          port: endpoint.port.length > 0 ? parseInt(endpoint.port, 10) : undefined,
          path: `${endpoint.pathname}${endpoint.search}`,
          method: 'GET',
          timeout: 3000 // 3 second timeout for health check
        };

        const request = transport.request(requestOptions, (response) => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode >= 200 && statusCode < 300) {
            resolve(true);
          } else {
            resolve(false);
          }
          response.resume();
        });

        request.on('error', () => resolve(false));
        request.on('timeout', () => {
          request.destroy();
          resolve(false);
        });
        
        request.end();
      });
    } catch (error) {
      this.outputChannel.appendLine(`[Ollama] Health check failed: ${error}`);
      return false;
    }
  }

  async generate(options: OllamaRequestOptions): Promise<string> {
    const configuration = vscode.workspace.getConfiguration('titanForgeAI');
    const baseUrlSetting = (configuration.get<string>('ollamaUrl') ?? DEFAULT_OLLAMA_URL).trim();
    const baseUrl = baseUrlSetting.replace(/\/$/, '');
    const model = (options.model ?? configuration.get<string>('model') ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const timeoutMs = ensureMinimumTimeout(configuration.get<number>('requestTimeout') ?? DEFAULT_TIMEOUT_MS);

    const endpoint = new URL('/api/generate', `${baseUrl}/`);
    const requestBody = JSON.stringify({
      model,
      prompt: options.prompt,
      stream: false,
      options: {
        temperature: options.temperature ?? 0.0,        // Strict instruction following
        top_p: options.topP ?? 0.95,
        top_k: options.topK ?? 40,
        num_predict: options.numPredict ?? 4096,
        num_ctx: options.numCtx ?? 8192,
        repeat_penalty: options.repeatPenalty ?? 1.1      // Avoid repetition
      }
    });
    const bodyBuffer = Buffer.from(requestBody, 'utf8');

    return new Promise((resolve, reject) => {
      const transport = endpoint.protocol === 'https:' ? https : http;
      const requestOptions: https.RequestOptions = {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port.length > 0 ? parseInt(endpoint.port, 10) : undefined,
        path: `${endpoint.pathname}${endpoint.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBuffer.length
        }
      };

      this.outputChannel.appendLine(`[Ollama] Generating ${model} at ${endpoint.toString()}`);

      const request = transport.request(requestOptions, (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          let errorData = '';
          response.on('data', chunk => errorData += chunk);
          response.on('end', () => {
            let errorMessage = `Ollama request failed (${statusCode} ${response.statusMessage ?? ''})`;
            try {
              const errorJson = JSON.parse(errorData);
              if (errorJson.error) {
                errorMessage += `: ${errorJson.error}`;
              }
            } catch {
              // If we can't parse error, just use the status
            }
            reject(new Error(errorMessage));
          });
          response.resume();
          return;
        }
        response.setEncoding('utf8');
        let buffer = '';
        response.on('data', (chunk) => buffer += chunk);
        response.on('end', () => {
          try {
            const data = JSON.parse(buffer);
            this.outputChannel.appendLine(`[Ollama] Response received successfully`);
            
            // Handle different response formats
            if (typeof data.response === 'string') {
              resolve(data.response);
            } else if (data.message?.content) {
              resolve(data.message.content);
            } else if (typeof data === 'string') {
              resolve(data);
            } else {
              this.outputChannel.appendLine(`[Ollama] Unexpected response format: ${JSON.stringify(data)}`);
              resolve(JSON.stringify(data));
            }
          } catch (e) {
            this.outputChannel.appendLine(`[Ollama] Failed to parse response: ${buffer}`);
            reject(new Error('Failed to parse Ollama response'));
          }
        });
      });

      request.on('error', (err) => {
        this.outputChannel.appendLine(`[Ollama] Request error: ${err.message}`);
        if (err.message.includes('ECONNREFUSED')) {
          reject(new Error('Could not connect to Ollama. Make sure it\'s running with: ollama serve'));
        } else {
          reject(err);
        }
      });
      
      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`Ollama request timed out after ${timeoutMs}ms`));
      });
      
      request.write(bodyBuffer);
      request.end();
    });
  }

  async streamCompletion(
    options: OllamaRequestOptions,
    callbacks: StreamCallbacks,
    cancellationToken?: vscode.CancellationToken
  ): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('titanForgeAI');
    const baseUrlSetting = (configuration.get<string>('ollamaUrl') ?? DEFAULT_OLLAMA_URL).trim();
    const baseUrl = baseUrlSetting.replace(/\/$/, '');
    const model = (options.model ?? configuration.get<string>('model') ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const timeoutMs = ensureMinimumTimeout(configuration.get<number>('requestTimeout') ?? DEFAULT_TIMEOUT_MS);

    const finish = (() => {
      let ended = false;
      return () => {
        if (!ended) {
          ended = true;
          callbacks.onEnd();
        }
      };
    })();

    const endpoint = new URL('/api/generate', `${baseUrl}/`);
    const requestBody = JSON.stringify({
      model,
      prompt: options.prompt,
      stream: true,
      options: {
        temperature: options.temperature ?? 0.0,
        top_p: options.topP ?? 0.95,
        top_k: options.topK ?? 40,
        num_predict: options.numPredict ?? 4096,
        num_ctx: options.numCtx ?? 8192,
        repeat_penalty: options.repeatPenalty ?? 1.1
      }
    });
    const bodyBuffer = Buffer.from(requestBody, 'utf8');

    await new Promise<void>((resolve, reject) => {
      const transport = endpoint.protocol === 'https:' ? https : http;
      const requestOptions: https.RequestOptions = {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port.length > 0 ? parseInt(endpoint.port, 10) : undefined,
        path: `${endpoint.pathname}${endpoint.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': bodyBuffer.length
        }
      };

      this.outputChannel.appendLine(`[Ollama] Requesting ${model} at ${endpoint.toString()}`);

      const request = transport.request(requestOptions, (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          const error = new Error(`Ollama request failed (${statusCode} ${response.statusMessage ?? ''})`);
          callbacks.onError(error);
          finish();
          response.resume();
          cleanup();
          reject(error);
          request.destroy(error);
          return;
        }

        response.setEncoding('utf8');
        let buffer = '';

        const handleChunk = (chunk: string): boolean => {
          try {
            const isDone = this.processChunk(chunk, callbacks);
            if (isDone) {
              finish();
              return true;
            }
            return false;
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            callbacks.onError(err);
            finish();
            return true;
          }
        };

        response.on('data', (chunk: string) => {
          buffer += chunk;
          const segments = buffer.split('\n');
          buffer = segments.pop() ?? '';
          for (const segment of segments) {
            if (handleChunk(segment)) {
              request.destroy();
              return;
            }
          }
        });

        response.on('end', () => {
          if (buffer.trim().length > 0) {
            handleChunk(buffer);
          }
          finish();
          cleanup();
          resolve();
        });

        response.on('error', (error) => {
          const err = error instanceof Error ? error : new Error(String(error));
          callbacks.onError(err);
          finish();
          cleanup();
          reject(err);
        });
      });

      const cleanup = () => {
        clearTimeout(timer);
        tokenDisposable?.dispose();
      };

      const timer = setTimeout(() => {
        request.destroy(new Error(`Ollama request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const tokenDisposable = cancellationToken?.onCancellationRequested(() => {
        request.destroy(new Error('Request cancelled by user.'));
      });

      request.on('error', (error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.outputChannel.appendLine(`[Ollama] ${err.message}`);
        callbacks.onError(err);
        finish();
        cleanup();
        reject(err);
      });

      request.write(bodyBuffer);
      request.end();
    });
  }

  private processChunk(
    rawChunk: string,
    callbacks: StreamCallbacks
  ): boolean {
    const trimmed = rawChunk.trim();
    if (!trimmed) {
      return false;
    }

    try {
      const payload = JSON.parse(trimmed) as OllamaStreamChunk;

      if (typeof payload.error === 'string' && payload.error.length > 0) {
        throw new Error(payload.error);
      }

      const token = payload.response ?? payload.delta;
      if (typeof token === 'string' && token.length > 0) {
        callbacks.onToken(token);
      }

      return payload.done === true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.outputChannel.appendLine(`[Ollama] Failed to parse chunk: ${trimmed}`);
      throw err;
    }
  }
}
