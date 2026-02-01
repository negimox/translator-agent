#!/bin/bash
# Setup script for Chrome dependencies and PulseAudio on Ubuntu 24.04
# Run with: sudo ./scripts/setup-ubuntu.sh

set -e

echo "=== Translator Agent Ubuntu Setup ==="
echo ""

# Check if running as root for apt commands
if [ "$EUID" -ne 0 ]; then
    echo "Please run with sudo: sudo ./scripts/setup-ubuntu.sh"
    exit 1
fi

# Get the actual user (not root) for npm commands later
ACTUAL_USER=${SUDO_USER:-$USER}

echo "=== Step 1: Installing Chrome dependencies ==="
apt-get update
apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libasound2t64 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc-s1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils

echo "✓ Chrome dependencies installed"

echo ""
echo "=== Step 2: Installing PulseAudio ==="
apt-get install -y pulseaudio pulseaudio-utils

echo "✓ PulseAudio installed"

echo ""
echo "=== Step 3: Setting up virtual audio sink ==="
# Switch to actual user for pulseaudio commands
sudo -u $ACTUAL_USER bash << 'EOF'
# Start PulseAudio if not running
if ! pulseaudio --check 2>/dev/null; then
    pulseaudio --start --daemonize
    sleep 1
fi

# Create virtual sink if it doesn't exist
if ! pactl list short sinks | grep -q "translator_sink"; then
    pactl load-module module-null-sink sink_name=translator_sink sink_properties=device.description=Translator_Audio_Sink
    echo "✓ Virtual sink created"
else
    echo "✓ Virtual sink already exists"
fi
EOF

echo ""
echo "=== Step 4: Verifying setup ==="
sudo -u $ACTUAL_USER pactl list short sinks | grep translator || echo "Warning: translator_sink not found"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "You can now run the translator agent:"
echo "  npm start"
echo ""
echo "If you see Chrome browser errors, you may need to run:"
echo "  npx puppeteer browsers install chrome"
