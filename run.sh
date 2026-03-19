#!/bin/bash
# ProtectionPro — Start the development server
# Usage: ./run.sh

echo "Starting ProtectionPro..."
echo "Installing dependencies..."
pip install -r backend/requirements.txt --quiet

echo ""
echo "Starting server at http://localhost:8000"
echo "Press Ctrl+C to stop."
echo ""

cd "$(dirname "$0")"
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload
