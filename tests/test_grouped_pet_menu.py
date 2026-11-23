"""Exercise the actual Qt right-click menu with an in-memory desktop pet."""
import os
from pathlib import Path
import sys
import unittest
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
os.environ["QT_QPA_PLATFORM"] = "offscreen"
sys.path.insert(0, str(ROOT / "desktop"))

from PySide6.QtCore import QPoint
from PySide6.QtGui import QFontDatabase, QPixmap
from PySide6.QtWidgets import QApplication, QMenu

from pet.context_menus import build_modern_menu
from pet.context_menus.menu_styles.modern import apply_modern_menu_style
from pet.context_menus.shared import release_menu_tree, take_deferred_menu_callbacks


class MenuConfig(dict):
    set = dict.__setitem__

    def save(self):
        pass


def make_pet():
    config = MenuConfig(
        music_lyric_enabled=True,
        weather_enabled=True,
        weather_city_list=["北京", "上海"],
        weather_city="北京",
        weather_city_codes={"北京": "a", "上海": "b"},
        quick_launch_apps=[{"name": "浏览器", "kind": "default_browser"}],
        agent_link={"dsh": True, "custom_agents": [{"name": "测试 Agent", "key": "test_agent"}]},
        proactive_screen={"enabled": True},
    )
    callbacks = """
        on_open_chat on_screen_capture on_open_modern_settings on_open_todo_panel
        on_show_weather on_divination_draw on_check_update on_show_balance
        on_network_info on_spawn_pet on_clear_spawned_pets trigger_golden_spin
        request_switch_character trigger_move switch_clip go_default_corner hide request_quit
    """.split()
    return SimpleNamespace(
        cfg=config, playback_speed=1.0, scale=1.0, no_move=False, drag_physics=False,
        icon_pixmap=lambda size: QPixmap(), idles=["站立"], turns=["转身"], moves=["向右"],
        clicks=["眨眼"], acts=[f"{family}-{i}" for family in ("休息", "工作") for i in range(16)],
        **{name: Mock(name=name) for name in callbacks},
    )


def paths(menu, prefix=()):
    """Open lazy animation categories just as hovering the real menu does."""
    for action in menu.actions():
        if action.isSeparator():
            continue
        path = (*prefix, action.text())
        yield path, action
        sub = action.menu()
        if sub is not None:
            sub.aboutToShow.emit()
            yield from paths(sub, path)


@unittest.skipUnless(sys.platform == "win32", "desktop menu has Windows-only actions")
class GroupedPetMenu(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])
        # Windows' offscreen plugin starts with an empty font database.
        font = Path(os.environ["WINDIR"]) / "Fonts" / "msyh.ttc"
        if font.is_file():
            QFontDatabase.addApplicationFont(str(font))

    def setUp(self):
        self.pet = make_pet()
        for target, value in (
            ("pet.context_menus.shared.autostart_mod.is_enabled", False),
            ("pet.context_menus.shared.catalog.list_available_characters", ["测试角色"]),
            ("pet.context_menus.shared.catalog.character_display_name", "测试角色"),
            ("pet.music_players.cached_player", ("found", "test-player")),
        ):
            substitute = patch(target, return_value=value)
            substitute.start()
            self.addCleanup(substitute.stop)

    def build(self):
        menu = QMenu()
        apply_modern_menu_style(menu, {"theme": "light"})
        build_modern_menu(menu, self.pet)
        self.addCleanup(release_menu_tree, menu)
        return menu

    def test_groups_and_callbacks(self):
        menu = self.build()
        self.assertEqual([a.text() for a in menu.actions() if not a.isSeparator()], [
            "聊一聊", "角色与动画", "日常工具", "桌宠管理", "桌宠设置", "退出",
        ])
        tree = dict(paths(menu))
        screenshots = os.environ.get("DAFEIYU_MENU_QA_SCREENSHOTS")
        if screenshots:
            output = Path(screenshots)
            output.mkdir(parents=True, exist_ok=True)
            for name, widget in (("root", menu), ("daily", tree["日常工具",].menu())):
                widget.adjustSize()
                self.assertTrue(widget.grab().save(str(output / f"{name}.png")))

        for path, callback in (
            (("聊一聊",), self.pet.on_open_chat),
            (("日常工具", "截图提问"), self.pet.on_screen_capture),
        ):
            self.assertEqual([name for name in tree if name[-1] == path[-1]], [path])
            action = tree[path]
            menu.popup(QPoint(20, 20))
            if action.parent() is not menu:
                action.parent().popup(QPoint(220, 20))
            self.app.processEvents()
            action.trigger()
            callback.assert_not_called()
            pending = take_deferred_menu_callbacks(menu)
            self.assertEqual(len(pending), 1)
            pending[0]()
            callback.assert_called_once_with()
            action.parent().close()
            menu.close()

    def test_depth_and_dynamic_choices(self):
        with patch.dict(os.environ, {"DAFEIYU_PC_ROOT": str(ROOT)}):
            tree = dict(paths(self.build()))
        self.assertEqual([p for p in tree if len(p) > 3], [])
        for name in self.pet.idles + self.pet.turns + self.pet.moves + self.pet.clicks + self.pet.acts:
            matching = [p for p in tree if p[0] == "角色与动画" and p[-1] == name]
            self.assertEqual(len(matching), 1, name)
            self.assertEqual(len(matching[0]), 3)
        next(action for path, action in tree.items() if path[-1] == "工作-1").trigger()
        self.pet.switch_clip.assert_called_once_with("工作-1")
        self.assertTrue({"识屏与联动", "Agent 联动", "主动识屏", "显示本轮消费", "测试 Agent"}
                        .isdisjoint(path[-1] for path in tree))
        music = [path[-1] for path in tree if path[:2] == ("日常工具", "音乐") and len(path) == 3]
        self.assertEqual(sum("歌词" in name for name in music), 5)
        self.assertEqual(sum("放歌" in name for name in music), 4)
        self.assertEqual(len(music), 13)
        help_items = [path[-1] for path in tree if path[:2] == ("桌宠管理", "工具与帮助")]
        self.assertEqual(sum("DSH" in name for name in help_items), 4)
        for label in ("厉害了我的鲸", "网络信息", "GitHub 项目页", "DeepSeek 余额"):
            self.assertIn(label, help_items)
        self.assertNotIn("检查更新", help_items)

        cities = ("日常工具", "天气城市")
        self.assertTrue(tree[*cities, "北京"].isChecked())
        self.assertIn((*cities, "添加城市…"), tree)
        remove, = [a for p, a in tree.items() if p[:2] == cities and "删除" in p[-1]]
        with patch("pet.weather_menu.QInputDialog.getItem", return_value=("北京", False)):
            remove.trigger()
        self.assertEqual(self.pet.cfg["weather_city_list"], ["北京", "上海"])
        with patch("pet.weather_menu.QInputDialog.getItem", return_value=("北京", True)):
            remove.trigger()
        self.assertEqual(self.pet.cfg["weather_city_list"], ["上海"])
        self.assertEqual(self.pet.cfg["weather_city"], "上海")
        self.assertEqual(self.pet.cfg["weather_city_codes"], {"上海": "b"})

    def test_saved_layout_keeps_parent_alias_and_hidden_action(self):
        layout = {
            "schema_version": 1, "layout_id": "user",
            "nodes": [
                {"type": "submenu", "id": "screen_and_agents", "label": "识屏与联动", "children": [
                    {"type": "action", "id": "agent_link", "alias": "旧联动"},
                    {"type": "action", "id": "proactive_screen", "alias": "旧识屏"},
                ]},
                {"type": "submenu", "id": "my_tools", "label": "我的入口", "children": [
                    {"type": "action", "id": "screen_capture", "alias": "选区提问"},
                    {"type": "action", "id": "chat", "alias": "随便聊聊"},
                ]},
                {"type": "action", "id": "weather", "visible": False},
                {"type": "action", "id": "modern_settings"},
                {"type": "action", "id": "quit"},
            ],
        }
        self.pet.cfg["context_menu_layout"] = deepcopy(layout)
        tree = dict(paths(self.build()))
        self.assertEqual([p[1] for p in tree if p[0] == "我的入口" and len(p) == 2],
                         ["选区提问", "随便聊聊"])
        tree["我的入口", "选区提问"].trigger()
        self.pet.on_screen_capture.assert_called_once_with()
        self.assertFalse(any(p[-1] in ("截图提问", "聊一聊", "查看天气", "旧识屏", "旧联动", "识屏与联动")
                             for p in tree))
        self.assertEqual(self.pet.cfg["context_menu_layout"], layout)

    def test_pc_menu_hides_retired_actions_from_saved_layout(self):
        layout = {
            "schema_version": 1, "layout_id": "user",
            "nodes": [
                {"type": "submenu", "id": "my_tools", "label": "我的入口", "children": [
                    {"type": "action", "id": "look_screen"},
                    {"type": "action", "id": "screen_capture"},
                    {"type": "action", "id": "autostart"},
                    {"type": "action", "id": "check_update"},
                ]},
                {"type": "action", "id": "modern_settings"},
                {"type": "action", "id": "quit"},
            ],
        }
        self.pet.on_look_screen = Mock()
        self.pet.cfg["context_menu_layout"] = deepcopy(layout)
        with patch.dict(os.environ, {"DAFEIYU_PC_ROOT": str(ROOT)}):
            tree = dict(paths(self.build()))
        self.assertEqual([p[1] for p in tree if p[0] == "我的入口" and len(p) == 2], ["截图提问"])
        self.assertEqual(self.pet.cfg["context_menu_layout"], layout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
