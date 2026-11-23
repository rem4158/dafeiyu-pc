# -*- coding: utf-8 -*-
"""Modern-inspired sidebar settings panel used by the modern context menu.

拆分后的主对话框模块：ModernSettingsDialog 及对话框装配/配置写回逻辑留守本文件。
控件库 / 菜单布局编辑器 / AI 设置页 / 主题 QSS 已按结构线拆至
settings_widgets / settings_menu_layout_editor / chat/ai_settings_page / settings_theme_qss。
本文件保留这些符号的 re-export，供 tests 与 pet/ 既有调用向后兼容。
"""

from __future__ import annotations

import logging
import sys
import threading
from pathlib import Path

import shiboken6


from PySide6.QtCore import QEvent, QFileInfo, QPoint, QPointF, QRect, QRectF, QSize, Qt, Signal
from PySide6.QtGui import (
    QAction,
    QColor,
    QClipboard,
    QFontDatabase,
    QKeySequence,
    QShortcut,
    QIcon,
    QImageReader,
    QPainter,
    QPainterPath,
    QPen,
    QPixmap,
)
from PySide6.QtWidgets import (
    QAbstractButton,
    QAbstractItemView,
    QApplication,
    QBoxLayout,
    QDialog,
    QColorDialog,
    QDialogButtonBox,
    QDoubleSpinBox,
    QFileDialog,
    QFileIconProvider,
    QFrame,
    QGridLayout,
    QHeaderView,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QListWidget,
    QLayout,
    QMessageBox,
    QMenu,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QSplitter,
    QStackedWidget,
    QSizePolicy,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from . import __version__
from . import autostart as autostart_mod
from . import catalog
from .click_sound import warm_click_sound_effects
from .config import (
    DEFAULT_CONTEXT_MENU_APPEARANCE,
    DEFAULT_MENU_EASTER_EGG,
    DEFAULT_QUICK_LAUNCH_APPS,
    DEFAULT_SELF_TALK_BUBBLE_STYLE,
    DEFAULT_SELF_TALK_DURATION_SECONDS,
    DEFAULT_SELF_TALK_MAX_INTERVAL,
    DEFAULT_SELF_TALK_MIN_INTERVAL,
    DEFAULT_SELF_TALK_TEXTS,
    _float_or_default,
)
from .context_menus.icons import (
    CUSTOM_ICON_SUFFIXES,
    custom_icon_file_error,
    vector_widget_icon,
)
from .context_menus.quick_launch import fitted_application_icon
from .context_menus.registry import CUSTOM_ICON_CHOICES, MENU_ACTIONS
from .fun_image_popup import oijingjing_image_path, resolve_fun_asset, store_fun_asset
from .menu_layout import (
    load_default_menu_layout,
    materialize_implicit_separators,
    merge_default_menu_actions,
    resolve_menu_layout,
)
from . import settings_close_flow
from .application_icon import load_application_icon
from .settings_slot_config import route_settings_config
from .pc_mode import is_pc_mode
from .speech_bubble import BUBBLE_STYLE_PRESETS
from .update_settings import UpdatePage


def _chat_feature_available() -> bool:
    """本构建是否带聊天模块（纯桌宠版打包时排除 pet.chat，与 app.py
    ChatService 导入守卫同一判定口径）。"""
    try:
        from .chat.service import ChatService  # noqa: F401
    except ImportError as exc:
        if str(getattr(exc, "name", "") or "").startswith("pet.chat"):
            return False
        raise
    return True

from .settings_widgets import (
    _system_font_families,
    BROWSER_CONTROL_SPEC,
    SETTINGS_DOMAIN_NAV,
    BROWSER_CONTROL_STYLESHEET,
    _widget_dark,
    reveal_settings_row,
    ToggleSwitch,
    IMAGE_NAME_FILTER,
    AUDIO_NAME_FILTER,
    ClickSoundPackPicker,
    MasonryLayout,
    MasonryImageCard,
    MasonryFlow,
    ImagePreviewDrawer,
    ResourcePathPicker,
    ColorSwatchButton,
    ColorPicker,
    _draw_chevron,
    SETTINGS_POPUP_OBJECT_NAME,
    SETTINGS_POPUP_STYLESHEET,
    _DARK_POPUP_OVERRIDE,
    settings_popup_stylesheet,
    configure_settings_action_popup,
    SettingsPopupAction,
    SettingsPopupMenu,
    SettingsMenuButton,
    ModernSelect,
    BrowserSpinBox,
    BrowserDoubleSpinBox,
    CONTENT_READING_MAX_WIDTH,
    CollapsibleGroup,
    SettingRow,
    ResponsiveActionRow,
    ResponsiveToggleActionRow,
    SettingsCard,
    SettingsDisclosureHeader,
    SettingsSection,
    SettingsSidebarPane,
    refresh_settings_icons,
    settings_save_exit_button,
    settings_sidebar_item,
    _CurrentPageStack,
    SettingsTabContainer,
    _SettingsPageShell,
    _line_edit,
    QuickLaunchItemRow,
    QuickLaunchEditor,
    _system_dark,
)
from .settings_theme_qss import _settings_stylesheet
from .settings_menu_layout_editor import MenuLayoutEditor
from . import settings_default_marks
from . import settings_file_interpret
from . import settings_interaction
from . import settings_music
from . import settings_network
from . import settings_page_guide
from . import settings_divination
from . import settings_hotkeys
from . import settings_weather
from . import settings_pet_controls
from . import settings_quiet
from . import settings_reset_defaults
from . import settings_search


# 搜索命中「被前置开关藏起来」的行时，指向必须先去打开的那一项（依赖不满足绝不
# 自动改配置）。只登记会成为搜索目标的隐藏行；新加依赖时按需补一行。
_SEARCH_HIDDEN_PREREQUISITES = {
    "network_probe_interval": "island_network",
}


class ModernSettingsDialog(QDialog):
    """Settings window matching Modern's sidebar and rounded-card hierarchy."""

    def __init__(self, config, parent=None, *, include_ai: bool = True,
                 standalone: bool = False, initial_page: str | None = None):
        super().__init__(parent)
        # slot 设置页（含 #271 起的主宠页 = slot0 页）：非 per-slot 键直读**主**配置
        #（而不是 slot 文件里的无效快照），保存时按同一分流写回。
        # 见 pet/settings_slot_config.py 的模块 docstring。
        config = route_settings_config(config)
        # 每张表单一份**独立编辑视图**（草稿 + 编辑代次基线各自一份，运行期那份保持只读）：
        # 复用运行期那份会让"旧表单钉住的代次"跨窗存活，重开设置永远存不进去。
        opener = getattr(config, "new_form_view", None)
        self.config = config = opener() if callable(opener) else config
        self.pc_mode = is_pc_mode()
        self.include_ai = bool(include_ai) and not self.pc_mode
        # standalone=True：本对话框跑在独立设置进程（python -m pet --settings）里，
        # 没有桌宠窗口/AppShell 可依附。只影响下面几处显式分支，默认 False 时
        # 全部行为与改动前逐位一致。
        self.standalone = bool(standalone)
        self.initial_page = str(initial_page or "").strip()
        self.ai_page = None
        self.setProperty("modernStyle", True)
        self.setProperty("menuStyle", "modern")
        if self.pc_mode:
            self.setObjectName("pcSettingsWindow")
        self.setWindowTitle("桌宠设置")
        # 原生标题栏的图标：不设的话 Windows 摆的是系统给的通用图标（--icon 只写进
        # 可执行文件/应用包的文件图标资源，与窗口属性是两回事）。拿不到时是空图标。
        self.setWindowIcon(load_application_icon())
        self.resize(800, 560)
        self.setMinimumSize(720, 500)
        self._positioned_away = False
        self.setModal(False)
        self.setWindowModality(Qt.WindowModality.NonModal)
        self.setAttribute(Qt.WidgetAttribute.WA_DeleteOnClose, True)
        font = QFontDatabase.systemFont(QFontDatabase.SystemFont.GeneralFont)
        font.setPixelSize(13)
        self.setFont(font)

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        body = QHBoxLayout()
        body.setContentsMargins(0, 0, 0, 0)
        body.setSpacing(0)

        sidebar_pane = SettingsSidebarPane(self)
        sidebar_layout = QVBoxLayout(sidebar_pane)
        sidebar_layout.setContentsMargins(12, 16, 12, 12)
        # 间距 3px + 导航行距 1px：slot 页有两个重置按钮时，默认窗口 800×560 下 10 个
        # 能力域要全落在视口里；3px 把本机余量 4 → 19px（CI 280：Ubuntu 上 6px 不够）。
        sidebar_layout.setSpacing(3)
        # 「保存并退出」的图标 / 保存时机 tooltip / 焦点旗标都在控件库里（本文件有行数预算）。
        self.save_exit_button = settings_save_exit_button(sidebar_pane, self._save)
        sidebar_layout.addWidget(self.save_exit_button)
        self.search_edit = QLineEdit(sidebar_pane)
        self.search_edit.setObjectName("settingsSearch")
        self.search_edit.setPlaceholderText("搜索设置…")
        self.search_edit.addAction(
            # 宿主就是搜索框自己：记在它身上的请求换主题后重画（QLineEdit 无 setIcon）。
            vector_widget_icon(self.search_edit, "search", 16),
            QLineEdit.ActionPosition.LeadingPosition,
        )
        self.search_edit.installEventFilter(self)
        sidebar_layout.addWidget(self.search_edit)
        self.search_status = QLabel("", sidebar_pane)
        self.search_status.setObjectName("searchStatus")
        self.search_status.setWordWrap(True)
        self.search_status.hide()
        sidebar_layout.addWidget(self.search_status)
        self.sidebar = QListWidget(sidebar_pane)
        self.sidebar.setObjectName("settingsSidebar")
        self.sidebar.setIconSize(QSize(18, 18))
        # 导航行距 1px：与上面的侧栏间距一起把 10 个能力域收进默认窗口高度。
        self.sidebar.setSpacing(1)
        sidebar_layout.addWidget(self.sidebar, 1)
        # 全局兜底入口（命令而非偏好项，故放侧栏底部；实现在 settings_reset_defaults.py）。
        settings_reset_defaults.create_reset_button(self, sidebar_layout)
        self.version_footer = QLabel(f"版本 v{__version__}", sidebar_pane)
        self.version_footer.setObjectName("settingsVersion")
        self.version_footer.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.version_footer.setToolTip("当前运行版本")
        sidebar_layout.addWidget(self.version_footer)

        self.pages = QStackedWidget(self)
        body.addWidget(sidebar_pane)
        body.addWidget(self.pages, 1)
        root.addLayout(body, 1)

        self._build_pet_controls()
        # 「文件识别」域控件在本模块构建（行数预算原因），见 settings_file_interpret。
        if not self.pc_mode:
            self._build_file_interpret_controls()
        # 「音乐播放器路径」控件同样在本模块构建（行数预算原因），见 settings_music。
        settings_music.create_music_player_controls(self)
        # 灵动岛控件构建保留在对话框本体，便于上游直接修改后上传。
        island_cfg = self.config.get("dynamic_island", {})
        if not isinstance(island_cfg, dict):
            island_cfg = {}
        self.island_enabled_check = ToggleSwitch(self)
        self.island_enabled_check.setChecked(bool(island_cfg.get("enabled", False)))
        self.island_icon_check = ToggleSwitch(self)
        self.island_icon_check.setChecked(bool(island_cfg.get("show_icon", True)))
        self.island_name_check = ToggleSwitch(self)
        self.island_name_check.setChecked(bool(island_cfg.get("show_name", True)))
        self.island_info_check = ToggleSwitch(self)
        self.island_info_check.setChecked(bool(island_cfg.get("show_info", True)))
        self.island_status_check = ToggleSwitch(self)
        self.island_status_check.setChecked(bool(island_cfg.get("show_status", True)))
        self.island_info_mode_select = ModernSelect(self, width=160)
        for label, value in (
            ("当前时间", "time"),
            ("余额峰谷", "balance_tier"),
            ("余额数值", "balance"),
            ("自定义短文本", "custom"),
        ):
            self.island_info_mode_select.addItem(label, value)
        self.island_info_mode_select.setCurrentData(str(island_cfg.get("info_mode") or "time"))
        self.island_style_select = ModernSelect(self, width=160)
        for label, value in (
            ("黑色", "dark"),
            ("白色", "light"),
            ("玻璃质感", "glass"),
        ):
            self.island_style_select.addItem(label, value)
        self.island_style_select.setCurrentData(str(island_cfg.get("style") or "dark"))
        self.island_opacity_spin = BrowserDoubleSpinBox(self)
        self.island_opacity_spin.setRange(0.4, 1.0)
        self.island_opacity_spin.setSingleStep(0.05)
        self.island_opacity_spin.setDecimals(2)
        try:
            _island_opacity = float(island_cfg.get("opacity", 1.0))
        except (TypeError, ValueError):
            _island_opacity = 1.0
        self.island_opacity_spin.setValue(max(0.4, min(1.0, _island_opacity)))
        self.island_accent_select = ModernSelect(self, width=160)
        for label, value in (
            ("海洋蓝", "blue"),
            ("草绿", "green"),
            ("葡萄紫", "purple"),
            ("樱花粉", "pink"),
            ("落日橙", "orange"),
        ):
            self.island_accent_select.addItem(label, value)
        self.island_accent_select.setCurrentData(str(island_cfg.get("accent") or "blue"))
        self.island_icon_select = ModernSelect(self, width=160)
        # 标签用中文而不是 emoji 字符：下拉框自己也会渲染 emoji，一样要付
        # DirectWrite 彩色字体栈的一次性税额（约 33MB），data 才是存的图标值
        self.island_icon_select.addItem("鱼本体头像（推荐）", "auto")
        for label, emoji in (
            ("鲸鱼", "🐳"),
            ("小鱼", "🐟"),
            ("章鱼", "🐙"),
            ("海豹", "🦭"),
            ("企鹅", "🐧"),
            ("小猫", "🐱"),
            ("小狗", "🐶"),
            ("星星", "🌟"),
            ("闪电", "⚡"),
            ("爱心", "❤️"),
        ):
            self.island_icon_select.addItem(label, emoji)
        self.island_icon_select.setCurrentData(str(island_cfg.get("icon") or "auto"))
        self.island_custom_text_edit = _line_edit(str(island_cfg.get("custom_text") or ""), width=220)
        self.island_click_action_select = ModernSelect(self, width=160)
        for label, value in (
            ("展开快捷卡片", "expand"),
            ("切换桌宠显隐", "toggle_pet"),
        ):
            self.island_click_action_select.addItem(label, value)
        self.island_click_action_select.setCurrentData(str(island_cfg.get("click_action") or "expand"))
        self.island_event_effects_check = ToggleSwitch(self)
        self.island_event_effects_check.setChecked(bool(island_cfg.get("event_effects", True)))
        self.island_hidden_chat_check = ToggleSwitch(self)
        self.island_hidden_chat_check.setChecked(bool(island_cfg.get("hidden_chat", True)))
        if self.pc_mode:
            self.island_hidden_chat_check.hide()
        self.island_edge_dock_check = ToggleSwitch(self)
        self.island_edge_dock_check.setChecked(bool(island_cfg.get("edge_dock", True)))
        self.island_collision_check = ToggleSwitch(self)
        self.island_collision_check.setChecked(bool(island_cfg.get("collision_enabled", True)))

        if self.include_ai:
            # 延迟 import：no-chat 打包变体 excludes=['pet.chat']，顶层导入会在
            # 产物运行时抛 ModuleNotFoundError，导致设置界面整体打不开。
            from .chat.ai_settings_page import _AiSettingsPage

            self.ai_page = _AiSettingsPage(config, self)

        general_content = QWidget()
        general_layout = QVBoxLayout(general_content)
        general_layout.setContentsMargins(0, 0, 0, 0)
        general_layout.setSpacing(18)
        launch_rows = [] if self.pc_mode else [
            SettingRow("autostart", "开机自启", "登录系统后自动启动桌宠。", self.autostart_check),
        ]
        if sys.platform == "darwin":
            launch_rows.append(
                SettingRow(
                    "dock_icon",
                    "显示 Dock 图标",
                    "在 macOS Dock 中显示桌宠应用；关闭后仍可通过桌宠和托盘操作。",
                    self.dock_icon_check,
                )
            )
        general_layout.addWidget(SettingsSection("应用启动", launch_rows, general_content))
        window_rows = [
            SettingRow("on_top", "窗口置顶", "始终将桌宠保持在其他窗口上方。", self.on_top_check),
        ]
        if sys.platform == "win32":
            window_rows.extend(
                [
                    SettingRow("auto_hide_fullscreen", "全屏时自动隐藏", "全屏游戏或视频期间自动隐藏桌宠。", self.auto_hide_fullscreen_check),
                    SettingRow(
                        "cursor_hidden_passthrough",
                        "光标隐藏时自动穿透",
                        "Windows 光标隐藏后，桌宠自动穿透点击；光标出现立即恢复。适用于游戏，也可能影响自动隐藏光标的视频播放器。",
                        self.cursor_hidden_passthrough_check,
                    ),
                    SettingRow("stream_capture", "直播捕获兼容", settings_pet_controls.stream_capture_hint(), self.stream_capture_check),
                ]
            )
        # 「允许桌宠跨屏」不分平台（三端都有多显示器），排在窗口旗标类之后：前面几条
        # 讲"窗口怎么摆"，它讲"桌宠能不能到别的显示器去"（行序见常规域装配的 claim 表）。
        window_rows.append(
            SettingRow(
                "cross_screen",
                "允许桌宠跨屏",
                settings_pet_controls.CROSS_SCREEN_HINT,
                self.cross_screen_check,
            )
        )
        general_layout.addWidget(SettingsSection("窗口与系统", window_rows, general_content))
        # 拓扑收口：「单进程多开」实验开关已从设置页移除，4.4b 起配置键
        # `experimental_single_process_spawn` 本身也随多进程多宠退役层删除
        # （进程内多窗是唯一多宠形态，不再是可切换的实验开关）。
        if self.balance_refresh_spin is not None:
            general_layout.addWidget(
                SettingsSection(
                    "后台服务",
                    [
                        SettingRow("balance_refresh", "余额自动刷新", "设置后台刷新间隔；0 分钟表示关闭。", self.balance_refresh_spin),
                        SettingRow("balance_tier_mode", "高峰 / 空闲时段提示", "选择 DeepSeek 高峰/空闲提示的显示风格。", self.balance_tier_mode_select),
                        SettingRow(
                            "balance_tier_peak", "高峰自定义文本", "仅“自定义”模式生效；留空回退默认“高峰”。", self.balance_tier_peak_edit, stacked=True
                        ),
                        SettingRow(
                            "balance_tier_idle", "空闲自定义文本", "仅“自定义”模式生效；留空回退默认“空闲”。", self.balance_tier_idle_edit, stacked=True
                        ),
                        SettingRow(
                            "balance_tier_color",
                            "峰谷提示颜色",
                            "开启后高峰显示红色、低谷显示绿色；关闭则使用普通气泡文字颜色。",
                            self.balance_tier_color_check,
                        ),
                    ],
                    general_content,
                )
            )
        general_layout.addStretch(1)
        self._add_page("常规", "settings", self._page_shell("常规", general_content))

        island_content = QWidget()
        island_layout = QVBoxLayout(island_content)
        island_layout.setContentsMargins(0, 0, 0, 0)
        island_layout.setSpacing(18)
        island_layout.addWidget(
            SettingsSection(
                "灵动岛",
                [
                    SettingRow("dynamic_island_enabled", "启用灵动岛", "显示独立胶囊小窗；桌宠隐藏后仍可常驻。", self.island_enabled_check),
                    SettingRow("dynamic_island_icon", "显示图标", "在胶囊左侧显示角色图标。", self.island_icon_check),
                    SettingRow("dynamic_island_name", "显示名称", "显示当前角色名称。", self.island_name_check),
                    SettingRow("dynamic_island_info", "显示中间信息栏", "显示时间/余额/自定义短文本等信息。", self.island_info_check),
                    SettingRow("dynamic_island_status", "显示状态灯", "显示右侧状态圆点。", self.island_status_check),
                    SettingRow("dynamic_island_info_mode", "信息栏显示什么", "选择信息栏显示的内容；自定义文本在下方填写。", self.island_info_mode_select),
                    SettingRow(
                        "dynamic_island_style",
                        "背景风格",
                        "黑色 / 白色 / 苹果式玻璃质感；配合下方不透明度可调出半透明质感（纯自绘，低占用）。",
                        self.island_style_select,
                    ),
                    SettingRow("dynamic_island_opacity", "背景不透明度", "越低越透（0.4~1.0）；配合深色底在低占用下做出半透明质感。", self.island_opacity_spin),
                    SettingRow("dynamic_island_accent", "主题色", "图标底圈、事件闪光、停靠描边共用的点缀色。", self.island_accent_select),
                    SettingRow("dynamic_island_icon_value", "图标", "默认显示鱼本体头像；可选 emoji 图标，首次绘制会多占约 30MB 内存。", self.island_icon_select),
                    SettingRow(
                        "dynamic_island_custom_text", "自定义短文本", "信息栏选择“自定义短文本”时显示的内容。", self.island_custom_text_edit, stacked=True
                    ),
                    SettingRow(
                        "dynamic_island_click_action",
                        "单击行为",
                        "单击胶囊：展开快捷卡片（余额/最近消息/快捷按钮）或直接切换桌宠显隐。",
                        self.island_click_action_select,
                    ),
                    *([SettingRow(
                        "dynamic_island_hidden_chat",
                        "隐藏时对话气泡",
                        "桌宠隐藏后岛变成对话入口：单击灵动岛弹出对话气泡，AI 回复到达时也会在岛上弹出预览（不抢焦点，超时自动收回）。",
                        self.island_hidden_chat_check,
                    )] if not self.pc_mode and _chat_feature_available() else []),
                    # 纯桌宠版（无 pet.chat 打包变体）不展示该开关：开了也没有
                    # 气泡可弹——运行时岛侧已由 chat_available 回退展开卡片
                    SettingRow(
                        "dynamic_island_event_effects",
                        "事件动效",
                        "AI 回复到达、余额刷新、峰谷切换时果冻弹跳提示。静止时零额外开销。",
                        self.island_event_effects_check,
                    ),
                    SettingRow(
                        "dynamic_island_edge_dock",
                        "靠边半隐藏",
                        "拖到屏幕任意边缘（上下左右）收成细条，鼠标靠近自动滑出；顶部被占时可停靠侧边。",
                        self.island_edge_dock_check,
                    ),
                    SettingRow(
                        "dynamic_island_collision",
                        "果冻墙（参与碰撞）",
                        "岛注册为静态碰撞体：肥鱼被甩到岛上会弹开，岛原地果冻摆动。岛的位置不会被撞动。",
                        self.island_collision_check,
                    ),
                ],
                island_content,
            )
        )
        # 灵动岛指标（issue #172 + P1 Slice C）：控件/行/保存在 settings_network（行数预算原因）。
        island_layout.addWidget(SettingsSection(
            "桌面组件", settings_network.build_island_network_rows(self), island_content))
        island_layout.addStretch(1)
        self._add_page("灵动岛", "island", self._page_shell("灵动岛", island_content))

        behavior_content = QWidget()
        behavior_layout = QVBoxLayout(behavior_content)
        behavior_layout.setContentsMargins(0, 0, 0, 0)
        behavior_layout.setSpacing(16)
        behavior_layout.addWidget(
            SettingsSection(
                "动画",
                [
                    # F06：``playback_speed`` 是**每宠**键（``PER_PET_KEYS``，B7b 起
                    # 右键菜单的速率也只改被点的那一只），文案不许再说"所有桌宠"。
                    SettingRow("playback_speed", "播放速率", "控制这只桌宠动画的播放速度。", self.speed_select),
                    SettingRow("animation_gap", "动作等待间隔", "非待机动作之间的休息时间；0 秒表示连续播放。", self.gap_spin),
                    SettingRow(
                        "idle_low_fps",
                        "省电模式",
                        settings_pet_controls.idle_low_fps_hint(),
                        self.idle_low_fps_check,
                    ),
                    SettingRow("no_move", "不移动", "暂停桌宠在桌面上的自动移动。", self.no_move_check),
                    # 鼠标穿透行归「互动 · 输入」（settings_interaction 构建）。
                ],
                behavior_content,
            )
        )
        behavior_layout.addWidget(
            SettingsSection(
                "音乐关联",
                [
                    SettingRow("music_sing", "音乐自动唱歌", "检测到后台播放音乐时，自动播放唱歌动画。", self.music_sing_check),
                    SettingRow("music_lyric", "显示歌词", "在气泡里显示当前播放歌曲的歌词。仅 Windows 可用；需要播放器支持系统媒体控制（酷狗音乐需在其 设置 → 常规设置 → 播放 里开启「支持系统播放控件」）。歌词识别不依赖「音乐关联」里的路径——那里只影响右键「打开播放器」菜单。网易云音乐不上报播放进度，歌词按开始时间估算——快进或从中途开始播放后，用右键菜单「音乐 → 歌词对齐」校正。", self.music_lyric_check),
                    SettingRow("music_lyric_lead", "歌词提前量", "歌词相对音频的时间偏移。正值让歌词抢先显示，负值让它延后；唱得比音乐早一点通常更自然。", self.music_lyric_lead_spin),
                ] + settings_music.browser_media_rows(self) + settings_music.foobar_lyrics_rows(self),
                behavior_content,
            )
        )
        behavior_layout.addWidget(
            SettingsSection(
                "拖拽与弹射",
                [
                    SettingRow("drag_physics", "拖动物理", "启用拖拽惯性、重力和边缘反弹。", self.drag_physics_check),
                    SettingRow("drop_gravity", "静止放手下落", "松开鼠标时如果宠物几乎没移动，它不再停在半空，而是自然落下、落地静止；贴地松手不会弹起。与「拖动物理」无关：关掉拖动物理后甩出惯性依然不生效。", self.drop_gravity_check),
                    SettingRow("throw_strength", "甩出力度", "控制桌宠被甩出或弹射发射时的最大速度限制。", self.throw_strength_select),
                    SettingRow("slingshot_enabled", "弹弓弹射", "拖拽桌宠时点击右键进入蓄力瞄准，松开左键弹射飞出（Esc或右键取消）。", self.slingshot_check),
                    SettingRow("lock_position", "锁定位置", "桌宠固定不动，无法拖动（点击互动仍有效）。", self.lock_position_check),
                    SettingRow("shift_drag", "SHIFT+左键拖动", "开启后必须按住 SHIFT 再左键才能拖动桌宠。", self.shift_drag_check),
                ],
                behavior_content,
            )
        )
        behavior_layout.addWidget(
            SettingsSection(
                "边缘探头",
                [
                    SettingRow(
                        "edge_probe", "边缘探头", "拖到屏幕左/右边缘后自动以 45° 探头姿态窥视；点击真实角色会拉直约 5 秒后自动退回。", self.edge_probe_check
                    ),
                ],
                behavior_content,
            )
        )
        behavior_layout.addWidget(
            SettingsSection(
                "生小肥鱼",
                [
                    SettingRow(
                        "spawn_inherit_size",
                        "生小肥鱼继承大小",
                        "开启后生成的小肥鱼与主肥鱼大小一致；关闭后使用下方为小肥鱼单独选择的大小。",
                        self.spawn_inherit_size_check,
                    ),
                    SettingRow("spawn_scale", "小肥鱼大小", "关闭“继承大小”时，新生成小肥鱼使用的桌面尺寸。", self.spawn_scale_combo, stacked=True),
                    SettingRow(
                        "clear_spawned_pets", "一键退出子肥鱼", "关闭所有已生成的小肥鱼。它们的档案、设置、会话与待办数据全部保留，随时可以再生成。", self.clear_spawned_pets_btn
                    ),
                ],
                behavior_content,
            )
        )
        behavior_layout.addWidget(
            SettingsSection(
                "多开碰撞",
                [
                    SettingRow(
                        "collision_enabled",
                        "碰撞开关",
                        "多开桌宠之间发生碰撞物理互动。开启鼠标穿透的桌宠仍会参与碰撞，锁定位置的桌宠作为固定障碍。",
                        self.collision_enabled_check,
                    ),
                    SettingRow("collision_restitution", "撞后弹力", "碰撞反弹的能量保留程度（0~1.00，默认 0.82）。", self.collision_restitution_spin),
                    SettingRow("collision_friction", "摩擦系数", "擦边碰撞时的切向摩擦阻力（0~0.30，默认 0.08）。", self.collision_friction_spin),
                    SettingRow("collision_mass_scale", "体重倍率", "桌宠的基础质量加权倍率（0.5~2.0，默认 1.0）。", self.collision_mass_scale_spin),
                    SettingRow("collision_impulse_cap", "最大撞击力度", "单次碰撞能施加的最大冲量上限（1000~12000，默认 9000）。", self.collision_impulse_cap_spin),
                    SettingRow("collision_sound_enabled", "碰撞音效", "碰撞时播放音效反馈。", self.collision_sound_check),
                    SettingRow("collision_sound_volume", "碰撞音量", "调整碰撞音效播放音量。", self.collision_sound_volume_spin),
                ],
                behavior_content,
            )
        )
        self.collision_policy_note = QLabel("碰撞参数由当前协调者桌宠的设置决定")
        self.collision_policy_note.setObjectName("settingHint")
        self.collision_policy_note.setWordWrap(True)
        self.collision_policy_note.setContentsMargins(14, 0, 14, 0)
        behavior_layout.addWidget(self.collision_policy_note)
        # 「点击反馈」与「自言自语」两组归「互动」域（settings_interaction 构建，
        # 行数预算原因；组名与顺序的既有契约见 tests/test_menu_layout.py）。
        behavior_layout.addWidget(
            SettingsSection(
                "表达风格",
                [
                    SettingRow(
                        "dialogue_mode",
                        "表达风格",
                        "调整桌宠内置自言自语和余额气泡的说话方式。内置「默认模式」与「鲸鱼娘女仆模式」不可编辑；选择「自定义台词」后，可粘贴下方 JSON 一键导入全部弹窗文案。",
                        self.dialogue_mode_select,
                    ),
                ],
                behavior_content,
            )
        )
        behavior_layout.addWidget(
            SettingsCard(
                [
                    SettingRow(
                        "dialogue_template_actions",
                        "弹窗文案模板（JSON）",
                        "一键复制当前全部弹窗内容模板到剪贴板；把复制的 JSON 粘贴回「导入模板」可一次覆盖所有「自定义台词」，也可以直接发给 AI 依角色卡改写。事件留空时自动沿用默认模式文案；模板占位符会自动读取上游事件字段。",
                        self.dialogue_template_actions,
                        stacked=True,
                    ),
                ],
                behavior_content,
            )
        )
        behavior_layout.addWidget(
            SettingsCard(
                [
                    SettingRow(
                        f"dialogue_{key}",
                        settings_pet_controls.DIALOGUE_LABELS[key],
                        "留空则使用基础模式台词。" + settings_pet_controls.DIALOGUE_HINTS.get(key, ""),
                        edit,
                        stacked=True,
                    )
                    for key, edit in self.dialogue_phrase_edits.items()
                ],
                behavior_content,
            )
        )
        behavior_layout.addWidget(
            SettingsSection(
                "待办提醒",
                [
                    SettingRow(
                        "todo_reminder_enabled", "待办提醒", "到点通过气泡或桌面通知提醒；待办条目在右键菜单「待办提醒」面板中管理。", self.todo_reminder_check
                    ),
                    SettingRow(
                        "todo_reminder_lead_minutes", "提前提醒", "到点前提前提醒的分钟数（0~60，0 = 不提前，仅准点提醒一次）。", self.todo_reminder_lead_spin
                    ),
                    SettingRow(
                        "todo_reminder_speak", "语音播报", "到点时把提醒念出来；音色 / 语速 / 音量与「语音报时」共用同一套（设置 → 语音），本项只控制开与关。免打扰期间不出声，也不在结束后补播。", self.todo_reminder_speak_check
                    ),
                ],
                behavior_content,
            )
        )
        behavior_layout.addStretch(1)
        self._add_page("桌宠行为", "play", self._page_shell("桌宠行为", behavior_content))

        appearance_content = QWidget()
        appearance_layout = QVBoxLayout(appearance_content)
        appearance_layout.setContentsMargins(0, 0, 0, 0)
        appearance_layout.setSpacing(16)
        appearance_layout.addWidget(
            SettingsSection(
                "桌宠显示",
                [
                    SettingRow("scale", "桌宠大小", "调整桌宠在桌面上的显示尺寸。", self.scale_combo),
                    SettingRow(
                        "bubble_text_scale",
                        "气泡文字大小",
                        "气泡里文字的显示尺寸：气泡与字号一起等比放大（100% 为默认）。"
                        "大屏上嫌气泡字小时调大；审批/提问气泡为固定布局，不随本项变化。",
                        self.bubble_text_scale_spin,
                    ),
                    SettingRow("pet_opacity", "不透明度", "调整桌宠窗口的整体透明度；100% 为完全不透明。", self.pet_opacity_spin),
                    # 「气泡方案」行归「互动 · 自言自语」（settings_interaction 构建）。
                ],
                appearance_content,
            )
        )
        appearance_layout.addWidget(
            SettingsSection(
                "菜单外观",
                [
                    SettingRow("menu_theme", "颜色主题", "可跟随系统，或固定使用浅色/深色菜单。", self.menu_theme_select),
                    SettingRow("menu_density", "菜单密度", "调整新版右键菜单的菜单项高度和分组留白。", self.menu_density_select),
                    SettingRow("menu_radius", "圆角大小", "调整新版右键菜单和子菜单的外轮廓圆角。", self.menu_radius_select),
                    SettingRow("menu_font", "UI 字体", "设置新版菜单使用的界面字体。", self.menu_font_select),
                    SettingRow("menu_font_size", "UI 字号", "同步调整主菜单与多级菜单的字号。", self.menu_font_size_select),
                    SettingRow("menu_translucent", "半透明菜单", "使用接近 Modern 的半透明浮层表面。", self.menu_translucent_check),
                    SettingRow("menu_opacity", "表面不透明度", "调整菜单背景透出桌面内容的程度。", self.menu_opacity_spin),
                ],
                appearance_content,
            )
        )
        if self.ai_page is not None:
            appearance_layout.addWidget(SettingsSection("AI 对话外观", self.ai_page.appearance_rows(), appearance_content))
        appearance_layout.addWidget(
            SettingsSection(
                "浅色主题",
                [
                    SettingRow("light_background", "背景色", "浅色菜单的浮层背景。", self.light_background_picker),
                    SettingRow("light_foreground", "文字色", "浅色菜单的主要文字与图标颜色。", self.light_foreground_picker),
                    SettingRow("light_hover", "悬停色", "鼠标悬停菜单项时的背景。", self.light_hover_picker),
                ],
                appearance_content,
            )
        )
        appearance_layout.addWidget(
            SettingsSection(
                "深色主题",
                [
                    SettingRow("dark_background", "背景色", "深色菜单的浮层背景。", self.dark_background_picker),
                    SettingRow("dark_foreground", "文字色", "深色菜单的主要文字与图标颜色。", self.dark_foreground_picker),
                    SettingRow("dark_hover", "悬停色", "鼠标悬停菜单项时的背景。", self.dark_hover_picker),
                ],
                appearance_content,
            )
        )
        appearance_layout.addWidget(
            SettingsSection(
                "彩蛋入口",
                [
                    SettingRow("egg_enabled", "显示彩蛋", "控制新版菜单首行彩蛋入口是否显示。", self.egg_enabled_check),
                    SettingRow("egg_title", "入口标题", "显示在圆形头像右侧的文字。", self.egg_title_edit),
                    SettingRow("egg_hint", "右侧提示", "显示在鼠标指针图标后的短提示。", self.egg_hint_edit),
                    SettingRow("egg_avatar", "头像图片", "使用绝对路径；支持常见图片格式。", self.egg_avatar_picker),
                    SettingRow("egg_image_dir", "弹窗图片目录", "使用绝对路径；每次点击会随机选择一张图片。", self.egg_image_dir_picker),
                ],
                appearance_content,
            )
        )
        appearance_layout.addStretch(1)
        self._add_page("外观", "appearance", self._page_shell("外观", appearance_content))

        menu_content = QWidget()
        menu_page_layout = QVBoxLayout(menu_content)
        menu_page_layout.setContentsMargins(0, 0, 0, 0)
        menu_page_layout.setSpacing(18)
        menu_available_actions = set(MENU_ACTIONS.supported_ids)
        if not self.pc_mode and not self.include_ai:
            menu_available_actions.difference_update({"chat", "look_screen", "balance"})
        self.menu_available_actions = frozenset(menu_available_actions)
        menu_enabled_actions = set(menu_available_actions)
        if not self.config.get("quick_launch_apps", DEFAULT_QUICK_LAUNCH_APPS):
            menu_enabled_actions.discard("quick_launch")
        if not self.config.get("menu_easter_egg", DEFAULT_MENU_EASTER_EGG).get("enabled", True):
            menu_enabled_actions.discard("ojingjing")
        self.menu_layout_editor = MenuLayoutEditor(
            self.config.get("context_menu_layout"),
            menu_content,
            available_actions=menu_available_actions,
            enabled_actions=menu_enabled_actions,
        )
        menu_page_layout.addWidget(
            SettingsSection(
                "内容与布局",
                [
                    SettingRow("context_menu_layout", "菜单编排", "调整显示、顺序和层级；左侧编辑，右侧同步预览。", self.menu_layout_editor, stacked=True),
                ],
                menu_content,
            )
        )
        menu_page_layout.addStretch(1)
        self._add_page("菜单", "application", self._page_shell("菜单", menu_content))

        launcher_content = QWidget()
        launcher_layout = QVBoxLayout(launcher_content)
        launcher_layout.setContentsMargins(0, 0, 0, 0)
        launcher_layout.setSpacing(18)
        self.quick_launch_editor = QuickLaunchEditor(
            self.config.get("quick_launch_apps", DEFAULT_QUICK_LAUNCH_APPS),
            launcher_content,
        )
        launcher_layout.addWidget(
            SettingsSection(
                "已配置应用",
                [
                    SettingRow(
                        "quick_launch_apps",
                        "应用快捷启动",
                        "这些应用将按图标和名称显示在新版右键菜单的“快捷启动”子菜单中。",
                        self.quick_launch_editor,
                        stacked=True,
                    ),
                ],
                launcher_content,
            )
        )
        launcher_layout.addStretch(1)
        self._add_page("快捷启动", "application", self._page_shell("快捷启动", launcher_content))

        # AI rows are composed directly into the final capability domain by
        # _rebuild_domain_navigation. Do not temporarily hand the controller
        # widget to a QScrollArea: that creates a second Qt ownership path when
        # its rows are reparented into the shared card system.

        self.voice_chime_page = self.festival_page = self.update_page = None
        if not self.pc_mode:
            from .voice_chime_settings import VoiceChimeSettingsPage
            from .festival_settings import FestivalSettingsPage

            self.voice_chime_page = VoiceChimeSettingsPage(self.config, self)
            self.voice_chime_page.preview_requested.connect(self._on_voice_chime_preview)
            self.festival_page = FestivalSettingsPage(self.config, self)
            self.update_page = UpdatePage(self.config, include_chat=self.include_ai, parent=self)
        self._rebuild_domain_navigation()
        self.sidebar.currentRowChanged.connect(self.pages.setCurrentIndex)
        self.sidebar.setCurrentRow(0)
        if self.initial_page:
            self.select_page(self.initial_page)
        # 索引口径：标准设置行 + 「更新」页的作者账号行（后者不是 SettingRow，
        # 但暴露同名的 label/hint_label，故同一套匹配函数就能覆盖；侧栏命令类
        # 控件仍不进索引——那是 docs/SETTINGS-CHANGE-GATES.md 里的既有决定）。
        from .settings_about import AuthorRow

        search_root = self.pages if self.pc_mode else self
        self._search_rows = search_root.findChildren(SettingRow) + search_root.findChildren(AuthorRow)
        self._search_matches: list[SettingRow] = []
        self._search_index = -1
        self.search_edit.textChanged.connect(self._search_settings)
        # Ctrl+F：设置窗内任意位置把光标送进搜索框（浏览器/编辑器的一致习惯）。
        # 不抢输入框自己的按键：焦点已经在搜索框时 Qt 不会再触发这条快捷方式。
        find_shortcut = QShortcut(QKeySequence.StandardKey.Find, self)
        find_shortcut.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
        find_shortcut.activated.connect(self._focus_search_box)

        self.self_talk_check.toggled.connect(self._update_self_talk_controls)
        self.menu_translucent_check.toggled.connect(self._update_translucency_controls)
        self.island_enabled_check.toggled.connect(self._update_island_controls)
        self.island_icon_check.toggled.connect(self._update_island_icon_controls)
        self.island_info_check.toggled.connect(self._update_island_info_controls)
        self.island_info_mode_select.currentIndexChanged.connect(self._update_island_custom_text)
        self.egg_enabled_check.toggled.connect(self._update_egg_controls)
        self.egg_enabled_check.toggled.connect(self._sync_menu_action_states)
        self.network_info_menu_check.toggled.connect(self._sync_menu_action_states)
        self.quick_launch_editor.changed.connect(self._sync_menu_action_states)
        self.collision_enabled_check.toggled.connect(self._update_collision_controls)
        self.collision_sound_check.toggled.connect(self._update_collision_sound_controls)
        self.spawn_inherit_size_check.toggled.connect(self._update_spawn_size_controls)
        self.golden_spin_click_check.toggled.connect(self._update_golden_spin_controls)
        self.click_self_talk_check.toggled.connect(self._update_click_self_talk_controls)
        self._update_self_talk_controls(self.self_talk_check.isChecked())
        self._update_click_self_talk_controls(self.click_self_talk_check.isChecked())
        self._update_translucency_controls(self.menu_translucent_check.isChecked())
        self._update_island_controls(self.island_enabled_check.isChecked())
        self._update_egg_controls(self.egg_enabled_check.isChecked())
        self._sync_menu_action_states()
        self._update_collision_controls(self.collision_enabled_check.isChecked())
        self._update_spawn_size_controls(self.spawn_inherit_size_check.isChecked())
        # 初始同步须在全部 SettingRow 构建完成后执行，否则 findChild 找不到行
        self._update_click_sound_controls(self.click_sound_check.isChecked())
        self._update_golden_spin_controls(self.golden_spin_click_check.isChecked())
        self.menu_theme_select.currentIndexChanged.connect(self._apply_selected_theme)
        self._apply_selected_theme()
        # 行全部就位后标注窗口级键的生效范围（overlay 一窗多宠：只有子宠页需要）
        settings_pet_controls._apply_window_scope_rows(self)
        if self.standalone:
            # 独立进程本地宿主：试听改本地播放、节日试听本地演示、无 parent 时
            # 读 runtime 状态文件避让桌宠。逻辑全在 pet/settings_standalone.py，
            # 这里只做接线（本文件有行数预算）。
            from .settings_standalone import install_standalone_hooks

            install_standalone_hooks(self)
        # 全部行（含域导航重建时才造出来的文件识别行）就位后再装「已修改」标记
        settings_default_marks.install(self)

    def _sync_menu_action_states(self, *_args) -> None:
        enabled = set(self.menu_available_actions)
        if not self.quick_launch_editor.apps():
            enabled.discard("quick_launch")
        if not self.egg_enabled_check.isChecked():
            enabled.discard("ojingjing")
        if not self.network_info_menu_check.isChecked():
            enabled.discard("network_info")
        self.menu_layout_editor.set_enabled_actions(enabled)

    def _build_pet_controls(self) -> None:
        """Compatibility delegation (settings_pet_controls.build_pet_controls)."""
        settings_pet_controls.build_pet_controls(self)

    def _build_file_interpret_controls(self) -> None:
        """「文件识别」域控件（settings_file_interpret 构建，行数预算原因不在本文件展开）。"""
        settings_file_interpret.create_file_interpret_controls(self)

    def _update_self_talk_controls(self, enabled: bool) -> None:
        """周期气泡（``self_talk``）的细项显隐。

        点击侧（``click_self_talk*`` / ``click_talk_bindings``）**不在这里**：它们是
        独立开关的后续项，见 :meth:`_update_click_self_talk_controls`。绑在一起会让
        「只想点击听声」的用户在设置页里连开关都看不到。

        节奏项（最短/最长间隔、配图大小）只属于周期链路，仍只跟本开关；内容项
        （显示时间/候选内容/图片目录/配图概率）两条链路**共读同一份配置**——点击
        自言自语落地的 ``window_alerts.show_click_self_talk`` 读的正是这批键——所以
        它们跟 :meth:`_update_self_talk_content_controls` 走「任一开启」。
        """
        self._set_setting_rows_visible(
            ("self_talk_min", "self_talk_max", "self_talk_image_scale"),
            enabled,
            dependency="self_talk",
        )
        self._update_self_talk_content_controls(enabled)

    def _update_self_talk_content_controls(self, self_talk_enabled: bool) -> None:
        """内容项显隐：周期气泡与点击自言自语**任一**开启就显示。

        这些键是两条链路共用的内容源（候选文本 / 图片目录 / 配图概率 / 显示时长）。
        旧模型把显隐整组挂在周期开关上，只开点击的用户必须先打开一个他不用的周期
        功能才能编辑候选文本——消费侧早已解耦（``show_click_self_talk`` 不看
        ``self_talk_enabled``），显隐跟着解耦。
        """
        self._set_setting_rows_visible(
            (
                "self_talk_duration",
                "self_talk_texts",
                "self_talk_images",
                "self_talk_image_chance",
            ),
            self_talk_enabled or self.click_self_talk_check.isChecked(),
            dependency="self_talk_content",
        )

    def _update_click_self_talk_controls(self, enabled: bool) -> None:
        """点击自言自语（``click_self_talk``）的后续项显隐。

        预缓存也跟这里：只有点击链路才会把台词**读出来**（周期气泡只显示不朗读），
        所以点击开关关着时预缓存没有意义。内容项与周期气泡共用，见
        :meth:`_update_self_talk_content_controls`（任一开启即显示）。
        """
        keys = (
            "click_self_talk_speak",
            "click_self_talk_precache",
            "click_talk_bindings",
        )
        self._set_setting_rows_visible(keys, enabled, dependency="click_self_talk")
        self._update_self_talk_content_controls(self.self_talk_check.isChecked())

    def _update_island_controls(self, enabled: bool) -> None:
        settings_pet_controls._update_island_controls(self, enabled)

    def _update_island_icon_controls(self, enabled: bool) -> None:
        settings_pet_controls._update_island_icon_controls(self, enabled)

    def _update_island_info_controls(self, enabled: bool) -> None:
        settings_pet_controls._update_island_info_controls(self, enabled)

    def _update_island_custom_text(self, _index: int | None = None) -> None:
        settings_pet_controls._update_island_custom_text(self, _index)

    def _update_egg_controls(self, enabled: bool) -> None:
        self._set_setting_rows_visible(
            ("egg_title", "egg_hint", "egg_avatar", "egg_image_dir"),
            enabled,
            dependency="egg_enabled",
        )

    def _update_collision_controls(self, enabled: bool) -> None:
        self._set_setting_rows_visible(
            (
                "collision_sound_enabled",
                "collision_restitution",
                "collision_friction",
                "collision_mass_scale",
                "collision_impulse_cap",
                "collision_sound_volume",
            ),
            enabled,
            dependency="collision_enabled",
        )
        self._update_collision_sound_controls(self.collision_sound_check.isChecked())

    def _update_collision_sound_controls(self, enabled: bool) -> None:
        self._set_setting_rows_visible(
            ("collision_sound_volume",),
            enabled,
            dependency="collision_sound_enabled",
        )

    def _set_setting_rows_visible(
        self,
        keys: tuple[str, ...],
        visible: bool,
        *,
        dependency: str = "parent",
    ) -> None:
        """Show dependent settings as a complete group and repair card dividers."""
        cards: set[SettingsCard] = set()
        sections: set[SettingsSection] = set()
        for key in keys:
            row = self.findChild(SettingRow, f"settingRow_{key}")
            if row is None:
                continue
            dependencies = getattr(row, "_visibility_dependencies", {})
            dependencies[dependency] = bool(visible)
            row._visibility_dependencies = dependencies
            row.setVisible(all(dependencies.values()))
            card = row.parentWidget()
            if isinstance(card, SettingsCard):
                cards.add(card)
                section = card.parentWidget()
                if isinstance(section, SettingsSection):
                    sections.add(section)
        for section in sections:
            section.refresh_dependency_visibility()
        for card in cards:
            card.refresh_separators()

    def _populate_menu_fonts(self) -> None:
        if shiboken6.isValid(self) is False or self._menu_fonts_populated:
            return
        self._menu_fonts_populated = True
        appearance = self.config.get("context_menu_appearance", DEFAULT_CONTEXT_MENU_APPEARANCE)
        for family in _system_font_families():
            if self.menu_font_select.findData(family) < 0:
                self.menu_font_select.addItem(family, family)
        current_font = str(appearance.get("ui_font") or "system")
        if self.menu_font_select.findData(current_font) < 0:
            self.menu_font_select.addItem(current_font, current_font)
        self.menu_font_select.setCurrentData(current_font)

    def _open_click_talk_bindings(self) -> None:
        from .click_talk_dialog import ClickTalkBindingsDialog

        click_names = None
        parent = self.parent()
        if parent is not None and hasattr(parent, "clicks") and parent.clicks:
            click_names = list(parent.clicks)
        dialog = ClickTalkBindingsDialog(self.config, click_names=click_names, parent=self)
        dialog.exec()

    def _preview_click_sound(self) -> None:
        """试听当前选择的点击音效配置（不保存配置）。"""
        from .click_sound import choose_sound, play_sound, resolve_click_sound_candidates

        pack = self.click_sound_picker.value()
        candidates = resolve_click_sound_candidates(pack, self.config.dir)
        sound_file = choose_sound(candidates)
        if sound_file:
            vol = float(self.click_sound_volume_spin.value()) / 100.0
            play_sound(sound_file, volume=vol)

    def _import_dialogue_template_json(self) -> None:
        """Import a complete persona template from the inline JSON editor."""
        settings_pet_controls._import_dialogue_template_json(self)

    def _current_dialogue_template(self) -> dict:
        return settings_pet_controls._current_dialogue_template(self)

    def _export_dialogue_template(self) -> None:
        """Export the complete current template to the clipboard (no file dialog)."""
        settings_pet_controls._export_dialogue_template(self)

    def _update_click_sound_controls(self, enabled: bool) -> None:
        for row_key in ("click_sound_pack", "click_sound_volume", "click_sound_preview"):
            row = self.findChild(SettingRow, f"settingRow_{row_key}")
            if row is not None:
                row.setVisible(bool(enabled))
                card = row.parentWidget()
                if isinstance(card, SettingsCard):
                    card.refresh_separators()

    def _update_golden_spin_controls(self, enabled: bool) -> None:
        """“点击触发黄金回旋”总开关控制“跳过动画”子开关可见性。"""
        row = self.findChild(SettingRow, "settingRow_golden_spin_direct")
        if row is not None:
            row.setVisible(bool(enabled))
            card = row.parentWidget()
            if isinstance(card, SettingsCard):
                card.refresh_separators()

    def _update_translucency_controls(self, enabled: bool) -> None:
        self._set_setting_rows_visible(("menu_opacity",), enabled)

    def _update_spawn_size_controls(self, inherit_size: bool) -> None:
        """“生小肥鱼继承大小”关闭时才显示独立小肥鱼大小选择。"""
        self._set_setting_rows_visible(
            ("spawn_scale",),
            not bool(inherit_size),
            dependency="spawn_inherit_size",
        )

    def _on_clear_spawned_pets(self) -> None:
        """一键静默退出所有小肥鱼（slot-N）；它们的设置与数据保留。

        优先走 PetWindow 上已接线的 ``on_clear_spawned_pets``（= AppShell 路径，
        含进程内子窗前置于关闭）；拿不到回调（独立设置进程：本进程既无桌宠壳也
        无 sprite 世界）时统一走 **D12 指令通道**：写指令文件，由主进程
        （OverlayShell / AppShell）经 config 目录 watcher + 轮询消费。

        **这是全局动作，target 由"身份是不是主宠"决定，不由身份字符串真值决定**（判据与
        ``settings_slot_config.is_main_identity`` 同源 = slot 号，不是字符串）：主身份 →
        ``target=None``（= 退全部子肥鱼，两个消费者的"No target"分支），子宠身份 → 该子槽。
        旧写法回填 ``slot_from_instance_id(instance_id)``，而 slot0 从 G1 起有显式
        ``slot-0`` 身份 ⇒ 主宠页写出 ``target=0``，消费者把它当**子槽**去 ``_spawned`` 里找
        （主 sprite 不在其中）→ 静默 no-op。

        4.4a：legacy 的跨进程 taskkill 回退（child_pet_cleanup / runtime 标记 / slot 锁）
        随多进程多宠退役层停用——两个拓扑现在共用同一条指令通道，不再有拓扑分叉。

        批 I：无确认框无结果框（操作不删数据可重新生成，子肥鱼消失即反馈）。
        """
        callback = getattr(self.parentWidget(), "on_clear_spawned_pets", None)
        if callable(callback):
            callback()
            return
        from .overlay_settings_command import (
            CMD_EXIT_SPAWNED_PETS,
            slot_from_instance_id,
            write_command,
        )
        from .settings_slot_config import is_main_identity
        target = (None if is_main_identity(self.config.instance_id)
                  else slot_from_instance_id(self.config.instance_id))
        if write_command(self.config.dir, CMD_EXIT_SPAWNED_PETS, target=target):
            logging.info("退出子肥鱼：已写下指令（target=%s，主进程消费）", target)
        else:
            logging.warning("退出子肥鱼：写指令文件失败，本次未执行")

    def _apply_click_sound_enabled_now(self, checked: bool) -> None:
        """点击音效开关即时生效，不等对话框关闭（写盘前 reload，理由同上）。"""
        self.config.reload()
        self.config.set("click_sound_enabled", bool(checked))
        self.config.save()
        if bool(checked):
            # 开启后立即预热，保证不关闭对话框直接试听/点击也有声音。
            warm_click_sound_effects(
                self.config.get("click_sound_pack"),
                data_dir=self.config.dir,
            )

    def move_away_from_pet(self) -> None:
        """把窗口定位到不与桌宠相交的位置。

        在 show() 之前调用（_present_dialog 的 before_present），窗口首帧
        即落在最终位置，避免 Windows 上"先显示默认位置再跳走"的两段式。
        """
        if self._positioned_away:
            return
        self._positioned_away = True
        parent = self.parentWidget()
        if parent is not None and parent.isVisible():
            self._move_away_from(parent.geometry())
            return
        if self.standalone:
            # 独立进程没有桌宠窗口：改读配置目录 runtime 状态文件取桌宠位置；
            # 读不到返回 None，保持默认位置（不许崩、也不许静默乱跳）。
            from .settings_standalone import standalone_pet_geometry

            pet_geo = standalone_pet_geometry(self.config)
            if pet_geo is not None:
                self._move_away_from(pet_geo)

    def showEvent(self, event) -> None:  # noqa: N802 (Qt 命名)
        super().showEvent(event)
        # 兜底：未经 _present_dialog 直接 show 的路径仍要避让桌宠
        self.move_away_from_pet()
        if not getattr(self, "_initial_focus_assigned", False):
            self._initial_focus_assigned = True
            self.sidebar.setFocus(Qt.FocusReason.OtherFocusReason)

    def _move_away_from(self, pet_geo: QRect) -> None:
        """首次显示时把窗口移到不与桌宠相交的位置（右侧优先，再左侧/下方/上方）"""
        size = self.size()
        screen = self.screen() or QApplication.primaryScreen()
        avail = screen.availableGeometry() if screen is not None else QRect()
        for rect in (
            QRect(pet_geo.right() + 12, pet_geo.top(), size.width(), size.height()),
            QRect(pet_geo.left() - 12 - size.width(), pet_geo.top(), size.width(), size.height()),
            QRect(pet_geo.left(), pet_geo.bottom() + 12, size.width(), size.height()),
            QRect(pet_geo.left(), pet_geo.top() - 12 - size.height(), size.width(), size.height()),
        ):
            if avail.contains(rect):
                self.move(rect.topLeft())
                return

    def _page_shell(self, title: str, content: QWidget) -> QWidget:
        # 默认最大阅读宽度见 CONTENT_READING_MAX_WIDTH；「菜单」域的内容自己声明更宽的值。
        content_max_width = int(content.property("contentMaxWidth") or CONTENT_READING_MAX_WIDTH)
        page = _SettingsPageShell(content_max_width, self.pages)
        if self.pc_mode:
            page.setObjectName("pcSettingsPage")
            page.setAttribute(Qt.WidgetAttribute.WA_StyledBackground)
            for disclosure in content.findChildren(SettingsDisclosureHeader):
                disclosure.use_chat_chevron()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(30, 24, 28, 20)
        layout.setSpacing(12)
        heading_host = QWidget(page)
        heading_host.setObjectName("pageHeader")
        heading_host.setMaximumWidth(content_max_width)
        heading_host.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        heading_layout = QVBoxLayout(heading_host)
        heading_layout.setContentsMargins(0, 0, 0, 0)
        heading_layout.setSpacing(0)
        heading = QLabel(title, heading_host)
        heading.setObjectName("pageTitle")
        heading_layout.addWidget(heading)
        page.heading_host = heading_host
        layout.addWidget(heading_host, 0, Qt.AlignmentFlag.AlignHCenter)
        scroll = QScrollArea(page)
        scroll.setObjectName("settingsScroll")
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setAlignment(Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop)
        content.setMaximumWidth(content_max_width)
        scroll.setWidget(content)
        layout.addWidget(scroll, 1)
        return page

    def select_page(self, label: str) -> bool:
        """按侧栏标题选中页面，供右键菜单/更新通知做深链接。"""
        target = str(label or "").strip()
        for index in range(self.sidebar.count()):
            if self.sidebar.item(index).text() == target:
                self.sidebar.setCurrentRow(index)
                return True
        return False

    def _add_page(self, label: str, icon_name: str, page: QWidget) -> None:
        self.sidebar.addItem(settings_sidebar_item(self, label, icon_name))
        self.pages.addWidget(page)

    def _rebuild_domain_navigation(self) -> None:
        """Move existing rows into stable capability domains without cloning state."""
        old_pages = {self.sidebar.item(index).text(): self.pages.widget(index) for index in range(self.pages.count())}
        all_rows = list(self.findChildren(SettingRow))
        claimed: set[SettingRow] = set()

        def claim(*setting_ids: str) -> list[SettingRow]:
            rows = []
            for setting_id in setting_ids:
                row = self.findChild(SettingRow, f"settingRow_{setting_id}")
                if row is not None and row not in claimed:
                    claimed.add(row)
                    rows.append(row)
            return rows

        def claim_prefix(prefix: str) -> list[SettingRow]:
            rows = [row for row in all_rows if row.objectName().startswith(f"settingRow_{prefix}") and row not in claimed]
            claimed.update(rows)
            return rows

        def page_content(sections) -> QWidget:
            content = QWidget(self)
            layout = QVBoxLayout(content)
            layout.setContentsMargins(0, 0, 0, 0)
            layout.setSpacing(18)
            for section in sections:
                if isinstance(section, QWidget):  # 已构造好的块（折叠框等）原样进布局
                    layout.addWidget(section)
                    continue
                title, rows, *options = section
                rows = [row for row in rows if row is not None]
                if rows:
                    layout.addWidget(
                        SettingsSection(
                            title,
                            rows,
                            content,
                            advanced=bool(options and options[0]),
                        )
                    )
            layout.addStretch(1)
            return content

        general = page_content(
            [
                ("应用启动", claim("autostart")),
                # 「光标隐藏时自动穿透」回主组：它也是窗口旗标类偏好（与置顶/全屏隐藏同族），
                # 用户找它会先看这一组；原先跟「直播捕获」一起塞进"Windows 兼容"是埋掉了它。
                ("窗口与系统", claim("dock_icon", "on_top", "auto_hide_fullscreen", "cursor_hidden_passthrough", "cross_screen")),
                ("免打扰", settings_quiet.build_quiet_rows(self) if self.pc_mode else []),
                # 「直播捕获兼容」单独进一层折叠：行说明有四段（重启级切换、OBS 捕获方式、
                # 平台限制、作用域），平铺在首屏就是逼用户读完。组描述只写一句"这一项做什么"，
                # 重启/平台限制/作用域全部留在行内（展开即见全文），搜索照旧可达。
                ("直播捕获（高级）", claim("stream_capture"), True),
                # 「多开」分组已随拓扑收口 Phase A 隐藏（见上方注释）
            ]
        )
        # 碰撞音效 2 行按 2026-09-17 定稿口径留在「桌宠」：开关紧跟碰撞开关，
        # 音量随物理参数进「碰撞参数（高级）」。
        collision_primary = claim("collision_enabled", "collision_sound_enabled")
        collision_advanced = claim(
            "collision_restitution",
            "collision_friction",
            "collision_mass_scale",
            "collision_impulse_cap",
            "collision_sound_volume",
        )
        # 音乐关联的故障恢复参数（标题格式 + 播放器路径）另立高级组：组名直说用途。
        # 组序裁定：高频组按使用频率递减（标签 1 内音乐关联第 2），高级组垫底其标签页。
        music_advanced = (
            claim("foobar_title_format") + settings_music.build_music_player_rows(self))
        # 「桌宠」域（2026-10-08 第二刀）：域内是两个**互斥任务**——「它长什么样 /
        # 唱不唱歌」与「它怎么动 / 怎么撞」，页内切成两个标签，首屏只管一个任务。
        # 侧栏 10 域是外部契约（深链/搜索跳域语义不变）；搜索命中另一标签的行时由
        # _search_settings 的 activate_for_descendant 自动切标签。
        pet = SettingsTabContainer(self)
        pet.addTab(
            "display_music",
            "显示与音乐",
            page_content(
                [
                    ("显示", claim("scale", "bubble_text_scale", "pet_opacity")),
                    ("音乐关联", claim("music_sing", "music_lyric", "music_lyric_lead", "music_browser_media", "foobar_lyrics")),
                    (settings_music.advanced_group_title(self), music_advanced, True),
                ]
            ),
        )
        pet.addTab(
            "motion_collision",
            "动作与碰撞",
            page_content(
                [
                    ("动画与移动", claim("playback_speed", "animation_gap", "idle_low_fps", "no_move")),
                    ("拖拽与弹射", claim("drag_physics", "drop_gravity", "throw_strength", "slingshot_enabled", "lock_position", "shift_drag")),
                    ("边缘探头", claim("edge_probe")),
                    ("生小肥鱼", claim("spawn_inherit_size", "spawn_scale", "clear_spawned_pets")),
                    ("多开碰撞", collision_primary),
                    ("碰撞参数（高级）", collision_advanced, True),
                ]
            ),
        )
        # 「互动」域（2026-09-22 分页）：整页在本模块构建（settings_interaction，
        # 行数预算原因），页内用任务标签分成「点击与音效 / 自言自语」两个同级任务；
        # 行不进 all_rows 快照，因此不需要 claim，也不会掉进「待分类（开发期）」。
        interaction = settings_interaction.build_interaction_domain(self)
        # 点击音效 4 行与 click_self_talk / click_balance / click_talk_bindings
        # 同享 click_ 前缀，按 2026-09-17 定稿口径整组留在 interaction 域。
        menu = SettingsTabContainer(self)
        menu.addTab(
            "layout",
            "菜单编排",
            page_content(
                [
                    ("内容与布局", claim("context_menu_layout") + settings_network.build_menu_rows(self)),
                ]
            ),
        )
        menu.addTab(
            "launcher",
            "快捷启动",
            page_content(
                [
                    ("已配置应用", claim("quick_launch_apps")),
                ]
            ),
        )
        menu.addTab(
            "appearance",
            "外观",
            page_content(
                [
                    ("菜单外观", claim("menu_theme", "menu_density", "menu_radius", "menu_font", "menu_font_size", "menu_translucent", "menu_opacity")),
                    (
                        "高级配色",
                        claim(
                            "light_background",
                            "light_foreground",
                            "light_hover",
                            "dark_background",
                            "dark_foreground",
                            "dark_hover",
                        ),
                        True,
                    ),
                    ("彩蛋入口", claim_prefix("egg_")),
                ]
            ),
        )
        menu.setProperty("contentMaxWidth", 1240)
        island_rows = settings_page_guide.rows_in_layout_order(old_pages.get("灵动岛", QWidget()))  # 布局顺序，不是创建顺序
        claimed.update(island_rows)
        # 网络延迟检测（高级）只能在**最终域装配处**拆：旧岛页整节会被摊平进同一个
        # 「桌面胶囊（灵动岛）」卡片（R2 §一-2）。只拆探测间隔行，其余岛行不动。
        interval_rows = [row for row in island_rows
                         if row.objectName() == "settingRow_network_probe_interval"]
        island_rows = [row for row in island_rows if row not in interval_rows]
        desktop_components = page_content(
            [
                ("桌面胶囊（灵动岛）", island_rows),
                ("网络延迟检测（高级）", interval_rows, True),
            ]
        )
        # 全行被前置开关藏起来的组不留在页面上（高级组尤其：空了就是一条误导标题）。
        for section in desktop_components.findChildren(SettingsSection):
            if section.rows and all(row.isHidden() for row in section.rows):
                section.setVisible(False)

        ai_sections = None
        if self.ai_page is not None:
            balance_rows = claim_prefix("balance_")
            appearance_rows = claim(
                "chat_ui_style", "chat_background", "chat_background_file", "chat_background_opacity", "chat_background_fill", "chat_bg_crops", "modern_chat_card_opacity"
            )
            ai_sections = page_content(
                [
                    ("API 列表", claim("provider_list")),
                    (
                        "模型与连接",
                        claim(
                            "provider_name",
                            "api_url",
                            "model",
                            "api_key",
                            "system_prompt",
                            "connection_test",
                        ),
                    ),
                    (
                        "深度思考与联网",
                        claim(
                            "thinking_mode",
                            "reasoning_effort",
                            "web_search_enabled",
                            "web_search_engine",
                            "web_search_key",
                            "web_search_max_results",
                            "web_search_fetch_pages",
                        ),
                    ),
                    ("系统通知", claim("system_notifications_enabled")),
                    (
                        "视觉能力",
                        claim(
                            "vision_same",
                            "vision_model",
                            "vision_url",
                            "vision_key",
                        ),
                    ),
                    (
                        "生成参数（高级）",
                        claim(
                            "timeout",
                            "temperature",
                            "max_tokens",
                            "skip_ssl",
                        ),
                        True,
                    ),
                    ("对话窗口", appearance_rows),
                    ("余额与服务状态", balance_rows),
                ]
            )
            ai_sections.setObjectName("settingsDomain_ai")
            # Keep the control owner alive for save/dependency behavior, but
            # visible rows now belong directly to the shared domain layout.
            self.ai_page.setParent(self)
            self.ai_page.hide()

        voice_chime_rows = self.voice_chime_page.findChildren(SettingRow) if self.voice_chime_page else []
        claimed.update(voice_chime_rows)
        # 节日提醒的行**也要在这里登记**：本页的行从构造起就挂在自己的持有容器里
        # （无父的 SettingRow 一旦 setVisible 就是个顶层窗口，用户会看到无标题小窗闪
        # ——上游 #261 修的就是这个），因此 findChildren 现在取得到它们。不登记就会
        # 掉进「待分类（开发期）」——它们稍后由 build_domain_page 现造卡片收进「语音」域。
        festival_rows = self.festival_page.findChildren(SettingRow) if self.festival_page else []
        claimed.update(festival_rows)
        dialogue_rows = claim_prefix("dialogue_")
        # 「自定义台词」＝一个可折叠框（默认折叠）：逐事件文案行全部收进去，
        # 不用自定义台词的用户不该翻过整页文案框；搜索命中时会自动展开
        # （见 _search_settings）。全局风格控件（表达风格/专属文案对象/模板 JSON）
        # 不是事件文案，单独放「文案风格与模板」小节。
        phrases_box = CollapsibleGroup("自定义台词（逐事件文案）", self)
        phrase_edit_keys = set(self.dialogue_phrase_edits)
        phrase_rows = [row for row in dialogue_rows
                       if row.objectName()[len("settingRow_dialogue_"):] in phrase_edit_keys]
        ungated_dialogue_rows = [row for row in dialogue_rows
                                 if row.objectName()[len("settingRow_dialogue_"):] not in phrase_edit_keys]
        if phrase_rows:
            phrases_box.add_group("事件气泡文案", phrase_rows)
        phrases_box.set_expanded(False)
        self.dialogue_phrases_box = phrases_box
        automation = page_content(
            [
                ("待办提醒", claim("todo_reminder_enabled", "todo_reminder_lead_minutes", "todo_reminder_speak")),
                # 「免打扰」两行在本模块构建（settings_quiet，行数预算原因）。
                ("免打扰", [] if self.pc_mode else settings_quiet.build_quiet_rows(self)),
                ("文案风格与模板", ungated_dialogue_rows),
                phrases_box,
            ]
        )

        # 「语音」总域（2026-09-17 定稿口径）：只收鱼开口说话（TTS）类设置——
        # 语音报时整组 + 节日提醒整组（原「自动化与联动」域，带 speak/TTS 播报
        # 能力）。音效类回各自功能分组：点击音效 4 行回「互动 · 点击反馈」、
        # 碰撞音效回「桌宠」碰撞组。节日提醒由
        # festival_settings 自己建卡交给本域：本域不能按「一组行」收它——页面容器
        # 会散架、四段分组标题会跟着丢（见 docs/SETTINGS-CHANGE-GATES.md 节日提醒
        # 准入记录）。故这里不用 page_content，自己起一层容器。
        voice = QWidget(self)
        voice_layout = QVBoxLayout(voice)
        voice_layout.setContentsMargins(0, 0, 0, 0)
        voice_layout.setSpacing(18)
        if voice_chime_rows:
            voice_layout.addWidget(SettingsSection("语音报时", voice_chime_rows, voice))
        if self.festival_page is not None:
            voice_layout.addWidget(self.festival_page.build_domain_page(voice))
        voice_layout.addStretch(1)
        # 语音报时的行刚被搬进这张平卡（容器散架、行序即创建序）：让设置页按当前
        # 后端重新排一遍——当前后端平铺在最上面，其余后端各占一行折叠头。
        if self.voice_chime_page is not None:
            self.voice_chime_page.refresh_backend_rows()
        # 节日提醒的行同样被搬进这张平卡：摆正「常用项在前 + 少用项折叠」的行序。
        if self.festival_page is not None:
            self.festival_page.refresh_backend_rows()

        # 「文件识别」域（2026-09-19 新增）：拖文件解读的设置集中在此独立页。
        # 行在本模块构建（settings_file_interpret，行数预算原因），不走 claim。
        file_interpret = None if self.pc_mode else settings_file_interpret.build_file_interpret_page(self)

        # Preserve any newly added row until it receives an explicit domain decision.
        leftovers = [row for row in all_rows if row not in claimed and (self.ai_page is None or not self.ai_page.isAncestorOf(row))]
        if leftovers:
            layout = automation.layout()
            layout.insertWidget(max(0, layout.count() - 1), SettingsSection("待分类（开发期）", leftovers, automation))

        while self.pages.count():
            self.pages.removeWidget(self.pages.widget(0))
        self.sidebar.clear()
        if self.pc_mode:
            from .local_model_settings import LocalModelSettingsPage
            self.local_model_page = LocalModelSettingsPage(self)
            self._add_page("模型与 API", "chat", self._page_shell("模型与 API", self.local_model_page))
            from .local_token_settings import LocalTokenSettingsPage
            self.local_token_page = LocalTokenSettingsPage(self, client=self.local_model_page.client)
            self._add_page("Token 用量", "chat", self._page_shell("Token 用量", self.local_token_page))
            from .local_persona_settings import LocalPersonaSettingsPage
            self.local_persona_page = LocalPersonaSettingsPage(self, client=self.local_model_page.client)
            self._add_page("人格与称呼", "chat", self._page_shell("人格与称呼", self.local_persona_page))
            from .local_memory_settings import LocalMemorySettingsPage
            from .local_voice_settings import LocalVoiceSettingsPage
            from .local_companion_settings import LocalCompanionSettingsPage
            from .local_browser_settings import LocalBrowserSettingsPage
            self.local_memory_page = LocalMemorySettingsPage(self, client=self.local_model_page.client)
            self.local_voice_page = LocalVoiceSettingsPage(self, client=self.local_model_page.client)
            self.local_companion_page = LocalCompanionSettingsPage(self, client=self.local_model_page.client)
            self.local_browser_page = LocalBrowserSettingsPage(self, client=self.local_model_page.client)
            for label, page in (("记忆", self.local_memory_page), ("语音与表情", self.local_voice_page),
                                ("主动与情绪", self.local_companion_page), ("浏览器", self.local_browser_page)):
                self._add_page(label, "chat", self._page_shell(label, page))
        domain_content = {
            "常规": general,
            "桌宠": pet,
            "互动": interaction,
            "菜单": menu,
            "桌面组件": desktop_components,
            "AI 与对话": ai_sections,
            "自动化与联动": None if self.pc_mode else automation,
            "语音": None if self.pc_mode else voice,
            "文件识别": file_interpret,
            "更新": self.update_page,
        }
        for label, icon in SETTINGS_DOMAIN_NAV:
            content = domain_content.get(label)
            if content is None:
                continue
            self._add_page(label, icon, self._page_shell(label, content))
        for page in old_pages.values():
            page.deleteLater()
        # 域页全部装好之后再装「按区直找」：页头跳转条 + 每个分区的组描述。
        settings_page_guide.install(self)

    def _clear_search_matches(self) -> None:
        for row in self._search_rows:
            if row.property("searchMatch"):
                row.setProperty("searchMatch", False)
                row.style().unpolish(row)
                row.style().polish(row)

    def _focus_search_box(self) -> None:
        """把焦点送进侧栏搜索框并全选（Ctrl+F；不改变已输入的内容之外的状态）。"""
        self.search_edit.setFocus(Qt.FocusReason.ShortcutFocusReason)
        self.search_edit.selectAll()

    def _search_settings(self, query: str, *, advance: int = 0) -> None:
        """执行搜索；``advance`` 是**步长**（回车/↓ = +1、↑ = -1、0 = 不主动翻页）。

        用步长而不是"要不要前进"的布尔：↑ 需要反方向，取模天然支持回绕
        （第一条上按 ↑ 落到最后一条），不必为回绕写特判。

        ``advance=0`` 是"不主动翻页"，**不是"重新开始"**：命中集合没变时保持当前
        索引，只有集合变了（`:2166` 那支）才归零。
        """
        query = query.strip().lower()
        self._clear_search_matches()
        if not query:
            self._search_matches = []
            self._search_index = -1
            self.search_status.hide()
            return
        matches = settings_search.find_matches(self._search_rows, query)
        if not matches:
            self._search_matches = []
            self._search_index = -1
            self.search_status.setText("未找到匹配的设置")
            self.search_status.show()
            return
        if matches != self._search_matches:
            self._search_matches = matches
            self._search_index = 0
        elif advance:
            self._search_index = (self._search_index + advance) % len(matches)
        row = matches[self._search_index]
        row.setProperty("searchMatch", True)
        row.style().unpolish(row)
        row.style().polish(row)
        page_index = 0
        for index in range(self.pages.count()):
            if self.pages.widget(index).isAncestorOf(row):
                page_index = index
                break
        self.sidebar.setCurrentRow(page_index)
        page = self.pages.widget(page_index)
        # 命中折叠里的行要先把它露出来，否则「搜索结果存在但看不见」。
        # 折叠有两种形态，交给 settings_widgets.reveal_settings_row 一处管：
        # ① CollapsibleGroup / 高级组 / 页内标签是 QWidget 嵌套（判祖先即可）；
        # ② 语音报时与节日提醒的后端参数行是**行级**折叠（那批行会被搬进一张
        #    平卡，容器活不下来，所以折叠状态落在行上的 _reveal_fold 回调里）。
        # 只判祖先会漏掉 ②：搜索命中「豆包音色」这类行时它仍藏在折叠后端里。
        reveal_settings_row(row, page)
        scroll = page.findChild(QScrollArea, "settingsScroll")
        if scroll is not None:
            scroll.ensureWidgetVisible(row, 0, 24)
        # 依赖不满足的行：只给可见说明，绝不替用户改配置（R2 §一-3）。
        note = "" if row.isVisibleTo(page) else f"（{self._hidden_prerequisite_note(row)}）"
        self.search_status.setText(
            f"{self._search_index + 1}/{len(matches)} · {row.label.text()}{note}")
        self.search_status.show()

    def _hidden_prerequisite_note(self, row: SettingRow) -> str:
        """命中行被前置开关隐藏时，指名要先去打开的那一项。"""
        key = row.objectName()[len("settingRow_"):]
        source_id = _SEARCH_HIDDEN_PREREQUISITES.get(key)
        source = self.findChild(SettingRow, f"settingRow_{source_id}") if source_id else None
        if source is None:
            return "当前被前置开关隐藏"
        return f"需先开启「{source.label.text()}」"

    def eventFilter(self, watched, event) -> bool:  # noqa: N802
        if watched is self.search_edit and event.type() == QEvent.Type.KeyPress:
            # 回车 / ↓ 前进、↑ 后退。只在**裸键**（或小键盘键）时拦：带 Ctrl/Alt/Shift
            # 的 ↑/↓ 一律透传——输入法候选导航、以及将来可能加的组合键，不该被搜索抢走。
            # 单行 QLineEdit 里裸 ↑/↓ 本来没有默认行为，拦掉不损失任何既有操作。
            if event.modifiers() in (Qt.KeyboardModifier.NoModifier,
                                     Qt.KeyboardModifier.KeypadModifier):
                step = {
                    Qt.Key.Key_Return: 1,
                    Qt.Key.Key_Enter: 1,
                    Qt.Key.Key_Down: 1,
                    Qt.Key.Key_Up: -1,
                }.get(event.key())
                if step is not None:
                    self._search_settings(self.search_edit.text(), advance=step)
                    return True
        return super().eventFilter(watched, event)

    def _apply_selected_theme(self, *_args) -> None:
        theme = str(self.menu_theme_select.currentData() or "system")
        dark = theme == "dark" or (theme == "system" and _system_dark())
        self.setProperty("settingsDark", dark)
        self.setStyleSheet(_settings_stylesheet(theme, pc_mode=self.pc_mode))
        # 图标是位图：QSS 换了它不会自己换色，按记录的名字重画（见 settings_widgets）。
        refresh_settings_icons(self)
        if self.pc_mode:
            self.menu_layout_editor.refresh_theme_icons()
        for control in self.findChildren(ModernSelect):
            if control._popup is not None:
                control._popup.setStyleSheet(control.popupStyleSheet())
            control.update()
        for popup in self.findChildren(QMenu):
            if popup.property("settingsPopup"):
                configure_settings_action_popup(popup)
        for control in self.findChildren(ToggleSwitch):
            control.update()

    def _apply_autostart(self) -> None:
        """应用「开机自启」开关：仅在实际改动时写入系统登录项。

        保存按钮与直接关闭（X / Esc）共用，保证三条路径行为一致。
        """
        if not self.pc_mode and self.autostart_check.isChecked() != self._autostart_initial:
            # set_enabled 返回 bool（enable()/disable()）；仅在明确失败时提示。
            ok = autostart_mod.set_enabled(self.autostart_check.isChecked())
            if ok is False:
                QMessageBox.warning(
                    self,
                    "开机自启设置失败",
                    "写入开机自启失败：可能被安全软件拦截。\n可稍后在托盘菜单重试，或检查安全软件/系统优化工具的拦截记录。",
                )

    def _local_settings_pages(self):
        for label, name in (("模型与 API", "local_model_page"), ("Token 用量", "local_token_page"), ("人格与称呼", "local_persona_page"),
                ("记忆", "local_memory_page"), ("语音与表情", "local_voice_page"), ("主动与情绪", "local_companion_page"),
                ("浏览器", "local_browser_page")):
            page = getattr(self, name, None)
            if page is not None:
                yield label, page

    def _save(self) -> None:
        """「保存并退出」：写入配置并关闭对话框（失败走同一条关闭闸门）。"""
        for label, page in self._local_settings_pages():
            if page.dirty:
                self.select_page(label)
                page.save_and_then(self._save)
                return
        if not self._save_before_close():
            return
        # 闸门这次关闭已经做过决定（落盘成功，或用户明确选择放弃）：这里只负责关窗，
        # 并闸住关闭路径再写一遍整表（放弃时尤其不能写——那正是要放弃的东西）。
        self._saved_via_button = True
        self.accept()

    def _write_config(self) -> bool:
        """把当前控件值写入 config 并落盘（按钮与直接关闭共用）。

        保存前从磁盘重读：吸收外部对本对话框未暴露字段的改动。
        standalone 下这条尤其关键——主进程在设置开着期间会自己写 config
        （托盘菜单开关等），不 reload 就把别人的改动回滚了。
        已知限制：已暴露字段仍是 last-writer-wins（对话框获胜）。
        返回是否成功落盘；失败**不在这里弹**——把类别记进 ``self._write_failure``，
        由关闭闸门（``pet/settings_close_flow``）统一给文案与「放弃未保存的改动并关闭」
        出口（自己再弹一次就是同一件事弹两遍，且那两个出口只有闸门知道）。
        """
        self._write_failure = None
        menu_layout_value = self.menu_layout_editor.value()
        menu_validation = resolve_menu_layout(
            menu_layout_value,
            registered_actions=MENU_ACTIONS.ids,
            available_actions=MENU_ACTIONS.ids,
        )
        if menu_validation.source == "fallback":
            self._write_failure = settings_close_flow.layout_failure(
                menu_validation.diagnostics)
            return False
        self.config.reload()
        minimum = min(self.min_spin.value(), self.max_spin.value())
        maximum = max(self.min_spin.value(), self.max_spin.value())
        texts = [line.strip()[:120] for line in self.texts_edit.toPlainText().splitlines() if line.strip()]
        self.config.set("scale", float(self.scale_combo.currentData()))
        self.config.set("spawn_inherit_size", self.spawn_inherit_size_check.isChecked())
        self.config.set("spawn_scale", float(self.spawn_scale_combo.currentData()))
        self.config.set("on_top", self.on_top_check.isChecked())
        if self.dock_icon_check is not None:
            self.config.set("show_dock_icon", self.dock_icon_check.isChecked())
        self.config.set("no_move", self.no_move_check.isChecked())
        self.config.set("mouse_through", self.mouse_through_check.isChecked())
        self.config.set("drag_physics", self.drag_physics_check.isChecked())
        self.config.set("drop_gravity", self.drop_gravity_check.isChecked())
        self.config.set("throw_strength", str(self.throw_strength_select.currentData() or "standard"))
        self.config.set("slingshot_enabled", self.slingshot_check.isChecked())
        self.config.set("collision_enabled", self.collision_enabled_check.isChecked())
        self.config.set("collision_restitution", self.collision_restitution_spin.value())
        self.config.set("collision_friction", self.collision_friction_spin.value())
        self.config.set("collision_mass_scale", self.collision_mass_scale_spin.value())
        self.config.set("collision_impulse_cap", self.collision_impulse_cap_spin.value())
        self.config.set("collision_sound_enabled", self.collision_sound_check.isChecked())
        self.config.set("collision_sound_volume", float(self.collision_sound_volume_spin.value()) / 100.0)
        self.config.set("lock_position", self.lock_position_check.isChecked())
        self.config.set("shift_drag", self.shift_drag_check.isChecked())
        self.config.set("pet_opacity", int(self.pet_opacity_spin.value()))
        click_sound_enabled = self.click_sound_check.isChecked()
        click_sound_pack = self.click_sound_picker.value()
        click_sound_volume = float(self.click_sound_volume_spin.value()) / 100.0
        click_sound_pack_changed = self.config.get("click_sound_pack") != click_sound_pack
        click_sound_enabled_changed = self.config.get("click_sound_enabled") != click_sound_enabled
        self.config.set("click_sound_enabled", click_sound_enabled)
        self.config.set("click_sound_pack", click_sound_pack)
        self.config.set("click_sound_volume", click_sound_volume)
        # 只在真正需要时预热：点击音效处于启用状态，且本次写回改变了启用开关或音效包。
        # 音量变化/未改动不需要重建 QSoundEffect；开关从关到开已由勾选回调即时预热，
        # 因此普通“打开设置再关闭”不应在每次落盘都创建 QtMultimedia 音频对象。
        if click_sound_enabled and (click_sound_enabled_changed or click_sound_pack_changed):
            warm_click_sound_effects(
                click_sound_pack,
                data_dir=self.config.dir,
            )
        existing_island = self.config.get("dynamic_island", {})
        if not isinstance(existing_island, dict):
            existing_island = {}
        self.config.set(
            "dynamic_island",
            {
                "enabled": self.island_enabled_check.isChecked(),
                "show_icon": self.island_icon_check.isChecked(),
                "show_name": self.island_name_check.isChecked(),
                "show_info": self.island_info_check.isChecked(),
                "info_mode": str(self.island_info_mode_select.currentData() or "time"),
                "custom_text": self.island_custom_text_edit.text().strip(),
                "show_status": self.island_status_check.isChecked(),
                "style": str(self.island_style_select.currentData() or "dark"),
                "opacity": float(self.island_opacity_spin.value()),
                "accent": str(self.island_accent_select.currentData() or "blue"),
                "icon": str(self.island_icon_select.currentData() or "auto"),
                "click_action": str(self.island_click_action_select.currentData() or "expand"),
                "hidden_chat": (
                    existing_island.get("hidden_chat", True)
                    if self.pc_mode else self.island_hidden_chat_check.isChecked()
                ),
                "event_effects": self.island_event_effects_check.isChecked(),
                "edge_dock": self.island_edge_dock_check.isChecked(),
                "collision_enabled": self.island_collision_check.isChecked(),
                # 拖拽落点写入的停靠边与位置：设置页不回写，原样保留。
                "dock_edge": existing_island.get("dock_edge", "none"),
                "x": existing_island.get("x"),
                "y": existing_island.get("y"),
            },
        )
        if self.click_balance_check is not None:
            self.config.set("click_show_balance", self.click_balance_check.isChecked())
        self.config.set("click_show_self_talk", self.click_self_talk_check.isChecked())
        self.config.set("self_talk_speak_enabled", self.click_self_talk_speak_check.isChecked())
        self.config.set("self_talk_voice_precache_enabled",
                        self.self_talk_voice_precache_check.isChecked())
        self.config.set("music_sing_enabled", self.music_sing_check.isChecked())
        if getattr(self, "music_lyric_check", None) is not None:
            self.config.set("music_lyric_enabled", self.music_lyric_check.isChecked())
        if getattr(self, "music_lyric_lead_spin", None) is not None:
            self.config.set(
                "music_lyric_lead_seconds", float(self.music_lyric_lead_spin.value())
            )
        settings_music.save_source_settings(self)
        self.config.set("golden_spin_on_click", self.golden_spin_click_check.isChecked())
        self.config.set("golden_spin_direct", self.golden_spin_direct_check.isChecked())
        self.config.set("edge_probe_enabled", self.edge_probe_check.isChecked())
        if self.balance_refresh_spin is not None:
            self.config.set("balance_refresh_minutes", int(self.balance_refresh_spin.value()))
            self.config.set(
                "balance_tier_labels_mode",
                str(self.balance_tier_mode_select.currentData() or "default"),
            )
            self.config.set("balance_tier_label_peak", self.balance_tier_peak_edit.text().strip())
            self.config.set("balance_tier_label_idle", self.balance_tier_idle_edit.text().strip())
            self.config.set("balance_tier_color_enabled", self.balance_tier_color_check.isChecked())
        if self.auto_hide_fullscreen_check is not None:
            self.config.set("auto_hide_fullscreen", self.auto_hide_fullscreen_check.isChecked())
        if getattr(self, "cross_screen_check", None) is not None:
            self.config.set("allow_cross_screen", self.cross_screen_check.isChecked())
        # 「单进程多开」键不落盘控件值：开关已隐藏（拓扑收口 Phase A），
        # 配置字典里加载的原值随 config.save() 原样回写（兼容保留）。
        if self.cursor_hidden_passthrough_check is not None:
            self.config.set("cursor_hidden_passthrough", self.cursor_hidden_passthrough_check.isChecked())
        if self.stream_capture_check is not None:
            self.config.set("stream_capture_mode", self.stream_capture_check.isChecked())
        self.config.set("playback_speed", float(self.speed_select.currentData()))
        self.config.set("animation_gap_seconds", self.gap_spin.value())
        self.config.set("idle_low_fps_enabled", self.idle_low_fps_check.isChecked())
        self.config.set("self_talk_enabled", self.self_talk_check.isChecked())
        self.config.set("self_talk_bubble_style", self.bubble_style_select.currentData())
        self.config.set("self_talk_min_interval", minimum)
        self.config.set("self_talk_max_interval", maximum)
        self.config.set("self_talk_duration_seconds", self.self_talk_duration_spin.value())
        self.config.set("self_talk_texts", texts or list(DEFAULT_SELF_TALK_TEXTS))
        self.config.set("self_talk_image_dir", self.self_talk_image_dir_picker.text())
        self.config.set("self_talk_image_scale", self.self_talk_image_scale_spin.value())
        self.config.set("self_talk_image_chance", self.self_talk_image_chance_spin.value())
        self.config.set("bubble_text_scale", self.bubble_text_scale_spin.value())
        if not self.pc_mode:
            self.config.set("dialogue_mode", str(self.dialogue_mode_select.currentData() or "legacy"))
            settings_pet_controls.save_dialogue_phrases(self)
            self.config.set("todo_reminder_enabled", self.todo_reminder_check.isChecked())
            self.config.set("todo_reminder_lead_minutes", int(self.todo_reminder_lead_spin.value()))
            self.config.set("todo_reminder_speak", self.todo_reminder_speak_check.isChecked())
        # 语音报时设置页写回（voice_chime_* 平铺键 + 各后端字段键）
        if self.voice_chime_page is not None:
            self.voice_chime_page.apply_to_config()
        # 节日提醒设置页写回（仅写 festival_reminder_* / festival_custom_* 10 键）
        if self.festival_page is not None:
            self.festival_page.apply_to_config()
        self.config.set(
            "context_menu_appearance",
            {
                "theme": self.menu_theme_select.currentData(),
                "density": self.menu_density_select.currentData(),
                "corner_radius": self.menu_radius_select.currentData(),
                "ui_font": self.menu_font_select.currentData(),
                "ui_font_size": self.menu_font_size_select.currentData(),
                "translucent": self.menu_translucent_check.isChecked(),
                "opacity": self.menu_opacity_spin.value(),
                "light_background": self.light_background_picker.text(),
                "light_foreground": self.light_foreground_picker.text(),
                "light_hover": self.light_hover_picker.text(),
                "dark_background": self.dark_background_picker.text(),
                "dark_foreground": self.dark_foreground_picker.text(),
                "dark_hover": self.dark_hover_picker.text(),
            },
        )
        default_menu_nodes = load_default_menu_layout().get("nodes", [])
        self.config.set(
            "context_menu_layout",
            None if menu_layout_value.get("nodes") == default_menu_nodes else menu_layout_value,
        )
        self.config.set(
            "menu_easter_egg",
            {
                "enabled": self.egg_enabled_check.isChecked(),
                "title": self.egg_title_edit.text(),
                "hint": self.egg_hint_edit.text(),
                # 内置 assets 内的路径归一化回相对值，保持 portable（目录移动/自更新后仍可用）
                "avatar": store_fun_asset(self.egg_avatar_picker.text(), oijingjing_image_path()),
                "image_dir": store_fun_asset(self.egg_image_dir_picker.text(), oijingjing_image_path().parent),
            },
        )
        self.config.set("quick_launch_apps", self.quick_launch_editor.apps())
        if self.ai_page is not None:
            self.ai_page.save()
        settings_file_interpret.save_file_interpret_settings(self)
        settings_network.save_network_settings(self)
        settings_music.save_music_player_settings(self)
        settings_quiet.save_quiet_settings(self)
        settings_weather.save_weather_settings(self)
        settings_divination.save_divination_settings(self)
        settings_hotkeys.save_hotkey_settings(self)
        if not self.pc_mode:
            self.config.set("autostart_wanted", self.autostart_check.isChecked())
        # 批 C：落种占位语义——仅当用户在该子肥鱼自己的设置界面保存过才置真；
        # 位置自动保存等一切后台写盘不得置位。主配置（slot 0/主肥鱼）保存不置位。
        if self.config.instance_id:
            self.config.set("user_customized", True)
        ok = self.config.save()
        if not ok:
            self._write_failure = settings_close_flow.failure_of(self)
        # 写回之后再对齐一次标记：落盘后的配置值才是「已改过没」的现行答案
        settings_default_marks.refresh(self)
        return ok

    def _on_voice_chime_preview(self, text: str) -> None:
        """语音报时设置页「试听」：透传父级 AppShell 的手动报时入口。

        父级（PetWindow / 对话框宿主）通过 on_voice_chime_now 暴露该能力；
        未接线时静默忽略（仅设置界面无副作用）。
        """
        if self.standalone:
            # 独立进程没有父级 AppShell：改走本地合成+播放通道（懒 import，
            # 启动路径不加载 voice_chime_service/edge-tts）。
            from .settings_standalone import preview_voice_chime

            preview_voice_chime(self, text)
            return
        cb = getattr(self.parent(), "on_voice_chime_now", None)
        if callable(cb):
            cb(text)

    def _close_after_external_write(self) -> None:
        """关窗，但跳过关闭路径的整表写回（``_write_config``）。

        供"已在窗口外完成落盘"的入口使用（当前是「恢复默认设置」）：此时控件里
        持有的仍是落盘前的旧值，关闭路径照常写回就会把刚写下的配置静默覆盖回去。
        """
        self._saved_via_button = True
        self.accept()

    def _save_before_close(self) -> bool:
        """关闭前落盘（X / Esc / 关闭按钮 /「保存并退出」共用）；False = 要留在窗口里继续改。

        落盘、失败文案与出口全在 ``pet/settings_close_flow``：保存成功或用户明确选择
        「放弃未保存的改动并关闭」→ True（调用方照常 accept/reject），用户选「继续编辑」
        → False（不关窗，草稿留在控件里）。这里只回答"这次关闭能不能真的关"。
        """
        local_pages = list(self._local_settings_pages())
        for label, page in local_pages:
            if not page.can_close(commit_discard=False):
                self.select_page(label)
                return False
        outcome = settings_close_flow.save_before_close(self)
        if outcome == settings_close_flow.CLOSE_KEEP_EDITING:
            return False
        # Commit discard only once every page and the original close flow agree.
        for _label, page in local_pages:
            if page.dirty:
                page._baseline = page._snapshot()
        return True

    def reject(self) -> None:  # noqa: N802 - Qt API
        """Esc / 关闭按钮与 X 同契约：保存失败不关窗，除非用户明确选择放弃改动。"""
        if self._save_before_close():
            super().reject()

    def closeEvent(self, event) -> None:  # noqa: N802 - Qt API
        if not self._save_before_close():
            event.ignore()
            return
        super().closeEvent(event)
