"""SSRF protection enforcing public HTTPS on port 443 across all services."""
import ipaddress
import socket
from urllib.parse import urlparse


def public_https(url: str) -> str:
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.port not in {None, 443}
    ):
        raise ValueError("Only public HTTPS sources on port 443 are allowed.")
    host = parsed.hostname.lower()
    if host == "localhost" or host.endswith(".localhost"):
        raise ValueError("Private or reserved network sources are unavailable.")
    try:
        addresses = socket.getaddrinfo(parsed.hostname, 443)
    except socket.gaierror as exc:
        raise ValueError("Private or reserved network sources are unavailable.") from exc
    if not addresses:
        raise ValueError("Private or reserved network sources are unavailable.")
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        if (
            not ip.is_global
            or ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise ValueError("Private or reserved network sources are unavailable.")
    return url
