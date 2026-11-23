<h1 align="center">大肥鱼 PC</h1>

<p align="center"><strong>住在 Windows 桌角的 AI 鲸鱼娘</strong></p>

大肥鱼会在屏幕边上闲逛。点点她，她会挥手回应。右键选「聊一聊」，就能和她说话。她能记住你们聊过的事，也能在得到允许后自己去读帖子，带着见闻回来找你。聊天模型由你选，可以接云端 API，也可以用本机 Ollama。

<p align="center"><a href="#主要功能">主要功能</a> · <a href="#从源码运行">在 Windows 上运行</a></p>

<p align="center">
  <img src="assets/readme/coding.webp" width="25%" alt="大肥鱼坐在笔记本电脑前写代码">
  <img src="assets/readme/hello.webp" width="18%" alt="点一下，大肥鱼朝你挥手">
  <img src="assets/readme/violin.webp" width="25%" alt="大肥鱼架起小提琴演奏">
</p>

<p align="center"><sub>写代码、挥手、拉小提琴。公版收录了 106 段角色动画。</sub></p>

## 主要功能

### 桌面互动

大肥鱼闲下来会玩魔方、打瞌睡，也会拿出小提琴。点一下看她怎么回应，按住拖动就能把她挪到屏幕另一边。想让她待在桌角陪你工作，可以在右键菜单里调小角色、选「不移动」，需要时再点「聊一聊」。

### 文字、语音与表情

聊天窗口可以翻看以前的对话，也可以为新话题另开一段。配好语音服务后，点麦克风说话，识别出的文字可以先改再发。想听大肥鱼的声音，可以开启「偶尔语音回复」，收到语音条后点一下播放，右键可以转成文字。装好本地表情包后，你和她都能在文字旁配上一张表情。

### 长期记忆

大肥鱼能记住两类容易在长聊中丢掉的细节。一类是你随口说过的事，比如你养了哪只猫、最近在忙什么。开启「自动整理记忆」后，她可以从对话中整理出人物、偏好和经历，在以后聊到同一话题时参考。另一类是你明确教她的习惯，比如「我说在练口语时，先陪我聊完，再帮我纠错」。

你可以在「桌宠设置 → 记忆」里查看她记下的事实和人物，选中一条核对当时的原话。她要是把朋友的喜好记到了你头上，可以直接纠正，也可以删除这条记录。

### 主动搭话与免打扰

开启「允许主动搭话」后，即使你没有先发消息，大肥鱼也可能接着上次的话题来找你。你正在打字或使用语音时，她会避开。聊完多久才可以再开口、一天最多来几次、连续几次没收到答复就停下来，都可以自己设定。晚上想安静些，可以把睡觉到起床这段时间设为免打扰。

### 网页搜索与读帖

在聊天里可以直接说「去知乎看看，大家怎么给第一次露营的人选帐篷」。允许浏览网页后，大肥鱼会看搜索结果，挑相关帖子打开，根据读到的内容决定要不要继续，再带着发现回到聊天。你也可以交代她持续逛小红书或知乎，在「浏览器」设置里调整每轮间隔，或者随时结束后台任务。

如果希望她自己找点新鲜事，可以单独开启「允许主动浏览」，并指定哪些站点不让她自行访问。

### 人格、称呼与模型

在「人格与称呼」里，你可以给她取名，写下希望她怎样和你相处。打开性格参数，还能分别调整语言风格、话语多少和安慰方式。比如，同样是性格活泼的大肥鱼，可以很爱开玩笑，也可以在你心情低落时安静陪着。

聊天可以接自己的云端 API，也可以连接本机 Ollama。「Token 用量」能看到模型消耗，还可以给一次任务或一整天设上限，方便掌握聊天和后台读帖的用量。

## 从源码运行

当前公版以源码提供。准备一台 Windows x64 电脑，安装 64 位 CPython 3.12、Node.js 22.14 或 24，以及 pnpm。下载或克隆本仓库后，在仓库根目录打开 PowerShell。

1. 建立 Python 环境并安装桌面依赖。

   ```powershell
   py -3.12 -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r desktop\requirements.txt
   ```

2. 按锁文件安装后台依赖。

   ```powershell
   pnpm --dir backend install --frozen-lockfile --ignore-scripts
   ```

3. 下载 Electron 35.0.0 的 Windows x64 压缩包，按发行页的 `SHASUMS256.txt` 核对后，把压缩包放在仓库根目录并解压。解压后应有 `runtime\electron\electron.exe`。[Electron 官方发行页](https://github.com/electron/electron/releases/tag/v35.0.0)

   ```powershell
   New-Item -ItemType Directory -Force .\runtime | Out-Null
   Expand-Archive -LiteralPath .\electron-v35.0.0-win32-x64.zip -DestinationPath .\runtime\electron
   ```

4. 双击根目录的 `start.vbs`。出现桌宠后，右键打开「桌宠设置 → 模型与 API」。可以选择 DeepSeek、通义千问、Kimi、OpenAI 等服务商并填写自己的 API Key，也可以使用自定义接口或连接本机 Ollama。连接测试通过后启用，再右键选「聊一聊」和她打声招呼。

要让她读帖或通过聊天执行工具，所选模型需要支持原生工具调用。网页浏览还需本机安装 Google Chrome。「Token 用量」里可以查看消耗，并给每天或单次任务设定额度。

## 数据与隐私

第一次启动时，大肥鱼会在项目根目录的 `data/` 建立你的资料。聊天和记忆存入本机 SQLite，模型凭据、媒体和浏览器会话也保存在本机。桌宠通过本机回环地址连接后台。选用云端模型或语音服务时，相关对话内容或音频会发送给你配置的服务商处理。

<details>
<summary>可选素材与桌面功能</summary>

角色动画随源码提供。聊天时可以附上一张自己的表情，安装方法见 [本地表情库说明](assets/stickers/README.md)。聊天壁纸可放在 `assets/bg.png`。

如需显示游戏帧率，请从官方发行页取得 `PresentMon-2.6.0-x64.exe`，按桌面组件声明核对 SHA-256 后放到 `desktop/resources/presentmon/`。[PresentMon 发行页](https://github.com/GameTechDev/PresentMon/releases/tag/v2.6.0) · [桌面组件声明](desktop/THIRD_PARTY_NOTICES.md)

</details>

<details>
<summary>开发者入口 · 源码结构与测试</summary>

桌面聊天界面使用 PySide6，后台使用 Electron。

| 目录 | 用途 |
| --- | --- |
| `desktop/pet/` | 桌宠、动画播放、设置与 Qt 界面 |
| `desktop_bridge/` | 桌面聊天、语音和本机后台客户端 |
| `backend/electron/` | 适配后的念安聊天、记忆、情绪与语音模块 |
| `backend/browser/` | 网页搜索与只读浏览 |
| `tests/`、`backend/test-*.js` | 桌面与后台回归测试 |

在已完成依赖准备的目录执行以下命令。后端用本机假服务和临时 SQLite，Qt 测试使用离屏界面与测试数据。临时文件位于 `temp/`。

```powershell
pnpm --dir backend test
.\.venv\Scripts\python.exe -B scripts\test-desktop.py
```

使用本机 Chrome 验证网页观察、继续阅读和主动停止，可运行下列浏览器专项。测试使用构造的页面，部分窗口生命周期用例会短暂打开验证窗口。Electron 后台的专项检查使用本机假模型。

```powershell
node scripts\test-backend.cjs --browser
node backend\check-electron.cjs
```

</details>

## 作品来源与许可

大肥鱼是 DeepSeek 社区创作的角色。原型「溟月」由上善无形设计，女仆鲸鱼娘形象由 ZipZipPipe 设计。桌宠动画来自 PC2005-cloud/dsh-pet 及社区。页首动图取自「写代码」「点击回应-元气挥手」和「小提琴演奏」，经裁切、缩小和抽帧制作。角色形象与动画按 CC BY-NC-SA 4.0 使用。[角色动画原项目](https://github.com/PC2005-cloud/dsh-pet) · [形象授权声明](https://www.bilibili.com/opus/1247156596114456581)

Windows 桌宠基于 Merzlin 的 dsh-pet-indesktop，后台基于念安项目。本项目原创代码允许非商业使用、修改和再分发。第三方代码和素材保留各自许可。[原创代码授权](LICENSE) · [来源与完整署名](THIRD_PARTY_NOTICES.md)
