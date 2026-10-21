package banlist

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
)

const (
	whitelistedID = "76561198000000001"
	otherID       = "76561198000000002"
)

// countingTransport 记录每一次 HTTP 往返；白名单用例要求它是 0。
type countingTransport struct {
	mu        sync.Mutex
	calls     int
	urls      []string
	responder func(*http.Request) (*http.Response, error)
}

func (t *countingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.mu.Lock()
	t.calls++
	t.urls = append(t.urls, req.URL.String())
	t.mu.Unlock()

	if t.responder == nil {
		return nil, io.ErrUnexpectedEOF
	}
	return t.responder(req)
}

func (t *countingTransport) Calls() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.calls
}

func (t *countingTransport) LastURL() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.urls) == 0 {
		return ""
	}
	return t.urls[len(t.urls)-1]
}

func jsonResponse(t *testing.T, status int, body any) *http.Response {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal response: %v", err)
	}
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(bytes.NewReader(raw)),
	}
}

func whitelistClient(transport *countingTransport, ids ...string) *Client {
	client := NewWithWhitelist("http://bans.test", "wdb_test", ids)
	client.HTTPClient = &http.Client{Transport: transport}
	return client
}

// ---------------------------------------------------------------- 短路

func TestGetPlayerWhitelistedSkipsHTTP(t *testing.T) {
	transport := &countingTransport{}
	client := whitelistClient(transport, whitelistedID)

	player, err := client.GetPlayer(context.Background(), whitelistedID, "all", 200)
	if err != nil {
		t.Fatalf("GetPlayer: %v", err)
	}

	if calls := transport.Calls(); calls != 0 {
		t.Fatalf("HTTP calls = %d, want 0", calls)
	}
	if !player.Whitelisted {
		t.Errorf("Whitelisted = false, want true")
	}
	if player.SteamID != whitelistedID {
		t.Errorf("SteamID = %q", player.SteamID)
	}
	if len(player.Bans) != 0 {
		t.Errorf("Bans = %v, want empty", player.Bans)
	}
	if player.Reports.ServerCount != 0 || player.Reports.BanCount != 0 {
		t.Errorf("Reports = %+v, want zero counts", player.Reports)
	}
	if len(player.Reports.ReasonCounts) != 0 {
		t.Errorf("ReasonCounts = %v, want empty", player.Reports.ReasonCounts)
	}
}

func TestGetPlayerQueriesPlayersOutsideWhitelist(t *testing.T) {
	transport := &countingTransport{
		responder: func(*http.Request) (*http.Response, error) {
			return jsonResponse(t, http.StatusOK, PlayerDetail{
				SteamID: otherID,
				Reports: PlayerReports{SteamID: otherID, ServerCount: 2},
				Bans:    []Ban{sampleBan("ban_1")},
			}), nil
		},
	}
	client := whitelistClient(transport, whitelistedID)

	player, err := client.GetPlayer(context.Background(), otherID, "all", 200)
	if err != nil {
		t.Fatalf("GetPlayer: %v", err)
	}

	if calls := transport.Calls(); calls != 1 {
		t.Fatalf("HTTP calls = %d, want 1", calls)
	}
	if player.Whitelisted {
		t.Errorf("Whitelisted = true, want false")
	}
	if len(player.Bans) != 1 || player.Reports.ServerCount != 2 {
		t.Errorf("player = %+v", player)
	}
}

func TestLookupSteamIDsDropsWhitelistedFromQuery(t *testing.T) {
	transport := &countingTransport{
		responder: func(*http.Request) (*http.Response, error) {
			return jsonResponse(t, http.StatusOK, ListBansResult{
				Data:    []Ban{sampleBan("ban_2")},
				HasMore: false,
			}), nil
		},
	}
	client := whitelistClient(transport, whitelistedID)

	bans, err := client.LookupSteamIDs(context.Background(), []string{whitelistedID, otherID})
	if err != nil {
		t.Fatalf("LookupSteamIDs: %v", err)
	}

	if calls := transport.Calls(); calls != 1 {
		t.Fatalf("HTTP calls = %d, want 1", calls)
	}
	if got := transport.LastURL(); !contains(got, "steam_id="+otherID) || contains(got, whitelistedID) {
		t.Errorf("url = %q, want only %s in steam_id", got, otherID)
	}
	if len(bans) != 1 {
		t.Errorf("bans = %v, want 1", bans)
	}
}

func TestLookupSteamIDsMakesNoRequestWhenAllWhitelisted(t *testing.T) {
	transport := &countingTransport{}
	client := whitelistClient(transport, whitelistedID, otherID)

	bans, err := client.LookupSteamIDs(context.Background(), []string{whitelistedID, otherID})
	if err != nil {
		t.Fatalf("LookupSteamIDs: %v", err)
	}

	if calls := transport.Calls(); calls != 0 {
		t.Fatalf("HTTP calls = %d, want 0", calls)
	}
	if len(bans) != 0 {
		t.Errorf("bans = %v, want empty", bans)
	}
}

func TestListBansReturnsLocalEmptyPageForWhitelistedFilter(t *testing.T) {
	transport := &countingTransport{}
	client := whitelistClient(transport, whitelistedID)

	page, err := client.ListBans(context.Background(), ListBansQuery{
		SteamIDs: []string{whitelistedID},
		Status:   "all",
	})
	if err != nil {
		t.Fatalf("ListBans: %v", err)
	}

	if calls := transport.Calls(); calls != 0 {
		t.Fatalf("HTTP calls = %d, want 0", calls)
	}
	if len(page.Data) != 0 || page.HasMore || page.NextCursor != nil {
		t.Errorf("page = %+v, want an empty local page", page)
	}
}

func TestListBansNarrowsMixedFilter(t *testing.T) {
	transport := &countingTransport{
		responder: func(*http.Request) (*http.Response, error) {
			return jsonResponse(t, http.StatusOK, ListBansResult{Data: []Ban{}}), nil
		},
	}
	client := whitelistClient(transport, whitelistedID)

	if _, err := client.ListBans(context.Background(), ListBansQuery{
		SteamIDs: []string{whitelistedID, otherID},
	}); err != nil {
		t.Fatalf("ListBans: %v", err)
	}

	got := transport.LastURL()
	if !contains(got, "steam_id="+otherID) || contains(got, whitelistedID) {
		t.Errorf("url = %q, want only %s in steam_id", got, otherID)
	}
	if calls := transport.Calls(); calls != 1 {
		t.Errorf("HTTP calls = %d, want 1", calls)
	}
}

func TestForEachBanYieldsNothingForWhitelistedFilter(t *testing.T) {
	transport := &countingTransport{}
	client := whitelistClient(transport, whitelistedID)

	var ids []string
	err := client.ForEachBan(context.Background(), ListBansQuery{
		SteamIDs: []string{whitelistedID},
		Status:   "all",
	}, func(ban Ban) error {
		ids = append(ids, ban.ID)
		return nil
	})
	if err != nil {
		t.Fatalf("ForEachBan: %v", err)
	}

	if len(ids) != 0 {
		t.Errorf("ids = %v, want empty", ids)
	}
	if calls := transport.Calls(); calls != 0 {
		t.Errorf("HTTP calls = %d, want 0", calls)
	}
}

// ------------------------------------------------------------ partition

func TestPartitionSteamIDs(t *testing.T) {
	client := NewWithWhitelist("http://bans.test", "wdb_test", []string{whitelistedID})

	parts := client.PartitionSteamIDs([]string{otherID, whitelistedID, otherID, whitelistedID})

	if !reflect.DeepEqual(parts.Whitelisted, []string{whitelistedID}) {
		t.Errorf("Whitelisted = %v", parts.Whitelisted)
	}
	if !reflect.DeepEqual(parts.Others, []string{otherID}) {
		t.Errorf("Others = %v", parts.Others)
	}
}

func TestPartitionWithEmptyWhitelist(t *testing.T) {
	client := New("http://bans.test", "wdb_test")

	parts := client.PartitionSteamIDs([]string{whitelistedID, otherID})

	if len(parts.Whitelisted) != 0 {
		t.Errorf("Whitelisted = %v, want empty", parts.Whitelisted)
	}
	if !reflect.DeepEqual(parts.Others, []string{whitelistedID, otherID}) {
		t.Errorf("Others = %v", parts.Others)
	}
	if client.IsWhitelisted(whitelistedID) {
		t.Errorf("IsWhitelisted = true on an empty whitelist")
	}
}

// ---------------------------------------------------------------- 来源

func TestWhitelistFromJSONFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wl.json")
	if err := os.WriteFile(path, []byte(`["`+whitelistedID+`"]`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	transport := &countingTransport{}
	client, err := NewWithWhitelistFile("http://bans.test", "wdb_test", path)
	if err != nil {
		t.Fatalf("NewWithWhitelistFile: %v", err)
	}
	client.HTTPClient = &http.Client{Transport: transport}

	if !client.IsWhitelisted(whitelistedID) || client.WhitelistSize() != 1 {
		t.Fatalf("whitelist not loaded: size=%d", client.WhitelistSize())
	}

	if _, err := client.GetPlayer(context.Background(), whitelistedID, "all", 200); err != nil {
		t.Fatalf("GetPlayer: %v", err)
	}
	if calls := transport.Calls(); calls != 0 {
		t.Errorf("HTTP calls = %d, want 0", calls)
	}
}

func TestParseWhitelistAcceptsNumbers(t *testing.T) {
	ids, err := ParseWhitelist([]byte(`[76561198000000001]`))
	if err != nil {
		t.Fatalf("ParseWhitelist: %v", err)
	}
	if !reflect.DeepEqual(ids, []string{whitelistedID}) {
		t.Errorf("ids = %v", ids)
	}
}

func TestWhitelistLineFileWithComments(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wl.txt")
	content := "# 手工维护\n\n" + whitelistedID + "\n   \n# 下一位\n" + otherID + "\n"
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	whitelist, err := NewWhitelistFromFile(path)
	if err != nil {
		t.Fatalf("NewWhitelistFromFile: %v", err)
	}

	if whitelist.Size() != 2 {
		t.Errorf("Size = %d, want 2", whitelist.Size())
	}
	if !whitelist.Has(whitelistedID) || !whitelist.Has(otherID) {
		t.Errorf("ids = %v", whitelist.ids)
	}
	if whitelist.FilePath() != path {
		t.Errorf("FilePath = %q", whitelist.FilePath())
	}
}

func TestReloadWhitelistPicksUpEdits(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wl.txt")
	if err := os.WriteFile(path, []byte(whitelistedID+"\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	transport := &countingTransport{}
	client, err := NewWithWhitelistFile("http://bans.test", "wdb_test", path)
	if err != nil {
		t.Fatalf("NewWithWhitelistFile: %v", err)
	}
	client.HTTPClient = &http.Client{Transport: transport}

	if client.IsWhitelisted(otherID) {
		t.Fatalf("%s should not be whitelisted yet", otherID)
	}

	if err := os.WriteFile(path, []byte(whitelistedID+"\n"+otherID+"\n"), 0o600); err != nil {
		t.Fatalf("rewrite: %v", err)
	}

	reloaded, err := client.ReloadWhitelist()
	if err != nil {
		t.Fatalf("ReloadWhitelist: %v", err)
	}
	if !reloaded {
		t.Errorf("reloaded = false, want true")
	}
	if !client.IsWhitelisted(otherID) || client.WhitelistSize() != 2 {
		t.Errorf("whitelist after reload: size=%d", client.WhitelistSize())
	}

	if _, err := client.GetPlayer(context.Background(), otherID, "all", 200); err != nil {
		t.Fatalf("GetPlayer: %v", err)
	}
	if calls := transport.Calls(); calls != 0 {
		t.Errorf("HTTP calls = %d, want 0", calls)
	}
}

func TestReloadWhitelistWithoutFileIsNoop(t *testing.T) {
	client := NewWithWhitelist("http://bans.test", "wdb_test", []string{whitelistedID})

	reloaded, err := client.ReloadWhitelist()
	if err != nil {
		t.Fatalf("ReloadWhitelist: %v", err)
	}
	if reloaded {
		t.Errorf("reloaded = true, want false")
	}
	if !client.IsWhitelisted(whitelistedID) {
		t.Errorf("in-memory list was cleared")
	}
}

func TestSetAndLoadWhitelist(t *testing.T) {
	client := NewWithWhitelist("http://bans.test", "wdb_test", []string{whitelistedID})

	client.SetWhitelist([]string{otherID})
	if client.IsWhitelisted(whitelistedID) || !client.IsWhitelisted(otherID) {
		t.Fatalf("SetWhitelist did not replace the list")
	}

	path := filepath.Join(t.TempDir(), "wl.txt")
	if err := os.WriteFile(path, []byte(whitelistedID+"\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := client.LoadWhitelistFile(path); err != nil {
		t.Fatalf("LoadWhitelistFile: %v", err)
	}
	if !client.IsWhitelisted(whitelistedID) || client.WhitelistSize() != 1 {
		t.Errorf("whitelist after LoadWhitelistFile: size=%d", client.WhitelistSize())
	}
}

func TestWhitelistRejectsInvalidJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wl.json")
	if err := os.WriteFile(path, []byte(`[not json`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	if _, err := NewWithWhitelistFile("http://bans.test", "wdb_test", path); err == nil {
		t.Fatal("expected an error for invalid JSON")
	}
}

func contains(haystack, needle string) bool {
	return bytes.Contains([]byte(haystack), []byte(needle))
}
