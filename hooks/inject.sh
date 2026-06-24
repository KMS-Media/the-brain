#!/bin/sh
# Wrapper so that native Kuzu/ONNX destructor crashes (libc++abi: mutex lock
# failed) don't propagate as a non-zero exit code to Claude Code.
node "${CLAUDE_PLUGIN_ROOT}/dist/hooks/inject.js"
exit 0
