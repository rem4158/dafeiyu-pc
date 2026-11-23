"""Local chat URL validation and history presentation."""
import json
from urllib.parse import urlsplit


class ConnectionError(RuntimeError):
    pass


class LoginRequired(ConnectionError):
    pass


def validate_base(value):
    parsed = urlsplit(value)
    if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or
            not parsed.port or parsed.username or parsed.password or
            parsed.path not in ('', '/') or parsed.query or parsed.fragment):
        raise ConnectionError('仅允许连接本机 127.0.0.1 的桌宠后台')
    return value.rstrip('/')


def history_messages(payload):
    """Present adjacent TTS audio/text in one bubble without changing storage."""
    rows = payload.get('history', [])
    rows = sorted(rows, key=lambda row: (row.get('created_at', ''), int(row.get('id', 0))))
    pending = None
    for row in rows:
        content = row.get('content', {})
        if isinstance(content, str):
            content = json.loads(content)
        role = 'user' if content.get('type') == 'user' else 'assistant'
        parts = content.get('message', [])
        if isinstance(parts, str):
            parts = [{'type': 'plain', 'text': parts}]
        checkpoint = row.get('llm_checkpoint_id')
        if pending:
            old_role, old_parts, old_checkpoint = pending
            if (role == 'assistant' and checkpoint and checkpoint == old_checkpoint
                    and parts and all(p.get('type') == 'plain' for p in parts)):
                yield old_role, old_parts + parts
                pending = None
                continue
            yield old_role, old_parts
            pending = None
        if role == 'assistant' and checkpoint and len(parts) == 1 and parts[0].get('type') == 'record':
            pending = (role, parts, checkpoint)
        else:
            yield role, parts
    if pending:
        yield pending[0], pending[1]
