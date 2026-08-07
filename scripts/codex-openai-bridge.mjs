#!/usr/bin/env node

// Stable entrypoint used by the InkOS launcher.
// v3 runs Codex app-server as a persistent process, strips coding-agent overhead
// for text-only fiction work, uses low/none reasoning for latency, exposes
// diagnostics, and keeps the proven codex exec path as a fallback.
import "./codex-openai-bridge-v3.mjs";
