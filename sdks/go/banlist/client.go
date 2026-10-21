package banlist

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	maxSubmitBatch     = 100
	maxSteamIDLookup   = 50
	maxPageSize        = 500
	defaultUserAgent   = "wardogs-banlist-go/0.1.0"
	defaultHTTPTimeout = 15 * time.Second
)

var steamIDPattern = regexp.MustCompile(`^7656119\d{10}$`)

// Client is safe for concurrent use as long as HTTPClient is not replaced
// while requests are in flight.
type Client struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
	UserAgent  string
	// Retries applies to 429 and 5xx responses, plus transport errors.
	Retries int
	// 本地白名单：命中者在发请求前直接返回本地结果。未设置时视为空名单。
	whitelist *Whitelist
}

func New(baseURL, apiKey string) *Client {
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		APIKey:     apiKey,
		HTTPClient: &http.Client{Timeout: defaultHTTPTimeout},
		UserAgent:  defaultUserAgent,
		Retries:    2,
		whitelist:  &Whitelist{},
	}
}

// NewWithWhitelist 用内存名单构造客户端：命中者在发请求前直接返回本地结果。
func NewWithWhitelist(baseURL, apiKey string, steamIDs []string) *Client {
	client := New(baseURL, apiKey)
	client.whitelist = NewWhitelist(steamIDs)
	return client
}

// NewWithWhitelistFile 从文件构造客户端。文件格式见 whitelist.go。
// 读取或解析失败时返回 error。
func NewWithWhitelistFile(baseURL, apiKey, path string) (*Client, error) {
	whitelist, err := NewWhitelistFromFile(path)
	if err != nil {
		return nil, err
	}
	client := New(baseURL, apiKey)
	client.whitelist = whitelist
	return client, nil
}

// ------------------------------------------------------------- whitelist

// IsWhitelisted 判断是否命中本地白名单。纯内存判断，不发请求。
func (c *Client) IsWhitelisted(steamID string) bool {
	return c.whitelist.Has(steamID)
}

// WhitelistSize 是白名单条目数，便于确认 ReloadWhitelist 是否生效。
func (c *Client) WhitelistSize() int {
	return c.whitelist.Size()
}

// PartitionSteamIDs 去重、保序地划分一批 SteamID64。
func (c *Client) PartitionSteamIDs(steamIDs []string) SteamIDPartition {
	return c.whitelist.Partition(steamIDs)
}

// SetWhitelist 热替换内存名单（不会改动文件来源）。
func (c *Client) SetWhitelist(steamIDs []string) {
	if c.whitelist == nil {
		c.whitelist = &Whitelist{}
	}
	c.whitelist.Set(steamIDs)
}

// LoadWhitelistFile 热加载：读入文件并记作后续 ReloadWhitelist 的来源。
func (c *Client) LoadWhitelistFile(path string) error {
	if c.whitelist == nil {
		c.whitelist = &Whitelist{}
	}
	return c.whitelist.LoadFile(path)
}

// ReloadWhitelist 重新读取文件。没有文件来源时返回 (false, nil)。
func (c *Client) ReloadWhitelist() (bool, error) {
	return c.whitelist.Reload()
}

// ---------------------------------------------------------------- writes

// SubmitBans submits up to 100 bans, chunking larger slices automatically.
//
// A group key (one owner + one location) must name the server: use SubmitBansAs.
func (c *Client) SubmitBans(ctx context.Context, bans []SubmitBanInput) (*SubmitBansResult, error) {
	return c.submitBans(ctx, "", bans)
}

// SubmitBansAs is SubmitBans with an explicit server_id, required when the API key
// covers a whole (owner, location) group.
func (c *Client) SubmitBansAs(ctx context.Context, serverID string, bans []SubmitBanInput) (*SubmitBansResult, error) {
	if serverID == "" {
		return nil, errors.New("banlist: serverID is required for group keys")
	}
	return c.submitBans(ctx, serverID, bans)
}

func (c *Client) submitBans(ctx context.Context, serverID string, bans []SubmitBanInput) (*SubmitBansResult, error) {
	if len(bans) == 0 {
		return nil, errors.New("banlist: at least one ban is required")
	}

	merged := &SubmitBansResult{
		Created:    []Ban{},
		Duplicates: []SubmitBanDuplicate{},
		Errors:     []SubmitBanError{},
	}

	for offset := 0; offset < len(bans); offset += maxSubmitBatch {
		end := offset + maxSubmitBatch
		if end > len(bans) {
			end = len(bans)
		}

		var page SubmitBansResult
		body := map[string]any{"bans": bans[offset:end]}
		if serverID != "" {
			body["server_id"] = serverID
		}
		if err := c.request(ctx, http.MethodPost, "/v1/bans", nil, body, &page); err != nil {
			return nil, err
		}

		merged.Created = append(merged.Created, page.Created...)
		for _, duplicate := range page.Duplicates {
			duplicate.Index += offset
			merged.Duplicates = append(merged.Duplicates, duplicate)
		}
		for _, item := range page.Errors {
			item.Index += offset
			merged.Errors = append(merged.Errors, item)
		}
	}

	return merged, nil
}

// SubmitBan stores one ban and returns it. A duplicate comes back as an
// *APIError with Code "duplicate_ban".
func (c *Client) SubmitBan(ctx context.Context, ban SubmitBanInput) (*Ban, error) {
	result, err := c.SubmitBans(ctx, []SubmitBanInput{ban})
	if err != nil {
		return nil, err
	}

	if len(result.Created) > 0 {
		return &result.Created[0], nil
	}

	if len(result.Duplicates) > 0 {
		duplicate := result.Duplicates[0]
		return nil, &APIError{
			Status:  http.StatusConflict,
			Code:    "duplicate_ban",
			Message: fmt.Sprintf("an active ban for %s already exists (%s)", duplicate.SteamID, duplicate.ID),
		}
	}

	if len(result.Errors) > 0 {
		failure := result.Errors[0]
		return nil, &APIError{
			Status:  http.StatusUnprocessableEntity,
			Code:    failure.Code,
			Message: failure.Message,
		}
	}

	return nil, errors.New("banlist: ban was neither created nor rejected")
}

func (c *Client) RevokeBan(ctx context.Context, banID, reason string) (*Ban, error) {
	body := map[string]string{}
	if reason != "" {
		body["reason"] = reason
	}

	var ban Ban
	path := "/v1/bans/" + url.PathEscape(banID) + "/revoke"
	if err := c.request(ctx, http.MethodPost, path, nil, body, &ban); err != nil {
		return nil, err
	}
	return &ban, nil
}

// ----------------------------------------------------------------- reads

func (c *Client) ListBans(ctx context.Context, query ListBansQuery) (*ListBansResult, error) {
	if len(query.SteamIDs) > 0 {
		parts := c.whitelist.Partition(query.SteamIDs)
		if len(parts.Others) == 0 {
			// 整批都命中白名单：本地空页，不发请求（空过滤串会让服务端返回全部记录）
			return &ListBansResult{
				Data:       []Ban{},
				NextCursor: nil,
				HasMore:    false,
				ServerTime: localTimestamp(),
			}, nil
		}
		query.SteamIDs = parts.Others
	}

	var result ListBansResult
	if err := c.request(ctx, http.MethodGet, "/v1/bans", query.values(), nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// ForEachBan walks every page, so an incremental sync is one call.
func (c *Client) ForEachBan(ctx context.Context, query ListBansQuery, fn func(Ban) error) error {
	cursor := query.Cursor

	for {
		query.Cursor = cursor
		page, err := c.ListBans(ctx, query)
		if err != nil {
			return err
		}

		for _, ban := range page.Data {
			if err := fn(ban); err != nil {
				return err
			}
		}

		if !page.HasMore || page.NextCursor == nil || *page.NextCursor == "" {
			return nil
		}
		cursor = *page.NextCursor
	}
}

// LookupSteamIDs returns active bans for a set of players.
// 白名单玩家不参与查询：整批命中时一次 HTTP 都不会发生。
func (c *Client) LookupSteamIDs(ctx context.Context, steamIDs []string) ([]Ban, error) {
	unique := c.whitelist.Partition(steamIDs).Others

	found := make([]Ban, 0)
	for offset := 0; offset < len(unique); offset += maxSteamIDLookup {
		end := offset + maxSteamIDLookup
		if end > len(unique) {
			end = len(unique)
		}

		err := c.ForEachBan(ctx, ListBansQuery{SteamIDs: unique[offset:end], Status: "active"}, func(ban Ban) error {
			found = append(found, ban)
			return nil
		})
		if err != nil {
			return nil, err
		}
	}

	return found, nil
}

func (c *Client) GetPlayer(ctx context.Context, steamID, status string, limit int) (*PlayerDetail, error) {
	if !steamIDPattern.MatchString(steamID) {
		return nil, fmt.Errorf("banlist: %q is not a SteamID64", steamID)
	}
	// 命中白名单：本地结果，0 次 HTTP。不伪造 ban，只标 Whitelisted。
	if c.whitelist.Has(steamID) {
		return whitelistedPlayerDetail(steamID), nil
	}
	if status == "" {
		status = "all"
	}
	if limit <= 0 || limit > maxPageSize {
		limit = 200
	}

	query := url.Values{}
	query.Set("status", status)
	query.Set("limit", strconv.Itoa(limit))

	var detail PlayerDetail
	path := "/v1/players/" + url.PathEscape(steamID)
	if err := c.request(ctx, http.MethodGet, path, query, nil, &detail); err != nil {
		return nil, err
	}
	return &detail, nil
}

func (c *Client) ListPlayers(ctx context.Context, sort string, limit, offset int) (*ListPlayersResult, error) {
	if sort == "" {
		sort = "servers"
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}

	query := url.Values{}
	query.Set("sort", sort)
	query.Set("limit", strconv.Itoa(limit))
	query.Set("offset", strconv.Itoa(offset))

	var result ListPlayersResult
	if err := c.request(ctx, http.MethodGet, "/v1/players", query, nil, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) ListServers(ctx context.Context) ([]Server, error) {
	var payload struct {
		Data []Server `json:"data"`
	}
	if err := c.request(ctx, http.MethodGet, "/v1/servers", nil, nil, &payload); err != nil {
		return nil, err
	}
	return payload.Data, nil
}

type Health struct {
	OK      bool   `json:"ok"`
	Time    string `json:"time"`
	Version string `json:"version"`
}

func (c *Client) Health(ctx context.Context) (*Health, error) {
	var health Health
	if err := c.request(ctx, http.MethodGet, "/health", nil, nil, &health); err != nil {
		return nil, err
	}
	return &health, nil
}

// ------------------------------------------------------------- internals

// localTimestamp 是本地时钟的 RFC 3339 时间戳（不是服务端时间）。
func localTimestamp() string {
	return time.Now().UTC().Format(time.RFC3339)
}

// whitelistedPlayerDetail 是白名单玩家的本地详情：Whitelisted 为 true，
// Reports 全零，Bans 为空。这些数字表示“本地没有做过任何查询”，不是服务端数据。
func whitelistedPlayerDetail(steamID string) *PlayerDetail {
	return &PlayerDetail{
		SteamID:     steamID,
		Whitelisted: true,
		Reports: PlayerReports{
			SteamID:      steamID,
			ReasonCounts: map[Reason]int{},
			UpdatedAt:    localTimestamp(),
		},
		Bans: []Ban{},
	}
}

func (q ListBansQuery) values() url.Values {
	values := url.Values{}

	if q.Since != "" {
		values.Set("since", q.Since)
	}
	if q.Cursor != "" {
		values.Set("cursor", q.Cursor)
	}

	limit := q.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > maxPageSize {
		limit = maxPageSize
	}
	values.Set("limit", strconv.Itoa(limit))

	if len(q.Reasons) > 0 {
		parts := make([]string, len(q.Reasons))
		for i, reason := range q.Reasons {
			parts[i] = string(reason)
		}
		values.Set("reason", strings.Join(parts, ","))
	}
	if len(q.SteamIDs) > 0 {
		values.Set("steam_id", strings.Join(q.SteamIDs, ","))
	}
	if len(q.Servers) > 0 {
		values.Set("server", strings.Join(q.Servers, ","))
	}
	if q.Permanent != nil {
		values.Set("permanent", strconv.FormatBool(*q.Permanent))
	}
	if q.Status != "" {
		values.Set("status", q.Status)
	}

	return values
}

type errorEnvelope struct {
	Error struct {
		Code    string          `json:"code"`
		Message string          `json:"message"`
		Details json.RawMessage `json:"details"`
	} `json:"error"`
	RequestID string `json:"request_id"`
}

func (c *Client) request(
	ctx context.Context,
	method string,
	path string,
	query url.Values,
	body any,
	out any,
) error {
	endpoint := c.BaseURL + path
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}

	var payload []byte
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("banlist: encode request body: %w", err)
		}
		payload = encoded
	}

	attempts := c.Retries + 1
	if attempts < 1 {
		attempts = 1
	}

	for attempt := 0; attempt < attempts; attempt++ {
		req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(payload))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", c.userAgent())
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}

		resp, err := c.httpClient().Do(req)
		if err != nil {
			if attempt < attempts-1 {
				sleep(ctx, backoff(attempt))
				continue
			}
			return fmt.Errorf("banlist: request failed: %w", err)
		}

		data, readErr := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
		resp.Body.Close()
		if readErr != nil {
			return fmt.Errorf("banlist: read response: %w", readErr)
		}

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			if out != nil && len(data) > 0 {
				if err := json.Unmarshal(data, out); err != nil {
					return fmt.Errorf("banlist: decode response: %w", err)
				}
			}
			return nil
		}

		if (resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500) && attempt < attempts-1 {
			sleep(ctx, retryAfter(resp.Header.Get("Retry-After"), attempt))
			continue
		}

		return parseAPIError(resp.StatusCode, data, resp.Header.Get("X-Request-Id"))
	}

	return errors.New("banlist: request failed after retries")
}

func (c *Client) httpClient() *http.Client {
	if c.HTTPClient != nil {
		return c.HTTPClient
	}
	return &http.Client{Timeout: defaultHTTPTimeout}
}

func (c *Client) userAgent() string {
	if c.UserAgent != "" {
		return c.UserAgent
	}
	return defaultUserAgent
}

func parseAPIError(status int, data []byte, fallbackRequestID string) error {
	var envelope errorEnvelope
	_ = json.Unmarshal(data, &envelope)

	code := envelope.Error.Code
	if code == "" {
		code = fallbackCode(status)
	}
	message := envelope.Error.Message
	if message == "" {
		message = fmt.Sprintf("request failed with HTTP %d", status)
	}
	requestID := envelope.RequestID
	if requestID == "" {
		requestID = fallbackRequestID
	}

	return &APIError{
		Status:    status,
		Code:      code,
		Message:   message,
		Details:   envelope.Error.Details,
		RequestID: requestID,
	}
}

func fallbackCode(status int) string {
	switch {
	case status == 401:
		return "unauthorized"
	case status == 403:
		return "forbidden"
	case status == 404:
		return "not_found"
	case status == 409:
		return "conflict"
	case status == 429:
		return "rate_limited"
	case status >= 500:
		return "internal"
	default:
		return "invalid_request"
	}
}

func retryAfter(header string, attempt int) time.Duration {
	if header != "" {
		if seconds, err := strconv.ParseFloat(header, 64); err == nil && seconds >= 0 {
			if seconds > 30 {
				seconds = 30
			}
			return time.Duration(seconds * float64(time.Second))
		}
	}
	return backoff(attempt)
}

func backoff(attempt int) time.Duration {
	delay := 500 * time.Millisecond * time.Duration(1<<attempt)
	if delay > 8*time.Second {
		delay = 8 * time.Second
	}
	return delay
}

func sleep(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}
