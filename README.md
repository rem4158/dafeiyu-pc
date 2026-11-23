# 大肥鱼 PC

大肥鱼是住在 Windows 桌面上的 AI 桌宠。右键可以打开聊天和设置。它能记住有来源的人和事、用语音和表情回复，也可以在你授权后浏览网页、读帖或主动分享近况。公版通过本机桌面聊天，QQ 音乐控制是独立的播放器功能。

## 从源码运行

使用 Windows x64、64 位 CPython 3.12、Node.js 22.14 或 24 和 pnpm。聊天界面使用 PySide6，后台使用 Electron，数据存入本机 SQLite。下面的 PowerShell 命令都在本仓库根目录执行。

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

4. 双击 `start.vbs`。右键桌宠进入「桌宠设置 → 模型与 API」，选择服务商或自定义连接，填写自己的 Key，连接测试成功后启用。也可以配置本机 Ollama。自然语言工具需要所选模型支持原生工具调用。网页浏览使用本机 Google Chrome。

## 数据与可选素材

首次启动会在本目录的 `data/` 建立独立资料。默认身份为 `local`，默认称呼为「主人」，可在设置中修改称呼。模型凭据、聊天、记忆、媒体和浏览器会话属于使用者。桌面客户端与后台通过本机回环地址通信。

角色动画随源码提供。聊天支持文字和单张表情一起发送，选用自己的表情包可按 [本地表情库说明](assets/stickers/README.md) 安装。默认聊天界面使用自身底色，个人壁纸可放在 `assets/bg.png`。记忆星云有独立背景。

游戏帧率显示是可选功能。如需使用，从官方发行页取得 `PresentMon-2.6.0-x64.exe`，按桌面组件声明核对 SHA-256，放到 `desktop/resources/presentmon/`。[PresentMon 发行页](https://github.com/GameTechDev/PresentMon/releases/tag/v2.6.0) · [桌面组件声明](desktop/THIRD_PARTY_NOTICES.md)

## 验证

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

## 源码与许可

| 目录 | 用途 |
| --- | --- |
| `desktop/pet/` | 桌宠、动画播放、设置与 Qt 界面 |
| `desktop_bridge/` | 桌面聊天、语音和本机后台客户端 |
| `backend/electron/` | 适配后的念安聊天、记忆、情绪与语音模块 |
| `backend/browser/`、`backend/nebula/` | 只读浏览与记忆星云 |
| `tests/`、`backend/test-*.js` | 桌面与后台回归测试 |

本项目原创代码允许非商业使用、修改和再分发。角色、美术及第三方代码按各自条款使用。[原创代码授权](LICENSE) · [来源与集中署名](THIRD_PARTY_NOTICES.md)

桌宠动画源自 PC2005-cloud/dsh-pet 及社区。角色原型「溟月」由上善无形设计，女仆鲸鱼娘形象由 ZipZipPipe 设计，形象采用 CC BY-NC-SA 4.0。[角色动画原项目](https://github.com/PC2005-cloud/dsh-pet)
