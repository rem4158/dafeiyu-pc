# 本地表情库

聊天和记忆可以在表情库为空时使用。要启用自有表情，将有权使用的表情包放在 `packs/<包 ID>/`，检查其中有 `manifest.json` 和 `memes/<分类>/<图片>`，再把此目录的 `selection_rules.json` 中的 `pack_id` 改成该 ID。关闭并重开桌宠即可刷新表情库。默认 ID 对应下述可选包。

DeepSeek Fan Art Meme Pack v1.0.0 由 anka-afk 整理维护。取得该包后，将包含 `manifest.json` 的那一级目录放在 `packs/deepseek-fanart-meme-pack/`。应用通过包内相对路径和内容哈希匹配逐图释义。个人放入的整包和图片由 Git 忽略。[上游项目](https://github.com/anka-afk/deepseek-fanart-meme-pack/releases/tag/v1.0.0) · [上游素材声明](https://github.com/anka-afk/deepseek-fanart-meme-pack/blob/v1.0.0/LICENSE)
