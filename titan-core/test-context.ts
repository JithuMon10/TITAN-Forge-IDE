import { promises as fs } from 'fs';
import * as path from 'path';
import { buildContext } from './contextBuilder';
import { scanWorkspace } from './scanner';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const FIXTURE_FILES = ['titan-core/fixtures/sample.pdf', 'titan-core/fixtures/sample.docx'];

async function run(): Promise<void> {
  const rootDir = process.cwd();
  const workspaceEntries = scanWorkspace(rootDir);

  if (workspaceEntries.length === 0) {
    console.error('No workspace files found. Add some files and rerun the test.');
    return;
  }

  const [activeEntry, ...rest] = workspaceEntries;
  const requestedFromScan = rest.slice(0, 4).map((entry) => entry.path);
  const requestedFiles = Array.from(new Set([...requestedFromScan, ...FIXTURE_FILES]));

  await ensureProtectedPathRequiresOverride(rootDir, activeEntry.path);

  const overrideResult = await buildContextWithOverride(rootDir, activeEntry.path);
  const [overrideFile] = overrideResult.files;
  assert(overrideFile, 'Override build did not include the active file.');
  assert(
    overrideFile.source === 'editor',
    `Expected override source to be "editor", received "${overrideFile.source}".`
  );
  assert(
    overrideFile.version === 999,
    `Expected override version metadata to be preserved. Received ${overrideFile.version ?? 'undefined'}.`
  );
  assert(
    typeof overrideFile.capturedAt === 'number',
    'Expected override capturedAt metadata to be preserved as a timestamp.'
  );

  const context = await buildContext({
    rootDir,
    activeFile: activeEntry.path,
    requestedFiles,
    maxChars: 8000
  });

  console.log('--- CONTEXT RESULT ---');
  console.log('Active file:', activeEntry.path);
  if (requestedFiles.length > 0) {
    console.log('Requested files:', requestedFiles.join(', '));
  }
  console.log('Files included:');
  for (const file of context.files) {
    console.log('-', file.path, `(type=${file.type}, chars=${file.content.length})`);
  }
  console.log('Truncated:', context.truncated);
  console.log('Total chars:', context.totalChars);

  for (const fixture of FIXTURE_FILES) {
    const found = context.files.some((file) => file.path === fixture);
    console.log(found ? `[OK] Included ${fixture}` : `[MISS] Missing ${fixture}`);
  }
}

async function ensureProtectedPathRequiresOverride(rootDir: string, activePath: string): Promise<void> {
  let refused = false;
  try {
    await buildContext({
      rootDir,
      activeFile: activePath,
      protectedPaths: [activePath]
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('must be provided as an override') ||
      message.includes('Editor buffer')
    ) {
      refused = true;
    } else {
      throw error;
    }
  }

  assert(
    refused,
    'buildContext unexpectedly read a protected file from disk without a live override.'
  );
}

async function buildContextWithOverride(rootDir: string, activePath: string) {
  const absolutePath = path.join(rootDir, activePath);
  const content = await fs.readFile(absolutePath, 'utf8');
  const overrideCapturedAt = Date.now();

  return await buildContext({
    rootDir,
    activeFile: activePath,
    overrides: [
      {
        path: activePath,
        content,
        type: 'code',
        version: 999,
        capturedAt: overrideCapturedAt
      }
    ],
    protectedPaths: [activePath],
    maxChars: content.length + 10
  });
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exitCode = 1;
});
