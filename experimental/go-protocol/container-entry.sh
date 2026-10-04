#!/bin/sh
# Fail closed unless cgroup v2 enforces the exact common experiment envelope.
set -eu
test "$(cat /sys/fs/cgroup/cpu.max)" = "100000 100000"
test "$(cat /sys/fs/cgroup/memory.max)" = "268435456"
test "$(cat /sys/fs/cgroup/memory.swap.max)" = "0"
test "$(cat /sys/fs/cgroup/pids.max)" = "64"
test "$(id -u)" = "65534"
grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/self/status
grep -q '^CapEff:[[:space:]]*0000000000000000$' /proc/self/status
awk '$2 == "/" && $4 ~ /(^|,)ro(,|$)/ { found=1 } END { exit !found }' /proc/mounts
awk '$2 == "/tmp" && $3 == "tmpfs" && $4 ~ /(^|,)noexec(,|$)/ && $4 ~ /(^|,)nosuid(,|$)/ { found=1 } END { exit !found }' /proc/mounts
case "$1" in
  go) exec /app/mockchat ;;
  node) exec node /app/node-mockchat.mjs /app/oracle/src/server.mjs ;;
  mock) exec node /app/container-mock.mjs ;;
  *) exit 2 ;;
esac
