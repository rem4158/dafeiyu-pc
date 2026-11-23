"""Isolated right-click layout and Qt editor checks, using no desktop settings."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

os.environ["QT_QPA_PLATFORM"] = "offscreen"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "desktop"))

from PySide6.QtWidgets import QApplication, QMessageBox
from pet.context_menus.registry import MENU_ACTIONS
from pet.menu_layout import load_default_menu_layout, merge_default_menu_actions, resolve_menu_layout
from pet.settings_menu_layout_editor import MenuLayoutEditor


def resolve(layout):
    return resolve_menu_layout(
        layout, registered_actions=MENU_ACTIONS.ids, available_actions=MENU_ACTIONS.ids
    )


class MenuLayoutEditorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def test_default_editor_round_trip(self):
        template = load_default_menu_layout()
        editor = MenuLayoutEditor(None)
        self.assertEqual(editor.value()["nodes"], template["nodes"])
        self.assertEqual(resolve(None).nodes, resolve(editor.value()).nodes)
        self.assertEqual(resolve(None).diagnostics, ())
        music = editor.item_for_action("music_open_soda").parent()
        self.assertEqual(music.text(0), "音乐")
        self.assertEqual(music.parent().text(0), "日常工具")

    def test_edit_and_remove_nested_group(self):
        editor = MenuLayoutEditor(None)
        source = editor.item_for_action("chat")
        editor.tree.setCurrentItem(source)
        editor._rebuild_move_menu()
        music_target = next(action for action in editor.move_menu.actions() if action.data() == "music")
        self.assertIn("日常工具", music_target.text())
        music_target.trigger()
        self.assertEqual(source.parent().text(0), "音乐")
        editor.set_item_alias("chat", "我的聊天")
        saved = editor.value()
        editor.set_layout(saved)
        self.assertEqual(editor.value(), saved)
        source = editor.item_for_action("chat")
        self.assertTrue(source.text(0).startswith("我的聊天"))
        music = source.parent()
        daily = music.parent()
        editor.tree.setCurrentItem(music)
        with patch.object(QMessageBox, "question", return_value=QMessageBox.StandardButton.Yes):
            editor._delete_selected_submenu()
        self.app.processEvents()
        self.assertIs(editor.item_for_action("chat").parent(), daily)
        self.assertIs(editor.item_for_action("music_open_soda").parent(), daily)
        self.assertNotEqual(resolve(editor.value()).source, "fallback")

    def test_missing_actions_fill_existing_personal_group(self):
        hidden = {"type": "action", "id": "music_next", "visible": False, "alias": "个人切歌"}
        existing = {"type": "submenu", "id": "music", "label": "音乐", "alias": "我的音乐",
                    "visible": False, "children": [hidden]}
        chat = {"type": "action", "id": "chat", "alias": "旧称"}
        original_nodes = [chat, existing, {"type": "action", "id": "modern_settings"},
                          {"type": "action", "id": "quit"}]
        old = {"schema_version": 1, "layout_id": "user", "nodes": original_nodes}
        merged, _ = merge_default_menu_actions(old, registered_actions=MENU_ACTIONS.ids)
        self.assertEqual(len(old["nodes"][1]["children"]), 1)
        root = merged["nodes"]
        music = next(node for node in root if node["id"] == "music")
        self.assertLess(root.index(chat), root.index(music))
        self.assertEqual(music["alias"], "我的音乐")
        self.assertFalse(music["visible"])
        self.assertIn(hidden, music["children"])
        self.assertIn("music_open_soda", [node["id"] for node in music["children"]])
        daily = next(node for node in root if node.get("label") == "日常工具")
        self.assertNotIn("music", [node["id"] for node in daily["children"]])
        self.assertEqual(resolve(merged).diagnostics, ())

    def test_reject_fourth_level(self):
        node = {"type": "action", "id": "chat"}
        for group in ("third", "second", "first"):
            node = {"type": "submenu", "id": group, "children": [node]}
        result = resolve({"schema_version": 1, "layout_id": "user", "nodes": [node]})
        self.assertEqual(result.source, "fallback")
        self.assertIn("submenu-depth-exceeded:third", result.diagnostics)

    def test_retired_group_keeps_personal_shortcuts_hidden(self):
        old = {"schema_version": 1, "layout_id": "user", "nodes": [
            {"type": "submenu", "id": "screen_and_agents", "visible": False, "children": [
                {"type": "action", "id": "agent_link"},
                {"type": "action", "id": "proactive_screen"},
                {"type": "action", "id": "agent_cost"},
                {"type": "action", "id": "screen_capture", "alias": "手动问图"}
            ]}
        ]}
        editor = MenuLayoutEditor(old)
        for action_id in ("agent_link", "proactive_screen", "agent_cost"):
            self.assertIsNone(editor.item_for_action(action_id))
        saved = editor.value()
        remaining = next(node for node in saved["nodes"] if node["id"] == "screen_capture")
        self.assertEqual(remaining["alias"], "手动问图")
        self.assertFalse(remaining["visible"])
        self.assertFalse(any(node["id"] == "screen_and_agents" for node in saved["nodes"]))


if __name__ == "__main__":
    unittest.main()
