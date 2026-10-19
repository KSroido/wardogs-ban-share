// Pull bans and print them, newest first.
//
//	BANLIST_KEY=wdb_... go run ./pull
//	BANLIST_KEY=wdb_... go run ./pull 2026-10-01T00:00:00.000Z
//
// The optional argument is an ISO timestamp. Store the newest UpdatedAt you see
// and pass it next time; that is the whole incremental sync. Keep Status "all"
// so revocations reach you.
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/KSroido/wardogs-ban-share/sdks/go/banlist"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	client := banlist.New(baseURL(), needEnv("BANLIST_KEY"))

	query := banlist.ListBansQuery{Status: "all", Limit: 500}
	if len(os.Args) > 1 {
		query.Since = os.Args[1]
	}

	count := 0
	err := client.ForEachBan(ctx, query, func(ban banlist.Ban) error {
		count++
		fmt.Printf("%-18s  %-10s  %-12s  %-10s  %-9s  %s\n",
			ban.SteamID,
			string(ban.Reason),
			ban.Server.Name,
			ban.DurationLabel(),
			ban.Status,
			ban.CreatedAt,
		)
		return nil
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "pull failed:", err)
		os.Exit(1)
	}

	fmt.Printf("\n%d ban record(s)\n", count)

	// The per-SteamID aggregate: who has been reported by the most servers.
	players, err := client.ListPlayers(ctx, "servers", 5, 0)
	if err != nil {
		fmt.Fprintln(os.Stderr, "list players failed:", err)
		os.Exit(1)
	}

	fmt.Println("\nmost reported players:")
	for _, player := range players.Data {
		fmt.Printf("  %s  servers=%d active=%d permanent=%d\n",
			player.SteamID, player.ServerCount, player.ActiveBanCount, player.PermanentCount)
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
