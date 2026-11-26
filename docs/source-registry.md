# Official source registry

The registry records evidence linking a YouTube channel to an artist. It does not
certify rights in every upload or authorise downloading or automated access.
Unconfirmed and stale sources remain playable. Media extraction still uses the
existing VISIONOS client, format selection and challenge restrictions.

## Collection and publication

`scripts/source-registry.py` runs independently of the Room Server process under
`source-registry.service`, scheduled by `source-registry.timer` every 30 minutes
after the previous run finishes. It does not receive playback history, user links
or media. The initial import may take substantially longer than later refreshes.

The collector downloads the official MusicBrainz CC0 artist JSON dump only when
its version changes, verifies its published SHA-256, and streams it into a small
candidate database. The archive is deleted after processing. Production collection
does not use the public MusicBrainz API or the separately licensed Live Data Feed.
The dump is normally published twice a week.

Candidates must have MusicBrainz YouTube and Wikidata relationships. The collector
checks that Wikidata links back to the same MusicBrainz artist and agrees on the
channel. It then requires a matching link from the artist's official website or an
explicitly named artist card on a label website identified through Wikidata.
MusicBrainz and Wikidata agreement alone is insufficient; those databases may
reuse each other's information. Initial scheduling prioritises Adele and Lumen.
Each batch reserves capacity for both rechecking confirmations and discovering
unconfirmed candidates, so a large import cannot starve existing confirmations.

Requests are bounded, spaced per host, restricted to public HTTPS addresses and
revalidated on redirects. YouTube aliases are resolved as channel metadata without
downloading media or enabling player JavaScript. The collector does not solve
CAPTCHAs or bypass site protections. Unavailable sources are not newly confirmed;
the last successful evidence can be retained with its original date. Confirmations
expire after 30 days. Sources absent from a successfully retrieved primary page or
with conflicting metadata lose confirmation. Unrecognised label page layouts stay
unconfirmed.

The publisher signs the exact JSON payload with Ed25519 using
`/opt/ad-voice-source-registry/state/signing.pem`. Keep that private key restricted
to the collector account and preserve it for server recovery. It is never shipped
to clients. The corresponding public key is embedded in
`frontend/electron/SourceRegistry.ts`. A new key requires a client update.

Nginx serves the signed envelope at `/source-registry.json` using
`scripts/source-registry.nginx.conf`, included in the existing HTTPS server block.
Only this metadata endpoint is added; the room backend and audio relay are not
modified. The envelope is capped below the client's 8 MiB limit, favouring the most
recent confirmations when necessary.

## Client behaviour

Electron fetches the same public registry for all users on startup and every six
hours, without account credentials, playback identifiers or redirects. It checks
the signature, schema version, publication date and rollback before atomically
replacing `cache/source-registry.json` under the active backend data root. A failed
refresh retains the last good copy; an unavailable registry never blocks startup
or playback. No additional runtime dependency or interface control is required.

The existing VISIONOS extractor records `videoDetails.videoId` and `channelId`
locally in `cache/youtube-sources.sqlite3`. Each observation includes its date,
`confirmed`, `unconfirmed` or `stale` status and the matching evidence snapshot.
The last 1,000 distinct video observations are retained. These observations are
not uploaded or included in karaoke projects. Cache deletion removes them. A
subsequent playback records the result against the then-current registry.

## Deployment

Use the isolated root `/opt/ad-voice-source-registry`, owned by the collector
account (`ubuntu` in the current deployment). Its `state` and `cache` directories
are private; `public` is readable by Nginx. Install the collector's existing
`yt-dlp==2026.8.19` dependency into that root's `.venv`; do not change the Room
Server environment. Install the supplied systemd unit and timer, include the
supplied Nginx snippet, validate Nginx configuration and reload it gracefully.

Inspect `journalctl -u source-registry.service` for import and refresh results and
`systemctl list-timers source-registry.timer` for the next run. The service has low
CPU/IO priority, a CPU quota, bounded memory and no write access outside its state,
cache and public directories. Its logs contain public source information only.
