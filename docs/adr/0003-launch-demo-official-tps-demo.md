# Dogfooding demo: the official Godot TPS demo

The end-to-end dogfooding target is **godotengine/tps-demo**. It is public and
complex enough to exercise 3D input, dynamic nodes, domain state, physics
synchronization, and deterministic Freeze replay without introducing a private
dependency.

The demo is materialized locally by `dogfooding/setup-tps-demo.sh`; its large
assets are never committed. The repository stores only the instrumentation
patch and frozen scenarios.

Accepted cost: the first asset import is heavy and 3D physics requires careful
synchronization.
