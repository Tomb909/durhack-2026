"""Find the laptop's local IPv4 addresses so the phone knows where to connect."""

from __future__ import annotations

import socket


def local_ipv4s() -> list[str]:
    """Every usable local IPv4 address, most likely phone-reachable first."""
    ips: set[str] = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    # The address used for the default route (no packet is actually sent).
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            ips.add(s.getsockname()[0])
    except OSError:
        pass
    usable = [ip for ip in ips if not ip.startswith(("127.", "169.254."))]

    def rank(ip: str) -> tuple[int, str]:
        # iPhone hotspot hands out 172.20.10.x; Android hotspots 192.168.43.x and similar.
        if ip.startswith("172.20.10."):
            return (0, ip)
        if ip.startswith("192.168."):
            return (1, ip)
        return (2, ip)

    return sorted(usable, key=rank)
