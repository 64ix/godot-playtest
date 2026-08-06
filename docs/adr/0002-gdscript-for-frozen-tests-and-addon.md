# GDScript for frozen tests and the addon core

Frozen tests are written in **GDScript** so they live in the target Godot
project, remain readable in the Godot editor, and replay through
`godot --headless` without a foreign test runtime.

The addon core is also written in GDScript. A C# addon would only load on .NET
builds of Godot and would exclude standard builds at installation time. C#
projects can use a thin typed wrapper around `Call` and `Get` calls to the
autoload.

A first-class C# API with guaranteed parity is deferred until the core protocol
stabilizes; maintaining two public surfaces during v0 would add premature
compatibility obligations.
