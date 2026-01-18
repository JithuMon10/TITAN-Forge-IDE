import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { analyzeIntent } from '../../titan/intentAnalyzer';
import { ChatProvider } from '../../chatProvider';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	suite('Intent Analyzer', () => {
		test('Should detect anomaly scan intent', () => {
			const result = analyzeIntent('is there anything fishy in this code', { requestedFiles: [] });
			assert.ok(result.anomalyScan, 'Expected anomalyScan to be true');
			assert.ok(result.tasks.includes('scan_anomalies'), 'Expected scan_anomalies task');
		});

		test('Should detect suspicion bias', () => {
			const result = analyzeIntent('do you see anything unusual here?', { requestedFiles: [] });
			assert.ok(result.suspicionBias, 'Expected suspicionBias to be true');
		});

		test('Should trigger clarification question', () => {
			const result = analyzeIntent('can you help me', { requestedFiles: [] });
			assert.strictEqual(typeof result.clarificationQuestion, 'string', 'Expected a clarification question');
		});

		test('Should identify non-domain identifiers', () => {
			const code = 'const trallallero = 1; function bombardilo() {}';
			const result = analyzeIntent('review this', { requestedFiles: [{ path: 'test.ts', content: code }] });
			assert.ok(result.suspectedIdentifiers.includes('trallallero'), 'Missing trallallero');
			assert.ok(result.suspectedIdentifiers.includes('bombardilo'), 'Missing bombardilo');
		});

		test('Should identify full-sentence comments', () => {
			const code = '// This is a full sentence comment that should be detected.';
			const result = analyzeIntent('review this', { requestedFiles: [{ path: 'test.ts', content: code }] });
			assert.strictEqual(result.highlightedComments.length, 1, 'Expected one highlighted comment');
			assert.ok(result.highlightedComments[0].includes('This is a full sentence comment'), 'Comment content mismatch');
		});
	});

	suite('Chat Provider - Inline Edits', () => {
		let testFilePath: vscode.Uri;
		const originalContent = 'console.log("Hello, World!");';

		setup(async () => {
			const workspaceFolders = vscode.workspace.workspaceFolders;
			assert.ok(workspaceFolders, 'No workspace folder open');
			const workspaceRoot = workspaceFolders[0].uri.fsPath;
			testFilePath = vscode.Uri.file(path.join(workspaceRoot, 'tempTestFile.ts'));
			await vscode.workspace.fs.writeFile(testFilePath, new TextEncoder().encode(originalContent));
		});

		teardown(async () => {
			if (testFilePath) {
				try {
					await vscode.workspace.fs.delete(testFilePath);
				} catch (error) {
					// Ignore errors if the file doesn't exist
				}
			}
		});

	});
});
