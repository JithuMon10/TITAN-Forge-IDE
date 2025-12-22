// titan-core/reasoner.ts

import { BuildContextOutput } from "./types";
import { OllamaClient } from "../src/ollamaClient";

export async function reasonReadOnly(
  ollama: OllamaClient,
  question: string,
  context: BuildContextOutput
): Promise<string> {
  const filesText = context.files
    .map(
      f =>
        `FILE: ${f.path}\n` +
        "```\n" +
        f.content +
        "\n```"
    )
    .join("\n\n");

  const systemPrompt = `
You are TITAN Core, a read-only code intelligence engine.

Rules:
- Base answers ONLY on the provided files.
- If code has syntax or compile errors, say so clearly.
- If output is requested, simulate it honestly.
- If input is required, assume a common example.
- Do NOT suggest edits or refactors.
- Do NOT mention tools, IDEs, or VS Code.
- Do NOT ask the user to paste code.
`;

  const fullPrompt = `
${systemPrompt}

${filesText}

QUESTION:
${question}
`.trim();

  let buffer = "";

  await ollama.streamCompletion(
    { prompt: fullPrompt },
    {
      onToken(token: string) {
        buffer += token;
      },
      onError(error: Error) {
        throw error;
      },
      onEnd() {
        // REQUIRED by StreamCallbacks – nothing to do here
      }
    }
  );

  return buffer.trim();
}
