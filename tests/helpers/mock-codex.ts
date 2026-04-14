#!/usr/bin/env bun
/**
 * Mock Codex CLI for testing.
 *
 * Shape matches the real `codex exec --skip-git-repo-check [-m MODEL] - -o FILE`
 * invocation used by src/llm/cli.ts: prompt arrives on stdin and the
 * response is written to the file passed with `-o`.
 *
 * MOCK_CODEX_HANDLER env var selects the response:
 *   "default"     → single-entry decomposition
 *   "multi"       → two entries
 *   "empty"       → empty entries array
 *   "fail"        → exit code 1
 *   "bad-json"    → invalid JSON payload
 *   "language:XX" → language-detection response
 */

import { writeFile } from "fs/promises";

const argv = process.argv.slice(2);
const oIdx = argv.indexOf("-o");
const outFile = oIdx >= 0 ? argv[oIdx + 1] : null;

// Read full stdin
const chunks: Buffer[] = [];
for await (const chunk of Bun.stdin.stream()) {
  chunks.push(Buffer.from(chunk));
}
const prompt = Buffer.concat(chunks).toString("utf8");

const handler = process.env.MOCK_CODEX_HANDLER ?? "default";

async function emit(payload: string) {
  if (outFile) {
    await writeFile(outFile, payload);
  } else {
    console.log(payload);
  }
}

if (handler === "fail") {
  console.error("Mock Codex CLI: simulated failure");
  process.exit(1);
}

if (handler === "bad-json") {
  await emit("this is not valid json {{{");
  process.exit(0);
}

// detectLanguage's prompt always starts with "What is the ISO 639-1".
// Decompose's SYSTEM_PROMPT also references ISO 639-1 (inside the language
// rule for each entry), so a substring check over the whole prompt
// matches the wrong caller. Pin the detection to the prompt prefix.
const isLanguageDetection = prompt
  .trimStart()
  .startsWith("What is the ISO 639-1");
if (isLanguageDetection || handler.startsWith("language:")) {
  const lang = handler.startsWith("language:") ? handler.slice(9) : "en";
  await emit(JSON.stringify(lang));
  process.exit(0);
}

if (handler === "empty") {
  await emit(JSON.stringify({ entries: [] }));
  process.exit(0);
}

if (handler === "multi") {
  await emit(
    JSON.stringify({
      entries: [
        { title: "Entry 1", content: "First topic", domain: ["tech"], tags: [], language: "en", decayRate: 0.01 },
        { title: "Entry 2", content: "Second topic", domain: ["tech"], tags: [], language: "en", decayRate: 0.02 },
      ],
    }),
  );
  process.exit(0);
}

// Default: single entry
await emit(
  JSON.stringify({
    entries: [
      {
        title: "Test Entry",
        content: "This is test content from LLM decomposition.",
        domain: ["testing"],
        tags: ["unit-test"],
        language: "en",
        decayRate: 0.01,
      },
    ],
  }),
);
process.exit(0);
