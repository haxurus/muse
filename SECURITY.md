# Security Policy

## Production deployment

The production profile follows least privilege:

- no host ports are published by the bot;
- the container runs as a non-root user;
- Linux capabilities are dropped;
- no-new-privileges is enabled;
- the container root filesystem is read-only;
- only the persistent data directory and temporary filesystem are writable;
- credentials are supplied through mounted secret files;
- generic HTTP stream support is disabled by default;
- CPU, memory and PID usage are bounded;
- deployment uses a restricted SSH account.

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
