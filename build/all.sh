#!/bin/sh
# Build every edition into dist/ from the NAS web app sources. Run from anywhere; needs only Python 3.
set -e
cd "$(dirname "$0")/.."
python3 build/gen_i18n.py
PYTHONPATH=build python3 build/build_demo.py
PYTHONPATH=build python3 build/build_local.py
PYTHONPATH=build python3 build/build_gas.py
PYTHONPATH=build python3 build/build_gas_files.py
