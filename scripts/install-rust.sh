#!/bin/bash
# Install Rust toolchain with wasm32 target for CosmWasm development.
# Usage: install-rust.sh [extra-targets...]
# Default: installs stable toolchain + wasm32-unknown-unknown target.
set -euo pipefail

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl

export RUSTUP_HOME="/opt/rust/rustup"
export CARGO_HOME="/opt/rust/cargo"

echo "==> Installing Rust toolchain..."
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --default-toolchain stable --no-modify-path

export PATH="$CARGO_HOME/bin:$PATH"

echo "==> Adding wasm32-unknown-unknown target..."
rustup target add wasm32-unknown-unknown

# Add any extra targets passed as arguments
for target in "$@"; do
  echo "==> Adding target: $target"
  rustup target add "$target"
done

# Create profile.d script so all users get Rust on PATH
cat > /etc/profile.d/rust.sh << 'EOF'
export RUSTUP_HOME="/opt/rust/rustup"
export CARGO_HOME="/opt/rust/cargo"
export PATH="$CARGO_HOME/bin:$PATH"
EOF
chmod 644 /etc/profile.d/rust.sh

# Also add to node user's bashrc
echo '. /etc/profile.d/rust.sh' >> /home/node/.bashrc 2>/dev/null || true

echo "==> Rust $(rustc --version) installed with wasm32 target"
