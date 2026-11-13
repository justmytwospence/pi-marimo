#!/usr/bin/env bash
# Starts Pi for the demo take. demo/record.sh copies this into the stage directory; foley types it there.
set -euo pipefail
export PI_CODING_AGENT_DIR="$PWD/.agent" XDG_CONFIG_HOME="$PWD/.config" PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 PI_HARDWARE_CURSOR=1
clear
exec pi --no-session -ne -e "$PI_MARIMO_REPO/src/index.ts" -e "$PI_MARIMO_REPO/demo/scripted-model.ts" -e "$PI_MARIMO_REPO/demo/captions.ts" --model demo/scripted -ns -np -nc --no-mcp
