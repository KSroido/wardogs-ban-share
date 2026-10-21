package banlist

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
)

// 本地白名单。
//
// 命中白名单的玩家在**发起任何 HTTP 请求之前**直接返回本地结果（见
// Client.GetPlayer / Client.ListBans / Client.LookupSteamIDs）。白名单只是
// 运营方自己的“免检名单”，服务端并不知道它的存在，所以本地结果里只标
// Whitelisted: true，不会伪造任何 ban 数据。
//
// 支持两种来源：
//
//   - 内存列表：NewWithWhitelist / Client.SetWhitelist
//   - 文件路径：NewWithWhitelistFile / Client.LoadWhitelistFile
//
// 文件格式二选一（自动识别）：
//
//   - JSON 数组：["76561198000000001", "76561198000000002"]
//   - 每行一个：空行忽略，# 开头的整行视为注释
//
// 文件只在构造、Client.LoadWhitelistFile 和 Client.ReloadWhitelist 时读一次；
// 命中判断是纯内存操作。

// SteamIDPartition 是一批 SteamID64 的划分结果，字段名与其它语言 SDK 一致。
type SteamIDPartition struct {
	// Whitelisted 是命中本地白名单、无需查询的 SteamID64。
	Whitelisted []string `json:"whitelisted"`
	// Others 是仍需向服务端查询的 SteamID64。
	Others []string `json:"others"`
}

// Whitelist 是一份白名单快照，可安全并发读取。
type Whitelist struct {
	mu     sync.RWMutex
	ids    map[string]struct{}
	source string
}

// NewWhitelist 用一批 SteamID64 构造内存白名单。
func NewWhitelist(steamIDs []string) *Whitelist {
	w := &Whitelist{}
	w.Set(steamIDs)
	return w
}

// NewWhitelistFromFile 从文件构造白名单，返回读取/解析错误。
func NewWhitelistFromFile(path string) (*Whitelist, error) {
	w := &Whitelist{source: path}
	if err := w.loadFile(); err != nil {
		return nil, err
	}
	return w, nil
}

// ParseWhitelist 解析白名单文件内容：首字符是 '[' 按 JSON 数组，否则按每行一个。
func ParseWhitelist(data []byte) ([]string, error) {
	body := bytes.TrimSpace(bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF}))
	if len(body) == 0 {
		return nil, nil
	}
	if body[0] == '[' {
		return parseWhitelistJSON(body)
	}
	return parseWhitelistLines(body), nil
}

func parseWhitelistJSON(body []byte) ([]string, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	// UseNumber 保留数字的原始文本，17 位 SteamID64 不会丢精度
	decoder.UseNumber()

	var entries []any
	if err := decoder.Decode(&entries); err != nil {
		return nil, fmt.Errorf("banlist: whitelist: invalid JSON array: %w", err)
	}

	ids := make([]string, 0, len(entries))
	for index, entry := range entries {
		switch value := entry.(type) {
		case string:
			if id := strings.TrimSpace(value); id != "" {
				ids = append(ids, id)
			}
		case json.Number:
			if _, err := strconv.ParseInt(value.String(), 10, 64); err != nil {
				return nil, fmt.Errorf("banlist: whitelist: entry #%d is not an integer SteamID64: %w", index, err)
			}
			ids = append(ids, value.String())
		default:
			return nil, fmt.Errorf("banlist: whitelist: entry #%d is not a SteamID64 string (got %T)", index, entry)
		}
	}

	return ids, nil
}

func parseWhitelistLines(body []byte) []string {
	ids := make([]string, 0, 32)
	for _, rawLine := range strings.Split(string(body), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		ids = append(ids, line)
	}
	return ids
}

// Has 精确匹配（两侧空白会被忽略）。nil 接收者视为空名单。
func (w *Whitelist) Has(steamID string) bool {
	if w == nil {
		return false
	}
	w.mu.RLock()
	defer w.mu.RUnlock()
	_, ok := w.ids[strings.TrimSpace(steamID)]
	return ok
}

// Size 是白名单条目数。
func (w *Whitelist) Size() int {
	if w == nil {
		return 0
	}
	w.mu.RLock()
	defer w.mu.RUnlock()
	return len(w.ids)
}

// FilePath 是文件来源路径；内存名单为空串。
func (w *Whitelist) FilePath() string {
	if w == nil {
		return ""
	}
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.source
}

// Partition 去重、保序地划分一批 SteamID64。空串会被丢掉。
func (w *Whitelist) Partition(steamIDs []string) SteamIDPartition {
	parts := SteamIDPartition{Whitelisted: []string{}, Others: []string{}}
	seen := make(map[string]struct{}, len(steamIDs))

	if w == nil {
		// 零值 Client 没有白名单：全部需要查询
		for _, raw := range steamIDs {
			if id := strings.TrimSpace(raw); id != "" {
				if _, ok := seen[id]; !ok {
					seen[id] = struct{}{}
					parts.Others = append(parts.Others, id)
				}
			}
		}
		return parts
	}

	w.mu.RLock()
	defer w.mu.RUnlock()

	for _, raw := range steamIDs {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}

		if _, ok := w.ids[id]; ok {
			parts.Whitelisted = append(parts.Whitelisted, id)
		} else {
			parts.Others = append(parts.Others, id)
		}
	}

	return parts
}

// Set 用一批 SteamID64 替换内存名单（不会改动文件来源）。
func (w *Whitelist) Set(steamIDs []string) {
	if w == nil {
		return
	}

	next := make(map[string]struct{}, len(steamIDs))
	for _, raw := range steamIDs {
		if id := strings.TrimSpace(raw); id != "" {
			next[id] = struct{}{}
		}
	}

	w.mu.Lock()
	defer w.mu.Unlock()
	w.ids = next
}

// LoadFile 从 path 读入名单，并把它记作后续 Reload 的来源。
func (w *Whitelist) LoadFile(path string) error {
	if w == nil {
		return errors.New("banlist: whitelist: nil receiver")
	}
	w.mu.Lock()
	w.source = path
	w.mu.Unlock()
	return w.loadFile()
}

// Reload 重新读文件。没有文件来源时返回 (false, nil)。
func (w *Whitelist) Reload() (bool, error) {
	if w == nil {
		return false, nil
	}
	w.mu.RLock()
	source := w.source
	w.mu.RUnlock()

	if source == "" {
		return false, nil
	}
	if err := w.loadFile(); err != nil {
		return false, err
	}
	return true, nil
}

func (w *Whitelist) loadFile() error {
	w.mu.RLock()
	path := w.source
	w.mu.RUnlock()

	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("banlist: whitelist: read %q: %w", path, err)
	}

	ids, err := ParseWhitelist(data)
	if err != nil {
		return err
	}
	w.Set(ids)
	return nil
}
