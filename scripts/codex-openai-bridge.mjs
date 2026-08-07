#!/usr/bin/env node

// Compatibility entrypoint kept for the existing InkOS launcher.
// The v2 bridge prefers one persistent `codex app-server` process for lower
// startup latency and true assistant-text streaming, while retaining the
// already-proven `codex exec` path as an automatic fallback.
import "./codex-openai-bridge-v2.mjs";
