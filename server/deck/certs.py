"""Local certificate authority and server certificate for the phone link.

The phone's browser only opens the camera on a secure (HTTPS) page. We create
our own small certificate authority once, then issue a server certificate for
whatever IP addresses the laptop currently has. The phone can either tap
through the warning, or install the authority (served at /ca.crt) and trust it.
"""

from __future__ import annotations

import datetime as dt
import ipaddress
import json
import socket
import ssl
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

CA_NAME = "Deck of Worlds Local CA"


def _write_key(path: Path, key: rsa.RSAPrivateKey) -> None:
    path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )


def _load_key(path: Path) -> rsa.RSAPrivateKey:
    return serialization.load_pem_private_key(path.read_bytes(), password=None)  # type: ignore[return-value]


def _ensure_ca(folder: Path) -> tuple[rsa.RSAPrivateKey, x509.Certificate]:
    key_path, crt_path = folder / "ca.key", folder / "ca.crt"
    if key_path.exists() and crt_path.exists():
        return _load_key(key_path), x509.load_pem_x509_certificate(crt_path.read_bytes())
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, CA_NAME)])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=800))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, key_cert_sign=True, crl_sign=True,
                content_commitment=False, key_encipherment=False, data_encipherment=False,
                key_agreement=False, encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    _write_key(key_path, key)
    crt_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return key, cert


def _issue_leaf(folder: Path, ips: list[str]) -> None:
    ca_key, ca_cert = _ensure_ca(folder)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    now = dt.datetime.now(dt.timezone.utc)
    names: list[x509.GeneralName] = [x509.DNSName("localhost"), x509.DNSName(socket.gethostname())]
    for ip in ["127.0.0.1", *ips]:
        names.append(x509.IPAddress(ipaddress.ip_address(ip)))
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Deck of Worlds")]))
        .issuer_name(ca_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=397))
        .add_extension(x509.SubjectAlternativeName(names), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, key_encipherment=True, key_cert_sign=False, crl_sign=False,
                content_commitment=False, data_encipherment=False, key_agreement=False,
                encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False
        )
        .sign(ca_key, hashes.SHA256())
    )
    _write_key(folder / "leaf.key", key)
    chain = cert.public_bytes(serialization.Encoding.PEM) + ca_cert.public_bytes(serialization.Encoding.PEM)
    (folder / "leaf.crt").write_bytes(chain)
    (folder / "leaf.json").write_text(json.dumps({"ips": sorted(ips)}))


class CertManager:
    """Keeps one SSL context whose certificate always covers the current IPs."""

    def __init__(self, folder: Path) -> None:
        self.folder = folder
        folder.mkdir(parents=True, exist_ok=True)
        self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.ips: list[str] = []

    @property
    def ca_path(self) -> Path:
        return self.folder / "ca.crt"

    def refresh(self, ips: list[str]) -> bool:
        """Make sure the certificate covers `ips`. Returns True if it was reissued."""
        ips = sorted(ips)
        meta = self.folder / "leaf.json"
        on_disk: list[str] | None = None
        if meta.exists() and (self.folder / "leaf.crt").exists() and (self.folder / "leaf.key").exists():
            try:
                on_disk = json.loads(meta.read_text())["ips"]
            except (ValueError, KeyError):
                on_disk = None
        reissued = False
        if on_disk is None or not set(ips) <= set(on_disk) or not self.ca_path.exists():
            _issue_leaf(self.folder, ips)
            reissued = True
        if reissued or not self.ips:
            self.context.load_cert_chain(self.folder / "leaf.crt", self.folder / "leaf.key")
        self.ips = ips
        return reissued
