"""One reusable native chat window shared by every desktop entry point."""
from live_chat import create_chat_window


class NativeChatController:
    def __init__(self, factory=create_chat_window, settings_opener=None):
        self.window = None
        self.factory = factory
        self.settings_opener = settings_opener

    def open_chat(self):
        if self.window is None:
            self.window = self.factory()
            if self.settings_opener is not None:
                self.window.settings_opener = self.settings_opener
        self.window.showNormal()
        self.window.raise_()
        self.window.activateWindow()


def install_chat_routes(app_module, facade_class):
    def from_island(shell):
        shell._pc_chat.open_chat()

    def from_instance(instance):
        instance.shell._pc_chat.open_chat()

    original = facade_class.on_open_chat

    def from_menu(facade):
        shell = facade._app_shell
        controller = getattr(shell, '_pc_chat', None)
        if controller is not None:
            return controller.open_chat
        return original.fget(facade)

    app_module.AppShell._open_chat_from_island = from_island
    app_module.PetInstance.open_chat = from_instance
    facade_class.on_open_chat = property(from_menu)
