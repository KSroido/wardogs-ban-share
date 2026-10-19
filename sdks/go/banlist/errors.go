package banlist

import (
	"encoding/json"
	"fmt"
)

// APIError is returned for every non-2xx response.
// Branch on Code; the Message is for humans and may change.
type APIError struct {
	Status    int
	Code      string
	Message   string
	Details   json.RawMessage
	RequestID string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("banlist: %s (HTTP %d, %s)", e.Message, e.Status, e.Code)
}

func (e *APIError) IsAuthError() bool {
	return e.Status == 401 || e.Status == 403
}

func (e *APIError) IsRetryable() bool {
	return e.Status == 0 || e.Status == 429 || e.Status >= 500
}
