// Submit bans to the federation.
//
//	BANLIST_KEY=wdb_... go run ./submit
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/KSroido/wardogs-ban-share/sdks/go/banlist"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	client := banlist.New(baseURL(), needEnv("BANLIST_KEY"))

	bans := []banlist.SubmitBanInput{
		{
			SteamID:        "76561198000000001",
			Reason:         banlist.ReasonCheat,
			Permanent:      true,
			PlayerName:     "example_player",
			Note:           "Aimbot, caught on spectator camera at 12:31.",
			EvidenceURL:    "https://example.com/clips/aimbot-1231.mp4",
			ExternalCaseID: "case-2026-10-19-001",
		},
		{
			SteamID:        "76561198000000002",
			Reason:         banlist.ReasonChatTroll,
			DurationDays:   7,
			Note:           "Repeated slurs in global chat after two warnings.",
			ExternalCaseID: "case-2026-10-19-002",
		},
	}

	// BANLIST_SERVER_ID = 成员服 id（组 key 必填；单服 key 可省略）
	serverID := os.Getenv("BANLIST_SERVER_ID")
	result, err := client.SubmitBans(ctx, bans)
	if serverID != "" {
		result, err = client.SubmitBansAs(ctx, serverID, bans)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "submit failed:", err)
		os.Exit(1)
	}

	fmt.Printf("created: %d\n", len(result.Created))
	for _, ban := range result.Created {
		fmt.Printf("  %s  %s  %s  %s  (reported by %d server(s))\n",
			ban.ID, ban.SteamID, ban.Reason, ban.DurationLabel(), ban.Reports.ServerCount)
	}

	for _, duplicate := range result.Duplicates {
		fmt.Printf("  [%d] %s already on file as %s\n", duplicate.Index, duplicate.SteamID, duplicate.ID)
	}

	for _, item := range result.Errors {
		fmt.Printf("  [%d] %s: %s\n", item.Index, item.Code, item.Message)
	}

	if len(result.Errors) > 0 {
		os.Exit(1)
	}
}

func baseURL() string {
	if value := os.Getenv("BANLIST_URL"); value != "" {
		return value
	}
	return "https://wardogs.ksroido.art/api/ban-share"
}

func needEnv(name string) string {
	value := os.Getenv(name)
	if value == "" {
		fmt.Fprintf(os.Stderr, "Missing %s. Export the key your server was issued.\n", name)
		os.Exit(1)
	}
	return value
}
