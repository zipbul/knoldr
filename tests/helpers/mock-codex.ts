#!/usr/bin/env bun
/**
 * Mock Codex CLI for testing.
 * Reads -p prompt from argv and returns a JSON decomposition.
 * Supports MOCK_CODEX_HANDLER env var for custom responses:
 *   "default"    → single entry decomposition
 *   "multi"      → two entries
 *   "empty"      → empty entries array
 *   "fail"       → exit code 1
 *   "bad-json"   → invalid JSON output
 *   "language:XX" → returns language code XX
 */

const argv = process.argv.slice(2);

// Check if this is a language detection call (short prompt starting with language detection instruction)
const promptIdx = argv.indexOf("-p");
const inputPrompt = promptIdx >= 0 ? argv[promptIdx + 1] ?? "" : "";
const isLanguageDetection = inputPrompt.startsWith("What is the ISO 639-1");

const handler = process.env.MOCK_CODEX_HANDLER ?? "default";

if (handler === "fail") {
  console.error("Mock Codex CLI: simulated failure");
  process.exit(1);
}

if (handler === "bad-json") {
  console.log("this is not valid json {{{");
  process.exit(0);
}

if (isLanguageDetection || handler.startsWith("language:")) {
  const lang = handler.startsWith("language:") ? handler.slice(9) : "en";
  console.log(JSON.stringify(lang));
  process.exit(0);
}

if (handler === "empty") {
  console.log(JSON.stringify({ entries: [] }));
  process.exit(0);
}

if (handler === "multi") {
  console.log(JSON.stringify({
    entries: [
      { title: "Entry 1", content: "First topic", domain: ["tech"], tags: [], language: "en", decayRate: 0.01 },
      { title: "Entry 2", content: "Second topic", domain: ["tech"], tags: [], language: "en", decayRate: 0.02 },
    ],
  }));
  process.exit(0);
}

// Default: single entry
console.log(JSON.stringify({
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
}));
process.exit(0);
