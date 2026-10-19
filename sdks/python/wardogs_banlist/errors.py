from __future__ import annotations

from typing import Any, Dict, Optional


class BanListError(Exception):
    """A failed API call. `code` is stable, `message` is for humans."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        details: Optional[Any] = None,
        request_id: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details
        self.request_id = request_id

    def __str__(self) -> str:
        suffix = " (request %s)" % self.request_id if self.request_id else ""
        return "%s [%s %s]%s" % (self.message, self.status, self.code, suffix)

    @property
    def is_auth_error(self) -> bool:
        return self.status in (401, 403)

    @property
    def is_retryable(self) -> bool:
        return self.status == 0 or self.status == 429 or self.status >= 500

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "code": self.code,
            "message": self.message,
            "details": self.details,
            "request_id": self.request_id,
        }
