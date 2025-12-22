import * as vscode from 'vscode';
import { Output } from '../titan-core/output';
import {
  DEFAULT_MODEL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_TIMEOUT_MS,
  OllamaConfigurationProvider
} from './ollamaClient';

export class VsCodeOutput implements Output {
  constructor(private readonly channel: vscode.OutputChannel) {}

  appendLine(text: string): void {
    this.channel.appendLine(text);
  }
}

export class VsCodeOllamaConfigurationProvider implements OllamaConfigurationProvider {
  getBaseUrl(): string {
    const raw = vscode.workspace.getConfiguration('titanForgeAI').get<string>('ollamaUrl');
    return (raw ?? DEFAULT_OLLAMA_URL).trim();
  }

  getModel(): string {
    const raw = vscode.workspace.getConfiguration('titanForgeAI').get<string>('model');
    const value = (raw ?? DEFAULT_MODEL).trim();
    return value || DEFAULT_MODEL;
  }

  getRequestTimeoutMs(): number {
    const raw = vscode.workspace.getConfiguration('titanForgeAI').get<number>('requestTimeout');
    if (typeof raw === 'number' && !Number.isNaN(raw) && raw > 0) {
      return raw;
    }
    return DEFAULT_TIMEOUT_MS;
  }
}
