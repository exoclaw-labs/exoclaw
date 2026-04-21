#!/usr/bin/env bash
# exoclawctl — shim that invokes the compiled CLI via Node.
# Installed at /usr/local/bin/exoclawctl.
exec /usr/local/bin/node /app/dist/supervisor/cli.js "$@"
