#!/bin/sh
# Regenerates the committed 160x120 one-second placeholder. The file in
# scripts/fixtures is what the seed uploads; this script is only for rebuilding it.
set -e
out="$(dirname "$0")/fixtures/portal-test-arzo.mp4"
ffmpeg -y -f lavfi -i color=c=black:s=160x120:d=1 -f lavfi -i anullsrc=r=44100:cl=mono \
  -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 32k "$out"
ls -l "$out"
