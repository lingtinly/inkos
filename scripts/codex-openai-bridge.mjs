#!/usr/bin/env node

// Stable entrypoint used by the InkOS launcher.
// v4 prewarms the official Codex app-server stdio transport, keeps the
// fiction/text-only instruction profile lightweight, records exact app-server
// failures in /diagnostics, and retains codex exec as a safe fallback.
import "./codex-openai-bridge-v4.mjs";
