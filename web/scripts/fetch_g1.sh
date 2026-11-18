#!/usr/bin/env bash
# Fetch the Unitree G1 description (MJCF) from MuJoCo Menagerie at a pinned commit, and link it
# into the page's public folder.  The model is BSD-3-Clause (Unitree Robotics); it is downloaded,
# not included in this repository.  About 34 MB.
set -euo pipefail
PIN="370c43965323c0944b433b202aac5058b5f907a9"
WEB="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$WEB/third_party/mujoco_menagerie"
if [ -f "$DEST/unitree_g1/g1.xml" ]; then
  echo "already present: $DEST/unitree_g1"
else
  rm -rf "$DEST" && mkdir -p "$DEST" && cd "$DEST"
  git init -q && git remote add origin https://github.com/google-deepmind/mujoco_menagerie.git
  git sparse-checkout init --cone && git sparse-checkout set unitree_g1
  git fetch -q --depth 1 --filter=blob:none origin "$PIN" && git checkout -q FETCH_HEAD
  echo "fetched unitree_g1 at $PIN"
fi
ln -sfn ../third_party/mujoco_menagerie/unitree_g1 "$WEB/public/g1"
echo "linked $WEB/public/g1"
