package banlist

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestSubmitBansChunksAt100(t *testing.T) {
	var calls int32
	var sizes []int
	var serverIDs []string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)

		var body struct {
			Bans     []SubmitBanInput `json:"bans"`
			ServerID string           `json:"server_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		sizes = append(sizes, len(body.Bans))
		serverIDs = append(serverIDs, body.ServerID)

		w.Header().Set("Content-Type", "application/json")
		if n == 1 {
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(SubmitBansResult{Created: []Ban{sampleBan("ban_1")}})
			return
		}
		// Second chunk comes back as a partial failure: index is relative to the chunk.
		w.WriteHeader(http.StatusMultiStatus)
		_ = json.NewEncoder(w).Encode(SubmitBansResult{
			Duplicates: []SubmitBanDuplicate{{
				Index: 0, ID: "ban_dup", SteamID: "76561198000000001",
				Reason: ReasonCheat, Status: "active",
			}},
		})
	}))
	defer server.Close()

	client := New(server.URL, "wdb_test")
	bans := make([]SubmitBanInput, 150)
	for i := range bans {
		bans[i] = SubmitBanInput{
			SteamID:        fmt.Sprintf("7656119%010d", i),
			Reason:         ReasonCheat,
			Permanent:      true,
			ExternalCaseID: fmt.Sprintf("case-%d", i),
		}
	}

	result, err := client.SubmitBans(context.Background(), bans)
	if err != nil {
		t.Fatalf("SubmitBans: %v", err)
	}

	if calls != 2 {
		t.Fatalf("requests = %d, want 2 (100 + 50)", calls)
	}
	if len(sizes) != 2 || sizes[0] != 100 || sizes[1] != 50 {
		t.Fatalf("chunk sizes = %v, want [100 50]", sizes)
	}
	if len(result.Created) != 1 {
		t.Errorf("created = %d, want 1", len(result.Created))
	}
	if len(result.Duplicates) != 1 {
		t.Fatalf("duplicates = %d, want 1", len(result.Duplicates))
	}
	if result.Duplicates[0].Index != 100 {
		t.Errorf("duplicate index = %d, want 100 (offset by the first chunk)",
			result.Duplicates[0].Index)
	}
	for _, id := range serverIDs {
		if id != "" {
			t.Errorf("single-server key sent server_id %q, want empty", id)
		}
	}
}

func TestSubmitBansAsSendsServerID(t *testing.T) {
	var gotServerID string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			ServerID string `json:"server_id"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		gotServerID = body.ServerID
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(SubmitBansResult{Created: []Ban{sampleBan("ban_1")}})
	}))
	defer server.Close()

	client := New(server.URL, "wdb_test")
	if _, err := client.SubmitBansAs(context.Background(), "wardogs-main", []SubmitBanInput{{
		SteamID: "76561198000000001", Reason: ReasonCheat, Permanent: true,
	}}); err != nil {
		t.Fatalf("SubmitBansAs: %v", err)
	}

	if gotServerID != "wardogs-main" {
		t.Errorf("server_id = %q, want wardogs-main", gotServerID)
	}

	if _, err := client.SubmitBansAs(context.Background(), "", []SubmitBanInput{{}}); err == nil {
		t.Error("SubmitBansAs with an empty server id should fail before hitting the network")
	}
}

func TestLookupSteamIDsChunksAt50(t *testing.T) {
	var sizes []int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := r.URL.Query().Get("steam_id")
		count := 1
		for _, ch := range raw {
			if ch == ',' {
				count++
			}
		}
		sizes = append(sizes, count)

		if status := r.URL.Query().Get("status"); status != "active" {
			t.Errorf("status = %q, want active", status)
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ListBansResult{Data: []Ban{}})
	}))
	defer server.Close()

	client := New(server.URL, "wdb_test")
	ids := make([]string, 120)
	for i := range ids {
		ids[i] = fmt.Sprintf("7656119%010d", i)
	}

	if _, err := client.LookupSteamIDs(context.Background(), ids); err != nil {
		t.Fatalf("LookupSteamIDs: %v", err)
	}

	if len(sizes) != 3 {
		t.Fatalf("requests = %d, want 3 (50 + 50 + 20)", len(sizes))
	}
	want := []int{50, 50, 20}
	for i := range want {
		if sizes[i] != want[i] {
			t.Fatalf("chunk sizes = %v, want %v", sizes, want)
		}
	}
}

func TestRetriesOnServerError(t *testing.T) {
	var calls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		w.Header().Set("Content-Type", "application/json")
		if n == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":{"code":"internal","message":"boom"}}`))
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(SubmitBansResult{Created: []Ban{sampleBan("ban_1")}})
	}))
	defer server.Close()

	client := New(server.URL, "wdb_test")
	client.Retries = 2

	if _, err := client.SubmitBan(context.Background(), SubmitBanInput{
		SteamID: "76561198000000001", Reason: ReasonCheat, Permanent: true,
	}); err != nil {
		t.Fatalf("SubmitBan after retry: %v", err)
	}
	if calls != 2 {
		t.Errorf("requests = %d, want 2 (500 then success)", calls)
	}
}

func TestDoesNotRetry4xx(t *testing.T) {
	var calls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"code":"unauthorized","message":"Unknown API key."}}`))
	}))
	defer server.Close()

	client := New(server.URL, "wdb_test")
	client.Retries = 3

	_, err := client.ListBans(context.Background(), ListBansQuery{Limit: 1})
	if err == nil {
		t.Fatal("expected an error for 401")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error type = %T, want *APIError", err)
	}
	if apiErr.Code != "unauthorized" {
		t.Errorf("code = %q, want unauthorized", apiErr.Code)
	}
	if calls != 1 {
		t.Errorf("requests = %d, want 1 (4xx is not retried)", calls)
	}
}
