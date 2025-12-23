import { readDocument } from './reader';

async function inspect(relativePath: string): Promise<void> {
  const result = await readDocument(process.cwd(), relativePath);

  if (!result) {
    console.log(`[SKIP] Could not read ${relativePath}`);
    return;
  }

  console.log(`\n=== ${relativePath} ===`);
  console.log('Path:', result.path);
  console.log('Type:', result.type);
  console.log('Truncated:', result.truncated);
  console.log('Content preview:');
  console.log(result.text.slice(0, 200));
}

async function run(): Promise<void> {
  const targets = [
    'titan-core/fixtures/sample.pdf',
    'titan-core/fixtures/sample.docx'
  ];

  for (const target of targets) {
    await inspect(target);
  }
}

run().catch((error) => {
  console.error('Test failed:', error);
  process.exitCode = 1;
});
