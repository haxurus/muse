# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories:

<https://github.com/haxurus/muse/security/advisories/new>

Do not open a public issue, pull request or discussion for a suspected vulnerability, and do not include live tokens or production data in the report. The maintainer follows up in the advisory thread; fixes are prepared privately and published together with the advisory.

Vulnerabilities in upstream Muse that are not specific to this fork should also be reported to [museofficial/muse](https://github.com/museofficial/muse).

## Production deployment

The production profile follows least privilege:

- no host ports are published by the bot;
- the container runs as a non-root user and the application files are root-owned;
- Linux capabilities are dropped;
- no-new-privileges is enabled;
- the container root filesystem is read-only;
- only the persistent data directory and temporary filesystem are writable;
- credentials are supplied through mounted secret files;
- generic HTTP stream support is disabled by default;
- CPU, memory and PID usage are bounded;
- deployment uses a restricted SSH account with a root-owned forced-command key;
- images are deployed by digest, built from a digest-pinned base image with a hash-locked yt-dlp, and carry SBOM and provenance attestations;
- the public dashboard edge sits on a dedicated internal network shared only with the reverse proxy and has no Internet route;
- a host firewall isolates every Muse bridge from host services and private networks.

## External stream sources

YouTube, SoundCloud and Spotify are handled as known providers.

Generic HTTP/HTTPS streams are disabled by default. If explicitly enabled, configure an allowlist:

```dotenv
ALLOW_HTTP_STREAMS=true
HTTP_STREAM_ALLOWED_HOSTS=radio.example.com,stream.example.net
```

Keep the allowlist limited to services you control or explicitly trust.

## Secrets

Do not commit tokens, API keys, cookie exports, SSH private keys, or production backups.

If a credential may have been exposed, rotate it before restoring normal service.
