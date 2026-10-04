# Runtime secrets

Production secrets live only on the VPS under `/srv/docker/muse/secrets`.

Required:

- `discord_token`
- `youtube_api_key`

Optional Spotify credentials:

- `spotify_client_id`
- `spotify_client_secret`

If Spotify is disabled, keep both Spotify files empty.

The deployment installer creates these files with root-only host permissions. Never commit their contents.
