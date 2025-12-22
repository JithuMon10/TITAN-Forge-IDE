// titan-core/mockOutputChannel.ts

import { Output } from './output';

export const mockOutputChannel: Output = {
  appendLine(value: string) {
    console.log('[ollama]', value);
  }
};
