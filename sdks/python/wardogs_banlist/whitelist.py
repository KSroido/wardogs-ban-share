"""本地白名单。

命中白名单的玩家在**发起任何 HTTP 请求之前**直接返回本地结果（见
:meth:`BanListClient.get_player` / :meth:`BanListClient.list_bans` /
:meth:`BanListClient.lookup_steam_ids`）。白名单只是运营方自己的“免检名单”，
服务端并不知道它的存在，所以本地结果里只标 ``whitelisted=True``，不会伪造任何
ban 数据。

支持两种来源：

- 内存列表 / set：``BanListClient(url, key, whitelist=["7656119..."])``
- 文件路径：``BanListClient(url, key, whitelist="./whitelist.txt")``

文件格式二选一（自动识别）：

- JSON 数组：``["76561198000000001", "76561198000000002"]``
- 每行一个：空行忽略，``#`` 开头的整行视为注释

文件只在构造和 :meth:`Whitelist.reload` 时读一次；命中判断是纯内存操作。
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from typing import Any, Iterable, List, Optional, Set, Union

__all__ = ["SteamIdPartition", "Whitelist", "parse_whitelist_text"]

WhitelistInput = Union[str, Iterable[str], None]


@dataclass
class SteamIdPartition:
    """一批 SteamID64 的划分结果，字段名与其它语言 SDK 一致。"""

    whitelisted: List[str] = field(default_factory=list)
    others: List[str] = field(default_factory=list)


def parse_whitelist_text(text: str) -> List[str]:
    """解析白名单文件内容。首字符是 ``[`` 按 JSON 数组，否则按每行一个。"""
    body = text.lstrip("\ufeff").strip()
    if not body:
        return []
    return _parse_json_array(body) if body.startswith("[") else _parse_lines(body)


def parse_whitelist_file(path: str) -> List[str]:
    with open(path, "r", encoding="utf-8") as handle:
        return parse_whitelist_text(handle.read())


def _parse_json_array(text: str) -> List[str]:
    try:
        parsed = json.loads(text)
    except ValueError as exc:
        raise ValueError("whitelist: invalid JSON array: %s" % exc) from exc

    if not isinstance(parsed, list):
        raise ValueError("whitelist: expected a JSON array of SteamID64 strings")

    ids: List[str] = []
    for index, entry in enumerate(parsed):
        if isinstance(entry, str):
            ids.append(entry.strip())
        elif isinstance(entry, int) and not isinstance(entry, bool):
            # Python 的 int 是精确的，17 位 SteamID64 可以安全接受
            ids.append(str(entry))
        else:
            raise ValueError(
                "whitelist: entry #%d is not a SteamID64 string (got %s)"
                % (index, type(entry).__name__)
            )
    return ids


def _parse_lines(text: str) -> List[str]:
    ids: List[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        ids.append(line)
    return ids


def _normalize(entry: Any) -> str:
    """把一条名单条目规范化成字符串；类型不对直接报错，避免静默丢条目。"""
    if isinstance(entry, bool):
        raise ValueError("whitelist: entry %r is a bool, not a SteamID64" % (entry,))
    if isinstance(entry, int):
        # Python 的 int 是精确的，17 位 SteamID64 可以安全接受
        return str(entry)
    if isinstance(entry, str):
        return entry.strip()
    raise ValueError(
        "whitelist: entries must be SteamID64 strings (got %s)" % type(entry).__name__
    )


class Whitelist:
    """一份白名单快照。构造时一次性读入，:meth:`reload` 才会重新读文件。"""

    def __init__(self, entries: Optional[WhitelistInput] = None) -> None:
        self._lock = threading.RLock()
        self._ids: Set[str] = set()
        self._source: Optional[str] = None

        if entries is None:
            return
        if isinstance(entries, str):
            # 约定：字符串一律当文件路径（单个 SteamID64 请包成列表）
            self._source = entries
            self._replace(parse_whitelist_file(entries))
            return
        self._replace(entries)

    def __contains__(self, steam_id: str) -> bool:
        return self.has(steam_id)

    def has(self, steam_id: str) -> bool:
        """精确匹配（两侧空白会被忽略）。"""
        with self._lock:
            return steam_id.strip() in self._ids

    @property
    def size(self) -> int:
        with self._lock:
            return len(self._ids)

    @property
    def file_path(self) -> Optional[str]:
        """文件来源路径；内存列表为 ``None``。"""
        return self._source

    def partition(self, steam_ids: Iterable[str]) -> SteamIdPartition:
        """去重、保序地划分一批 SteamID64。空串会被丢掉。"""
        parts = SteamIdPartition()
        seen: Set[str] = set()

        with self._lock:
            for raw in steam_ids:
                steam_id = str(raw).strip()
                if not steam_id or steam_id in seen:
                    continue
                seen.add(steam_id)
                if steam_id in self._ids:
                    parts.whitelisted.append(steam_id)
                else:
                    parts.others.append(steam_id)

        return parts

    def set(self, steam_ids: Iterable[str]) -> None:
        """用一批 SteamID64 替换内存名单（不会改动文件来源）。"""
        self._replace(steam_ids)

    def reload(self) -> bool:
        """重新读文件。没有文件来源（构造时传的是内存列表）返回 ``False``。"""
        if self._source is None:
            return False
        self._replace(parse_whitelist_file(self._source))
        return True

    def _replace(self, entries: Iterable[Any]) -> None:
        normalized = (_normalize(entry) for entry in entries)
        next_ids = {steam_id for steam_id in normalized if steam_id}
        with self._lock:
            self._ids = next_ids
