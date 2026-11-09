#!/bin/sh
set -eu
if [ "${LOCAL_DEV_PASSWORD_ONLY:-false}" != "false" ]; then
  echo "Password-only development mode is unavailable on Heroku" >&2
  exit 1
fi
case "${SERVICE_NAME:-}" in
  auth) module=services.auth.main ;;
  admin) module=services.admin.main ;;
  orchestrator) module=services.orchestrator.main ;;
  ddg_mcp) module=services.ddg_mcp.main ;;
  *) echo 'Invalid SERVICE_NAME' >&2; exit 1 ;;
esac
exec uvicorn "$module:app" --host 0.0.0.0 --port "${PORT:?PORT is required}" --no-access-log --no-proxy-headers
