package banlist

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func sampleBan(id string) Ban {
	permanent := true
	return Ban{
		ID:        id,
		Server:    ServerRef{ID: "demo", Name: "Demo Server"},
		SteamID:   "76561198000000001",
		Reason:    ReasonCheat,
		Permanent: permanent,
		Status:    "active",
		CreatedAt: "2026-10-01T00:00:00.000Z",
		UpdatedAt: "2026-10-01T00:00:00.000Z",
		Reports: PlayerReports{
			SteamID:           "76561198000000001",
			ServerCount:       2,
			ActiveServerCount: 1,
			BanCount:          2,
			ActiveBanCount:    1,
			PermanentCount:    1,
			ReasonCounts:      map[Reason]int{ReasonCheat: 1, ReasonChatTroll: 1},
		},
	}
}

func TestSubmitBan(t *testing.T) {
	var gotAuth string
	var gotBody struct {
		Bans []SubmitBanInput `json:"bans"`
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		if r.Method != http.MethodPost || r.URL.Path != "/v1/bans" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode body: %v", err)
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(SubmitBansResult{Created: []Ban{sampleBan("ban_1")}})
	}))
	defer server.Close()

	client := New(server.URL, "wdb_test")
	ban, err := client.SubmitBan(context.Background(), SubmitBanInput{
		SteamID:        "76561198000000001",
		Reason:         ReasonCheat,
		Permanent:      true,
		ExternalCaseID: "case-1",
	})
	if err != nil {
		t.Fatalf("SubmitBan: %v", err)
	}

	if gotAuth != "Bearer wdb_test" {
		t.Errorf("auth header = %q", gotAuth)
	}
	if len(gotBody.Bans) != 1 || gotBody.Bans[0].ExternalCaseID != "case-1" {
		t.Errorf("body = %+v", gotBody.Bans)
	}
	if ban.ID != "ban_1" || ban.Reports.ServerCount != 2 {
		t.Errorf("ban = %+v", ban)
	}
	if ban.DurationLabel() != "permanent" {
		t.Errorf("duration = %q", ban.DurationLabel())
	}
}

func TestSubmitBanDuplicate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(SubmitBansResult{
			Duplicates: []SubmitBanDuplicate{
				{Index: 0, ID: "ban_9", SteamID: "76561198000000001", Reason: ReasonCheat, Status: "active"},
			},
		})
	}))
	defer server.Close()

	client := New(server.URL, "wdb_test")
	_, err := client.SubmitBan(context.Background(), SubmitBanInput{
		SteamID:   "76561198000000001",
		Reason:    ReasonCheat,
		Permanent: true,
	})

	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected APIError, got %v", err)
	}
	if apiErr.Code != "duplicate_ban" || apiErr.Status != http.StatusConflict {
		t.Errorf("error = %+v", apiErr)
	}
}

func TestForEachBanFollowsCursor(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		query := r.URL.Query()
		next := "cursor-2"

		if query.Get("cursor") == "cursor-2" {
			_ = json.NewEncoder(w).Encode(ListBansResult{
				Data:       []Ban{sampleBan("ban_2")},
				NextCursor: nil,
				HasMore:    false,
			})
			return
		}

		_ = json.NewEncoder(w).Encode(ListBansResult{
			Data:       []Ban{sampleBan("ban_1")},
			NextCursor: &next,
			HasMore:    true,
		})
	}))
	defer server.Close()

	client := New(server.URL, "wdb_test")

	var ids []string
	err := client.ForEachBan(context.Background(), ListBansQuery{Status: "all"}, func(ban Ban) error {
		ids = append(ids, ban.ID)
		return nil
	})
	if err != nil {
		t.Fatalf("ForEachBan: %v", err)
	}

	if len(ids) != 2 || ids[0] != "ban_1" || ids[1] != "ban_2" {
		t.Errorf("ids = %v", ids)
	}
	if calls != 2 {
		t.Errorf("calls = %d", calls)
	}
}

func TestListBansEncodesQuery(t *testing.T) {
	var seen map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = map[string]string{}
		for key, value := range r.URL.Query() {
			seen[key] = value[0]
		}
		_ = json.NewEncoder(w).Encode(ListBansResult{Data: []Ban{}})
	}))
	defer server.Close()

	client := New(server.URL, "wdb_test")
	permanent := true

	_, err := client.ListBans(context.Background(), ListBansQuery{
		Status:    "all",
		Reasons:   []Reason{ReasonCheat, ReasonRacism},
		SteamIDs:  []string{"76561198000000001"},
		Permanent: &permanent,
		Limit:     9999,
	})
	if err != nil {
		t.Fatalf("ListBans: %v", err)
	}

	if seen["reason"] != "cheat,racism" {
		t.Errorf("reason = %q", seen["reason"])
	}
	if seen["steam_id"] != "76561198000000001" {
		t.Errorf("steam_id = %q", seen["steam_id"])
	}
	if seen["permanent"] != "true" {
		t.Errorf("permanent = %q", seen["permanent"])
	}
	if seen["limit"] != "500" {
		t.Errorf("limit = %q", seen["limit"])
	}
}

func TestAPIErrorEnvelope(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"code":"forbidden","message":"A server may only revoke its own bans."},"request_id":"req_1"}`))
	}))
	defer server.Close()

	client := New(server.URL, "wdb_test")
	_, err := client.RevokeBan(context.Background(), "ban_1", "")

	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected APIError, got %v", err)
	}
	if apiErr.Code != "forbidden" || !apiErr.IsAuthError() {
		t.Errorf("error = %+v", apiErr)
	}
	if apiErr.RequestID != "req_1" {
		t.Errorf("request id = %q", apiErr.RequestID)
	}
}

func TestGetPlayerRejectsBadSteamID(t *testing.T) {
	client := New("http://127.0.0.1:1", "wdb_test")
	if _, err := client.GetPlayer(context.Background(), "123", "all", 10); err == nil {
		t.Fatal("expected an error for a malformed SteamID64")
	}
}
