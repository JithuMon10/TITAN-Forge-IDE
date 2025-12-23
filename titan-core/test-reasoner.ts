import { buildContext } from './contextBuilder';
import { reasonReadOnly } from './reasoner';
import { OllamaClient } from '../src/ollamaClient';
import { mockOutputChannel } from './mockOutputChannel';
import { scanWorkspace } from './scanner';

async function run(): Promise<void> {
  console.log('[reasoner] Building workspace context...');
  const rootDir = process.cwd();
  const workspaceEntries = scanWorkspace(rootDir);

  if (workspaceEntries.length === 0) {
    throw new Error('No workspace files found to build context.');
  }

  const [primaryFile] = workspaceEntries;
  const context = await buildContext({
    rootDir,
    activeFile: primaryFile.path,
    maxChars: 6000
  });

  console.log('[reasoner] Initializing Ollama client...');
  const ollama = new OllamaClient(mockOutputChannel);

  console.log('[reasoner] Asking question (thinking)...');
  const answer = await reasonReadOnly(
    ollama,
    `Summarize the purpose of ${primaryFile.path}.`,
    context
  );

  console.log('\n=== ANSWER ===\n');
  console.log(answer);
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exitCode = 1;
});
