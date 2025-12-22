import * as http from 'http';
import * as https from 'https';
import { Output } from '../titan-core/output';

export const DEFAULT_MODEL = 'qwen2.5-coder:7b';
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
export const DEFAULT_TIMEOUT_MS = 60_000;

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

export interface CancellationTokenLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested?(listener: () => void): { dispose(): void };
}

export interface OllamaConfigurationProvider {
  getBaseUrl(): string;
  getModel(): string;
  getRequestTimeoutMs(): number;
}

interface OllamaConfigurationSnapshot {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

const DEFAULT_CONFIGURATION_PROVIDER: OllamaConfigurationProvider = {
  getBaseUrl: () => DEFAULT_OLLAMA_URL,
  getModel: () => DEFAULT_MODEL,
  getRequestTimeoutMs: () => DEFAULT_TIMEOUT_MS
};

function ensureMinimumTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(10_000, value);
}

export class OllamaClient {
  constructor(
    private readonly output: Output,
    private readonly configurationProvider: OllamaConfigurationProvider = DEFAULT_CONFIGURATION_PROVIDER
  ) {}

  async checkHealth(): Promise<boolean> {
    try {
      const { baseUrl } = this.getConfigurationSnapshot();
      const endpoint = new URL('/api/tags', `${baseUrl}/`);

      return await new Promise((resolve) => {
        const transport = endpoint.protocol === 'https:' ? https : http;
        const requestOptions: https.RequestOptions = {
          protocol: endpoint.protocol,
          hostname: endpoint.hostname,
          port: endpoint.port.length > 0 ? parseInt(endpoint.port, 10) : undefined,
          path: `${endpoint.pathname}${endpoint.search}`,
          method: 'GET',
          timeout: 3000
        };

        const request = transport.request(requestOptions, (response) => {
          const statusCode = response.statusCode ?? 0;
          resolve(statusCode >= 200 && statusCode < 300);
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
      this.output.appendLine(`[Ollama] Health check failed: ${String(error)}`);
      return false;
    }
  }

  async generate(options: OllamaRequestOptions): Promise<string> {
    const { baseUrl, model: defaultModel, timeoutMs } = this.getConfigurationSnapshot();
    const model = (options.model ?? defaultModel).trim() || DEFAULT_MODEL;

    const endpoint = new URL('/api/generate', `${baseUrl}/`);
    const requestBody = JSON.stringify({
      model,
      prompt: options.prompt,
      stream: false,
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

    return await new Promise((resolve, reject) => {
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

      this.output.appendLine(`[Ollama] Generating ${model} at ${endpoint.toString()}`);

      const request = transport.request(requestOptions, (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          let errorData = '';
          response.on('data', (chunk) => (errorData += chunk));
          response.on('end', () => {
            let errorMessage = `Ollama request failed (${statusCode} ${response.statusMessage ?? ''})`;
            try {
              const parsed = JSON.parse(errorData);
              if (parsed?.error) {
                errorMessage += `: ${parsed.error}`;
              }
            } catch {
              // ignore JSON parse errors
            }
            reject(new Error(errorMessage));
          });
          response.resume();
          return;
        }

        response.setEncoding('utf8');
        let buffer = '';
        response.on('data', (chunk) => (buffer += chunk));
        response.on('end', () => {
          try {
            const data = JSON.parse(buffer);
            this.output.appendLine('[Ollama] Response received successfully');

            if (typeof data?.response === 'string') {
              resolve(data.response);
              return;
            }
            if (typeof data?.message?.content === 'string') {
              resolve(data.message.content);
              return;
            }
            if (typeof data === 'string') {
              resolve(data);
              return;
            }

            this.output.appendLine(`[Ollama] Unexpected response format: ${JSON.stringify(data)}`);
            resolve(JSON.stringify(data));
          } catch {
            this.output.appendLine(`[Ollama] Failed to parse response: ${buffer}`);
            reject(new Error('Failed to parse Ollama response'));
          }
        });
      });

      request.on('error', (err) => {
        this.output.appendLine(`[Ollama] Request error: ${err.message}`);
        if (err.message.includes('ECONNREFUSED')) {
          reject(new Error("Could not connect to Ollama. Make sure it's running with: ollama serve"));
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
    cancellationToken?: CancellationTokenLike
  ): Promise<void> {
    const { baseUrl, model: defaultModel, timeoutMs } = this.getConfigurationSnapshot();
    const model = (options.model ?? defaultModel).trim() || DEFAULT_MODEL;

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

      this.output.appendLine(`[Ollama] Requesting ${model} at ${endpoint.toString()}`);

      let settled = false;
      let cleanedUp = false;
      let timer: NodeJS.Timeout | undefined;
      let tokenDisposable: { dispose(): void } | undefined;

      const cleanup = (): void => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (tokenDisposable) {
          tokenDisposable.dispose();
          tokenDisposable = undefined;
        }
      };

      const resolveOnce = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };

      const rejectOnce = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      const request = transport.request(requestOptions, (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          let errorData = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => (errorData += chunk));
          const finalize = (details?: string): void => {
            let errorMessage = `Ollama request failed (${statusCode} ${response.statusMessage ?? ''})`;
            if (errorData.length > 0) {
              try {
                const parsed = JSON.parse(errorData);
                if (parsed?.error) {
                  errorMessage += `: ${parsed.error}`;
                }
              } catch {
                errorMessage += `: ${errorData}`;
              }
            }
            if (details) {
              errorMessage += ` (${details})`;
            }
            const error = new Error(errorMessage);
            callbacks.onError(error);
            finish();
            rejectOnce(error);
          };
          response.on('end', () => finalize());
          response.on('error', (error) => {
            const errMsg = error instanceof Error ? error.message : String(error);
            finalize(errMsg);
          });
          return;
        }

        response.setEncoding('utf8');
        let buffer = '';
        let doneEmitted = false;

        const processSegment = (segment: string): void => {
          if (settled) {
            return;
          }
          const trimmed = segment.trim();
          if (!trimmed) {
            return;
          }
          try {
            const isDone = this.processChunk(trimmed, callbacks);
            if (isDone && !doneEmitted) {
              doneEmitted = true;
              finish();
            }
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            callbacks.onError(err);
            finish();
            request.destroy(err);
            rejectOnce(err);
          }
        };

        response.on('data', (chunk: string) => {
          if (settled) {
            return;
          }
          buffer += chunk;
          const segments = buffer.split('\n');
          buffer = segments.pop() ?? '';
          for (const segment of segments) {
            processSegment(segment);
            if (settled) {
              return;
            }
          }
        });

        response.on('end', () => {
          if (!settled && buffer.trim().length > 0) {
            processSegment(buffer);
          }
          if (!doneEmitted) {
            finish();
          }
          resolveOnce();
        });

        response.on('error', (error) => {
          const err = error instanceof Error ? error : new Error(String(error));
          callbacks.onError(err);
          finish();
          rejectOnce(err);
        });
      });

      timer = setTimeout(() => {
        request.destroy(new Error(`Ollama request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      tokenDisposable = cancellationToken?.onCancellationRequested?.(() => {
        request.destroy(new Error('Request cancelled by user.'));
      });

      request.on('error', (error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.output.appendLine(`[Ollama] ${err.message}`);
        callbacks.onError(err);
        finish();
        rejectOnce(err);
      });

      request.write(bodyBuffer);
      request.end();
    });
  }

  private processChunk(rawChunk: string, callbacks: StreamCallbacks): boolean {
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
      this.output.appendLine(`[Ollama] Failed to parse chunk: ${trimmed}`);
      throw err;
    }
  }

  private getConfigurationSnapshot(): OllamaConfigurationSnapshot {
    const baseUrl = this.normalizeBaseUrl(this.configurationProvider.getBaseUrl());
    const model = (this.configurationProvider.getModel() ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const timeoutMs = ensureMinimumTimeout(this.configurationProvider.getRequestTimeoutMs());

    return { baseUrl, model, timeoutMs };
  }

  private normalizeBaseUrl(value: string | undefined): string {
    if (!value) {
      return DEFAULT_OLLAMA_URL;
    }
    return value.trim().replace(/\/$/, '') || DEFAULT_OLLAMA_URL;
  }
}
