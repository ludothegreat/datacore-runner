#!/bin/bash
# usage: gen.sh <slug> <prompt-file>
# One Codex imagegen job. Codex cannot write into the workspace, so the image is
# pulled from the path Codex reports. No "newest file" fallback: in parallel runs
# that copies another job's image.
set -u
cd "$(dirname "$0")" || exit 1
slug="$1"; body="$(cat "$2")"
out="./${slug}.png"; log="logs/${slug}.log"
prompt="Use the imagegen skill to generate ONE image. ${body} Save the final image to ${out} and report the full saved path."
# Serialize jobs: in a parallel batch Codex itself "finds" its image by newest
# mtime under ~/.codex/generated_images and reported another job's file (2026-11-24).
exec 9>logs/.lock; flock 9
echo "[$(date +%T)] start $slug" >> logs/run.log
timeout --kill-after=10 420 codex exec --skip-git-repo-check "$prompt" </dev/null >"$log" 2>&1
rc=$?
if [ ! -f "$out" ]; then
  src=$(grep -o "$HOME"'/.codex/generated_images/[^][ `()]*\.png' "$log" | tail -1)
  if [ -n "$src" ] && [ -f "$src" ]; then cp "$src" "$out"; else echo "[$(date +%T)] FAIL $slug: no image path in $log" >> logs/run.log; fi
fi
echo "[$(date +%T)] done  $slug rc=$rc exists=$([ -f "$out" ] && echo yes || echo no)" >> logs/run.log
