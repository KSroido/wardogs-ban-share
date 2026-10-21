package banlist

import "fmt"

// Reason is one of the eight accepted ban reasons.
type Reason string

const (
	ReasonCheat     Reason = "cheat"
	ReasonRulebreak Reason = "rulebreak"
	ReasonChatTroll Reason = "chattroll"
	ReasonGameTroll Reason = "gametroll"
	ReasonRacism    Reason = "racism"
	ReasonForeignOfServerLocation Reason = "foreignofserverlocation"
	// ReasonForeigner is the pre-0.2 name of ReasonForeignOfServerLocation; deprecated.
	ReasonForeigner Reason = ReasonForeignOfServerLocation
	ReasonSteamRisk Reason = "steamrisk"
	ReasonOwnReason Reason = "ownreason"
)

// Reasons lists every accepted value, in documentation order.
var Reasons = []Reason{
	ReasonCheat,
	ReasonRulebreak,
	ReasonChatTroll,
	ReasonGameTroll,
	ReasonRacism,
	ReasonForeigner,
	ReasonSteamRisk,
	ReasonOwnReason,
}

type ServerRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Server struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Status    string  `json:"status"`
	Note      *string `json:"note"`
	CreatedAt string  `json:"created_at"`
}

// PlayerReports is the per-SteamID aggregate: how many distinct servers
// reported this player, how many bans are in force, and the reason breakdown.
type PlayerReports struct {
	SteamID           string       `json:"steam_id"`
	ServerCount       int          `json:"server_count"`
	ActiveServerCount int          `json:"active_server_count"`
	BanCount          int          `json:"ban_count"`
	ActiveBanCount    int          `json:"active_ban_count"`
	PermanentCount    int          `json:"permanent_count"`
	ReasonCounts      map[Reason]int `json:"reason_counts"`
	FirstReportedAt   *string      `json:"first_reported_at"`
	LastReportedAt    *string      `json:"last_reported_at"`
	UpdatedAt         string       `json:"updated_at"`
}

type Ban struct {
	ID             string        `json:"id"`
	Server         ServerRef     `json:"server"`
	SteamID        string        `json:"steam_id"`
	PlayerName     *string       `json:"player_name"`
	Reason         Reason        `json:"reason"`
	Note           *string       `json:"note"`
	EvidenceURL    *string       `json:"evidence_url"`
	Permanent      bool          `json:"permanent"`
	DurationDays   *int          `json:"duration_days"`
	ExpiresAt      *string       `json:"expires_at"`
	Status         string        `json:"status"`
	ExternalCaseID *string       `json:"external_case_id"`
	CreatedAt      string        `json:"created_at"`
	UpdatedAt      string        `json:"updated_at"`
	RevokedAt      *string       `json:"revoked_at"`
	RevokeReason   *string       `json:"revoke_reason"`
	Reports        PlayerReports `json:"reports"`
}

// DurationLabel is "permanent" or e.g. "7d", ready for a console table.
func (b Ban) DurationLabel() string {
	if b.Permanent {
		return "permanent"
	}
	if b.DurationDays == nil {
		return "unknown"
	}
	return fmt.Sprintf("%dd", *b.DurationDays)
}

// SubmitBanInput is the body of one entry in POST /v1/bans.
// Optional fields are omitted when empty.
type SubmitBanInput struct {
	SteamID        string `json:"steam_id"`
	Reason         Reason `json:"reason"`
	Permanent      bool   `json:"permanent"`
	DurationDays   int    `json:"duration_days,omitempty"`
	Note           string `json:"note,omitempty"`
	EvidenceURL    string `json:"evidence_url,omitempty"`
	PlayerName     string `json:"player_name,omitempty"`
	ExternalCaseID string `json:"external_case_id,omitempty"`
}

type SubmitBanDuplicate struct {
	Index   int    `json:"index"`
	ID      string `json:"id"`
	SteamID string `json:"steam_id"`
	Reason  Reason `json:"reason"`
	Status  string `json:"status"`
}

type SubmitBanError struct {
	Index   int    `json:"index"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type SubmitBansResult struct {
	Created    []Ban                `json:"created"`
	Duplicates []SubmitBanDuplicate `json:"duplicates"`
	Errors     []SubmitBanError     `json:"errors"`
}

type ListBansQuery struct {
	Since     string
	Cursor    string
	Limit     int
	Reasons   []Reason
	SteamIDs  []string
	Servers   []string
	Permanent *bool
	// Status is active (default), expired, revoked or all. Use all for sync.
	Status string
}

type ListBansResult struct {
	Data       []Ban   `json:"data"`
	NextCursor *string `json:"next_cursor"`
	HasMore    bool    `json:"has_more"`
	ServerTime string  `json:"server_time"`
}

type PlayerDetail struct {
	SteamID string        `json:"steam_id"`
	Reports PlayerReports `json:"reports"`
	Bans    []Ban         `json:"bans"`
	// Whitelisted 为 true 时表示这是 SDK 的本地结果：命中本地白名单，
	// 没有查询服务端，Reports 全零、Bans 为空。服务端响应没有这个字段。
	Whitelisted bool `json:"whitelisted"`
}

type ListPlayersResult struct {
	Data   []PlayerReports `json:"data"`
	Total  int             `json:"total"`
	Limit  int             `json:"limit"`
	Offset int             `json:"offset"`
}
