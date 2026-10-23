#!/bin/sh
# Start as root only long enough to give the app user the data volume (a volume created by
# an older, root-running image is root-owned), then drop to that user.
set -e
# Only the server drops privileges; other commands (tests, shells) run as given.
if [ "$(id -u)" = "0" ] && [ "$1" = "uvicorn" ]; then
    chown -R app:app /data 2>/dev/null || true
    exec setpriv --reuid=app --regid=app --init-groups "$@"
fi
exec "$@"
