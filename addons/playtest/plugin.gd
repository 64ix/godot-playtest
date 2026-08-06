@tool
extends EditorPlugin
## Enables/disables the TestBridge autoload from Project Settings > Plugins.
## Editor equivalent of the manual autoload addition described in the
## addon's README; both paths are supported.

const AUTOLOAD_NAME := "TestBridge"
const AUTOLOAD_PATH := "res://addons/playtest/bridge.gd"

func _enable_plugin() -> void:
	add_autoload_singleton(AUTOLOAD_NAME, AUTOLOAD_PATH)

func _disable_plugin() -> void:
	remove_autoload_singleton(AUTOLOAD_NAME)
