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
}

func New(baseURL, apiKey string) *Client {
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		APIKey:     apiKey,
		HTTPClient: &http.Client{Timeout: defaultHTTPTimeout},
		UserAgent:  defaultUserAgent,
		Retries:    2,
	}
}

// ---------------------------------------------------------------- writes

// SubmitBans submits up to 100 bans, chunking larger slices automatically.
func (c *Client) SubmitBans(ctx context.Context, bans []SubmitBanInput) (*SubmitBansResult, error) {
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
func (c *Client) LookupSteamIDs(ctx context.Context, steamIDs []string) ([]Ban, error) {
	unique := make([]string, 0, len(steamIDs))
	seen := make(map[string]struct{}, len(steamIDs))
	for _, id := range steamIDs {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		unique = append(unique, id)
	}

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
