# Production credential files

Runtime credential files are stored only on the VPS in the Muse secrets directory.

The five music workers use independent Discord identities. Each worker receives only the credential file for its own identity.

Shared media-provider configuration can be mounted to all workers when required.

The dashboard uses a separate Discord OAuth application credential. The orchestrator does not receive any music-bot credential.

Each worker also has an independent control authentication key. The orchestrator has the five control keys so it can sign private configuration requests; an individual worker receives only its own control key.

The installer creates the expected files with host ownership `root:root` and mode `600`.

Never commit production credential contents.
