#!/bin/bash
# PulseAudio Setup for Translator Agent
# Run this script on Ubuntu 24.04 VM before starting the translator agent

set -e

SINK_NAME="translator_sink"
SINK_DESC="Translator_Audio_Sink"

echo "=== Translator Agent PulseAudio Setup ==="

# Check if PulseAudio is installed
if ! command -v pactl &> /dev/null; then
    echo "Installing PulseAudio..."
    sudo apt-get update
    sudo apt-get install -y pulseaudio pulseaudio-utils
fi

# Start PulseAudio if not running
if ! pulseaudio --check 2>/dev/null; then
    echo "Starting PulseAudio..."
    pulseaudio --start
    sleep 1
fi

# Check if sink already exists
if pactl list short sinks | grep -q "$SINK_NAME"; then
    echo "✓ Sink '$SINK_NAME' already exists"
else
    echo "Creating virtual sink '$SINK_NAME'..."
    pactl load-module module-null-sink sink_name=$SINK_NAME sink_properties=device.description=$SINK_DESC
    echo "✓ Virtual sink created"
fi

# Verify sink and monitor
echo ""
echo "=== Verification ==="
echo "Sinks:"
pactl list short sinks | grep -E "(translator|default)" || true

echo ""
echo "Sources (monitors):"
pactl list short sources | grep -E "(translator|monitor)" || true

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Chrome will output to: $SINK_NAME"
echo "Agent will capture from: ${SINK_NAME}.monitor"
echo ""
echo "To make this persist across reboots, add to /etc/pulse/default.pa:"
echo "  load-module module-null-sink sink_name=$SINK_NAME sink_properties=device.description=$SINK_DESC"
