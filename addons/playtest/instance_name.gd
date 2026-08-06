## Instance name validation (spec #66) — the GDScript surface's naming site:
## `PlaytestCase.attach_instance(name)` (playtestcase.gd/playtest_client.gd).
## Mirrors `mcp-server/src/instance-name.ts`'s identical rule (that module is
## the MCP surface's naming site, `launch_game`/`attach`'s `instance`
## field) so that a name legal on one driver is legal on the other, and
## Freeze — which reuses whatever name the live session used — never emits
## a `var <name> := await attach_instance("<name>")` declaration that fails
## to parse.
##
## Unlike the MCP surface, where `"default"` addresses/replaces the
## built-in default slot (instance 0) and is always legal, `attach_instance`
## on the GDScript surface never mints instance 0 (that's `self`, always) —
## so here `"default"` is rejected, not merely reserved.
class_name PlaytestInstanceName
extends RefCounted

## Kept in sync with mcp-server/src/instance-name.ts's identical list
## (reference: GDScript 2.0 "Keywords" table, Godot 4 docs). Keywords that
## are already uppercase (PI, TAU, INF, NAN, ...) never match the pattern
## below, so they need no entry here.
const RESERVED_KEYWORDS := [
	"if", "elif", "else", "for", "while", "match", "break", "continue", "pass",
	"return", "class", "class_name", "extends", "is", "in", "as", "self",
	"signal", "func", "static", "const", "enum", "var", "breakpoint", "preload",
	"await", "yield", "assert", "void", "and", "or", "not", "true", "false",
	"null", "super",
]

## Returns `""` if `name` is a legal `attach_instance` name, or a
## human-readable reason otherwise.
static func validate(name: String) -> String:
	if name == "default":
		return "'default' is reserved: instance 0 is 'self', attach_instance never mints it"
	var regex := RegEx.new()
	regex.compile("^[a-z][a-z0-9_]*$")
	if regex.search(name) == null:
		return "must match ^[a-z][a-z0-9_]*$"
	if RESERVED_KEYWORDS.has(name):
		return "'%s' is a reserved GDScript keyword" % name
	return ""
