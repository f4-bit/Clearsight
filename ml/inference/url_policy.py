from __future__ import annotations

import fnmatch
from collections.abc import Sequence
from dataclasses import dataclass
from urllib.parse import ParseResult, urlparse

_ALLOWED_SCHEMES = frozenset({"http", "https"})


class SignedImageUrlError(ValueError):
    """Safe URL-policy failure with a fixed code and no raw URL in the message."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class ValidatedSignedImageUrl:
    url: str
    scheme: str
    hostname: str
    netloc: str


def host_is_allowed(
    hostname: str | None,
    netloc: str | None,
    patterns: Sequence[str],
) -> bool:
    """Return ``True`` when the host matches an explicit allowlist pattern.

    Patterns support shell-style wildcards (via :func:`fnmatch.fnmatchcase`), so
    Azure Blob Storage hosts such as ``clearsight.blob.core.windows.net`` match
    the ``*.blob.core.windows.net`` allowlist entry. An empty allowlist fails
    closed instead of allowing every host.
    """

    if not patterns:
        return False
    candidates = [value for value in (hostname, netloc) if value]
    return any(
        fnmatch.fnmatchcase(candidate, pattern)
        for pattern in patterns
        for candidate in candidates
    )


def validate_signed_image_url(
    url: str,
    *,
    allowed_signed_url_hosts: Sequence[str],
    allow_http_signed_urls: bool,
) -> ValidatedSignedImageUrl:
    """Validate a signed image URL against the trusted runtime policy.

    The helper is pure: no DNS resolution, no network, no SDK and no storage
    credentials. Errors are fixed safe codes and never include the raw URL.
    """

    if not isinstance(url, str) or not url.strip():
        raise SignedImageUrlError("invalid_image_url")
    try:
        parsed: ParseResult = urlparse(url)
    except ValueError as error:
        raise SignedImageUrlError("invalid_image_url") from error
    if parsed.scheme not in _ALLOWED_SCHEMES:
        raise SignedImageUrlError("invalid_image_url_scheme")
    if not parsed.hostname:
        raise SignedImageUrlError("invalid_image_url_host")
    if (
        parsed.username is not None
        or parsed.password is not None
        or "@" in parsed.netloc
    ):
        raise SignedImageUrlError("invalid_image_url_userinfo")
    if parsed.fragment or "#" in url:
        raise SignedImageUrlError("invalid_image_url_fragment")
    try:
        port = parsed.port
    except ValueError as error:
        raise SignedImageUrlError("invalid_image_url_port") from error
    if port is not None and not 1 <= port <= 65535:
        raise SignedImageUrlError("invalid_image_url_port")
    if not allowed_signed_url_hosts:
        raise SignedImageUrlError("image_url_host_allowlist_required")
    if parsed.scheme == "http" and not allow_http_signed_urls:
        raise SignedImageUrlError("http_image_urls_disabled")
    if not host_is_allowed(
        parsed.hostname,
        parsed.netloc,
        allowed_signed_url_hosts,
    ):
        raise SignedImageUrlError("image_url_host_not_allowed")
    return ValidatedSignedImageUrl(
        url=url,
        scheme=parsed.scheme,
        hostname=parsed.hostname,
        netloc=parsed.netloc,
    )
