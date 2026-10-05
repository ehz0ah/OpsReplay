#!/bin/sh
set -eu

# No ports, host mounts, Docker socket, or internet route. One local practice container.
exec docker run --detach --name "${1:?Usage: run-local.sh NAME [IMAGE]}" \
    --hostname storefront --network none --cpus 1 --memory 2g --memory-swap 2g --pids-limit 128 \
    --security-opt no-new-privileges=true \
    --cap-drop NET_RAW --cap-drop MKNOD --cap-drop AUDIT_WRITE \
    --cap-drop SETFCAP --cap-drop SETPCAP --cap-drop SYS_CHROOT --cap-drop FSETID \
    --label opsreplay.local-challenge=wrong-upstream-port \
    "${2:-opsreplay/challenge-wrong-upstream-port:dev}"
