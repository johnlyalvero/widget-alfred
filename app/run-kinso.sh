#!/usr/bin/env bash
# Launches Kinso (Widget Alfred) directly, without going through npm.
# Used by the desktop launcher and autostart entry.
cd "$(dirname "$0")" || exit 1
exec ./node_modules/.bin/electron . --no-sandbox
