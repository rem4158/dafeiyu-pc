'use strict';

const path = require('node:path');
const { pcPython } = require('./pc-python');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { getUserDataRoot } = require('./electron/user-data');

const messages = {
  opened: '已检测到 QQ 音乐正在运行。',
  launch_requested: '已请求 Windows 打开 QQ 音乐，暂未确认播放器已启动。',
  play_requested: 'QQ 音乐接受了播放指令，请以实际播放状态为准。',
  playback_unconfirmed: 'QQ 音乐正在运行，暂未确认开始播放。',
  player_missing: '未找到 QQ 音乐，可在设置的「桌宠 → 音乐关联」指定程序位置。',
  invalid_player: '音乐关联中的路径不是有效的 QQMusic.exe。',
  config_unavailable: '暂时无法读取桌宠的音乐关联设置。',
  launch_failed: 'Windows 未能打开 QQ 音乐。',
  unsupported: '此功能需要 Windows。',
  action_unconfirmed: 'QQ 音乐操作未返回确认，请先检查播放器状态。',
};
const outcomes = new Set(['opened', 'launch_requested', 'play_requested', 'playback_unconfirmed']);

function receipt(code) {
  return outcomes.has(code) ? { ok: true, result: { status: code, message: messages[code] } }
    : { ok: false, error: { code, message: messages[code] } };
}

function createQQMusicService({ root = process.env.DAFEIYU_PC_ROOT || path.resolve(__dirname, '..'),
  dataRoot = getUserDataRoot(), runWorker = promisify(execFile) } = {}) {
  return async function qqMusic(action, signal) {
    signal?.throwIfAborted();
    try {
      const { stdout } = await runWorker(pcPython(root),
        ['-B', path.join(root, 'desktop_bridge', 'qq_music_action.py'),
          path.join(dataRoot, 'pet-appdata', 'dsh-pet-standalone', 'config.json'), action],
        { cwd: root, signal, timeout: 22_000, maxBuffer: 4096, windowsHide: true });
      signal?.throwIfAborted();
      const code = JSON.parse(stdout).status;
      return receipt(Object.hasOwn(messages, code) ? code : 'action_unconfirmed');
    } catch {
      signal?.throwIfAborted();
      return receipt('action_unconfirmed');
    }
  };
}

module.exports = { createQQMusicService };
