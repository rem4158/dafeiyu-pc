"""AI 回复的 Markdown → Qt 富文本。

用 Qt 自带的 md4c 解析（QTextDocument.setMarkdown，GitHub 方言：表格、删除线、
任务列表、自动链接），不引入第三方依赖。几处取舍：

- ``MarkdownNoHTML``：模型输出里的原始 HTML 按字面显示，不渲染——联网搜索的网页
  内容可能诱导模型输出标签，渲染进 QLabel 没必要也不安全；
- 单个换行保留为换行：标准 Markdown 把单换行并成同一段，但桌宠的回复常用单换行
  分句（与 GitHub 评论 / 主流聊天界面的显示习惯一致）；代码块内不处理；
- 去掉文档级字体，让气泡沿用聊天窗口 QSS 的字体字号；代码换等宽字体并加浅底色。
"""
from __future__ import annotations

from html import escape
import re

from PySide6.QtCore import QUrl
from PySide6.QtGui import QColor, QTextCharFormat, QTextCursor, QTextDocument, QTextFormat

_FENCE = re.compile(r'^\s{0,3}(```|~~~)')
_BODY_STYLE = re.compile(r'<body style="[^"]*">')
_LINK_COLOR = re.compile(r'(<a href="[^"]*">)<span style=" color:#[0-9a-fA-F]{6};">')
_TABLE_DELIM = re.compile(r'^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$')
_FONT_DECL =re.compile(r"font-family:'[^']*';")
_MONO_STYLED = "font-family:'Consolas','Courier New',monospace; background-color:rgba(127,127,127,0.16);"
# 聊天气泡里标题缩一档，避免 h1 比正文大太多
_HEADING_SIZE = re.compile(r'font-size:(xx-large|x-large);')
_HEADING_MAP = {'xx-large': 'x-large', 'x-large': 'large'}
_WEB_URL = re.compile(
    r"""(?<![A-Za-z0-9_@./-])(?ai:https?://|www\.)[^\s\x00-\x1f\x7f<>"`\\，。！？；：、（）【】《》「」『』“”‘’…]+""",
)
_TRAILING_PUNCTUATION = ".,;:!?'"
_LINK_BLUE = '#2868a3'
# md4c's MD_FLAG_PERMISSIVEWWWAUTOLINKS, included in Qt's composite GitHub
# flag but not separately named by PySide. Resolve bare www to HTTPS ourselves.
_MD_WWW_AUTOLINK = 0x0400


def _web_links(text: str):
    for match in _WEB_URL.finditer(text):
        label = match.group()
        # Keep balanced delimiters, e.g. Wikipedia paths and bracketed IPv6 hosts.
        excess = {close: label.count(close) - label.count(open_)
                  for close, open_ in ((')', '('), (']', '['), ('}', '{'))}
        end = len(label)
        while end:
            last = label[end - 1]
            if excess.get(last, 0) > 0:
                excess[last] -= 1
            elif last not in _TRAILING_PUNCTUATION:
                break
            end -= 1
        label = label[:end]
        destination = 'https://' + label if label.lower().startswith('www.') else label
        url = QUrl(destination, QUrl.ParsingMode.StrictMode)
        if url.isValid() and url.host():
            yield match.start(), match.start() + len(label), destination


def plain_text_with_links(text: str) -> str | None:
    """Escape plain message text and linkify web addresses without parsing Markdown."""
    parts = []
    offset = 0
    for start, end, destination in _web_links(text):
        parts.append(escape(text[offset:start]))
        parts.append(f'<a href="{escape(destination, quote=True)}" style="color:{_LINK_BLUE};'
                     f' text-decoration:underline">{escape(text[start:end])}</a>')
        offset = end
    if not parts:
        return None
    parts.append(escape(text[offset:]))
    return '<span style="white-space:pre-wrap">' + ''.join(parts) + '</span>'


def _link_unrecognized_urls(doc: QTextDocument, color: str) -> None:
    """Qt's GFM parser misses bare links next to Chinese text. Fill plain spans only."""
    ranges = []
    block = doc.begin()
    while block.isValid():
        if not block.blockFormat().hasProperty(QTextFormat.Property.BlockCodeFence):
            it = block.begin()
            while not it.atEnd():
                fragment = it.fragment()
                it += 1
                fmt = fragment.charFormat()
                # md4c sets an explicit font family on inline and indented code.
                if fmt.isAnchor() or fmt.hasProperty(QTextFormat.Property.FontFamilies) or fmt.isImageFormat():
                    continue
                text = fragment.text()
                offset, position = 0, fragment.position()
                for start, end, destination in _web_links(text):
                    # QTextCursor and QTextFragment offsets count UTF-16 code units.
                    position += len(text[offset:start].encode('utf-16-le')) // 2
                    length = len(text[start:end].encode('utf-16-le')) // 2
                    ranges.append((position, position + length, destination))
                    offset, position = end, position + length
        block = block.next()
    # Changing formats can split/invalidate fragment iterators. Apply after scanning.
    cursor = QTextCursor(doc)
    link_format = QTextCharFormat()
    link_format.setAnchor(True)
    link_format.setForeground(QColor(color))
    link_format.setFontUnderline(True)
    for start, end, destination in ranges:
        cursor.setPosition(start)
        cursor.setPosition(end, QTextCursor.MoveMode.KeepAnchor)
        link_format.setAnchorHref(destination)
        cursor.mergeCharFormat(link_format)


def _features():
    f = QTextDocument.MarkdownFeature
    return f((f.MarkdownDialectGitHub.value & ~_MD_WWW_AUTOLINK) | f.MarkdownNoHTML.value)


def _is_table_header(lines, i) -> bool:
    return 0 <= i < len(lines) - 1 and '|' in lines[i] and bool(_TABLE_DELIM.match(lines[i + 1]))


def preserve_line_breaks(text: str) -> str:
    """段落内的单个换行改成硬换行（行尾两个空格）；围栏代码块内原样保留。

    另外：表格紧跟在文字行后面时补一个空行——md4c 不允许表格打断段落，而模型常写
    「如下：」换行就直接开始画表。
    """
    lines = str(text).split('\n')
    out = []
    in_fence = False
    for i, line in enumerate(lines):
        if _FENCE.match(line):
            in_fence = not in_fence
            out.append(line)
            continue
        if in_fence:
            out.append(line)
            continue
        if _is_table_header(lines, i) and out and out[-1].strip() and '|' not in out[-1]:
            out.append('')
        nxt = lines[i + 1] if i + 1 < len(lines) else ''
        if (line.strip() and nxt.strip() and not _FENCE.match(nxt) and not _is_table_header(lines, i + 1)
                and not line.endswith('  ') and not line.endswith('\\')):
            line += '  '
        out.append(line)
    return '\n'.join(out)


def markdown_to_html(text: str, *, link_color: str = _LINK_BLUE) -> str:
    doc = QTextDocument()
    doc.setMarkdown(preserve_line_breaks(text), _features())
    if _WEB_URL.search(text):
        _link_unrecognized_urls(doc, link_color)
    html = doc.toHtml()
    head, sep, body = html.partition('<body')
    body = _BODY_STYLE.sub('<body>', sep + body, count=1)
    # 去掉文档级字体后，正文里剩下的 font-family 只来自代码片段（Qt 按平台写入不同的
    # 等宽族名），统一换成等宽字体 + 浅底色
    html = head + _FONT_DECL.sub(_MONO_STYLED, body)
    html = _HEADING_SIZE.sub(lambda m: f'font-size:{_HEADING_MAP[m.group(1)]};', html)
    html = _LINK_COLOR.sub(lambda m: f'{m.group(1)}<span style=" color:{link_color};">', html)
    return html
