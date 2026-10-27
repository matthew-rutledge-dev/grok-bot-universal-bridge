# Voice live test (manual, after cutover)

Status: **pending live**. CI and the smoke run cover voice only through an in-memory voice port. A real Discord voice channel has to be checked by the operator on the deployment host after the Discord adapter is switched over.

## Before you start

* The Discord adapter is running on the host with `voice.enabled: true`, and the test channel's id is in `voice.channels`.
* The bot has Connect + Speak in that channel, and you are in the channel so you can hear it.
* For `--speech`: Piper is configured (`voice.piperHostRef` / `voice.piperPortRef`).
* Inputs are **references only** (the script refuses literals):
  * `--bridge`: the bridge base URL, e.g. `env:VOICE_CHECK_BRIDGE_URL` set to the host's loopback URL.
  * `--token`: the Discord callback token, e.g. `file:/run/secrets/discord-callback-token` (the same file the bridge reads).
  * `--channel`: the voice channel id, e.g. `env:VOICE_CHECK_CHANNEL`.

## Run

```bash
node scripts/voice-live-check.mjs --bridge env:VOICE_CHECK_BRIDGE_URL \
  --token file:/run/secrets/discord-callback-token --channel env:VOICE_CHECK_CHANNEL --speech --drop
```

The image doesn't ship `scripts/`, so run it from a checkout on the host (Node 20+, no dependencies needed) against the bridge's loopback port.

## Checklist

| # | Step | Expect |
|---|---|---|
| 1 | healthz | 200 |
| 2 | play tone | 200, and you hear about 2 s of tone |
| 3 | play speech (`--speech`) | 200, and you hear the line |
| 4 | stream open | 200, the bot joins and stays |
| 5 | play while streaming | 409 `voice_stream_open` |
| 6 | stream add speech layer (`--speech`) | 200, and you hear it over the stream |
| 7 | stream status | `open: true` |
| 8 | stream close | 200, the bot leaves |
| 9 | play after close | 200 |
| 10 | stream open (`--drop`) | 200 |
| 11 | **disconnect the bot by hand** when the script prints `ACTION:` | status turns `open: false` within about 5 s of Discord giving up the reconnect |
| 12 | play after the drop | 200 (not a stuck 409) |

`RESULT: PASS` and exit code 0 mean every step passed. Record the date and result in the deploy notes, then remove "pending live" from this file and from the Discord adapter README.

## If a step fails

* 401: wrong token ref. 403 `voice_channel_not_allowlisted`: the channel isn't in `voice.channels`. 503 `voice_disabled`: `voice.enabled` is off.
* Step 2 is 502 `voice_play_failed`: check the bot's Connect/Speak permissions and that `@discordjs/voice` + `opusscript` are installed.
* Step 11 times out: the drop wasn't noticed. Capture the bridge log around the disconnect and report it. Close the stream by hand with `{ "op": "close" }`.
