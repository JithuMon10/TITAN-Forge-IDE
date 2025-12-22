import { buildContext } from './contextBuilder';
import { scanWorkspace } from './scanner';

async function run(): Promise<void> {
  const rootDir = process.cwd();
  const workspaceEntries = scanWorkspace(rootDir);

  if (workspaceEntries.length === 0) {
    console.error('No workspace files found. Add some files and rerun the test.');
    return;
  }

  const [activeEntry, ...rest] = workspaceEntries;
  const requestedFiles = rest.slice(0, 4).map((entry) => entry.path);

  const context = buildContext({
    rootDir,
    activeFile: activeEntry.path,
    requestedFiles,
    maxChars: 8000
  });

  const totalChars = context.files.reduce((sum, file) => sum + file.content.length, 0);

  console.log('--- CONTEXT RESULT ---');
  console.log('Active file:', activeEntry.path);
  if (requestedFiles.length > 0) {
    console.log('Requested files:', requestedFiles.join(', '));
  }
  console.log('Files included:');
  for (const file of context.files) {
    console.log('-', file.path, `(chars=${file.content.length})`);
  }
  console.log('Truncated:', context.truncated);
  console.log('Total chars:', totalChars);
}

run().catch((err) => {
  console.error('Test failed:', err);
});
