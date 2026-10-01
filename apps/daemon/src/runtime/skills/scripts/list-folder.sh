#!/bin/bash
# Files of the folder $SRC as `<size>\t<octal mode>\t<relative path>`, without VCS and dependency folders.
cd -- "$SRC" && find . \( -name .git -o -name node_modules -o -name __pycache__ -o -name .venv -o -name .DS_Store \) \
  -prune -o -type f -printf '%s\t%m\t%P\n'
