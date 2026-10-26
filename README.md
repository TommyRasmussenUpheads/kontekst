# kontekst
Blogg for å skrive ned erfaringer

## Kontaktskjema (/kontakt)

Henvendelser lagres i `contact_messages` (SQLite), varsles på e-post via SMTP2Go og blir oppgaver i MGMT (prosjekt kontekst, pri 5, type `kontakt`).
Botsjekk: Cloudflare Turnstile (verifiseres server-side) + honeypot + minimum utfyllingstid + rate limit (5 per IP per time).
App-sider lenker til `/kontakt?app=<slug>`, som forhåndsvelger appen.

Miljøvariabler i `.env` (alle valgfrie, men uten dem faller funksjonen bort):

| Variabel | Bruk |
|---|---|
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile. Uten dem: bare honeypot, tidssjekk og rate limit |
| `SMTP2GO_API_KEY`, `SMTP2GO_SENDER` | E-postvarsel (standard avsender `kontekst <no-reply@skydotten.no>`) |
| `CONTACT_NOTIFY_TO` | Mottaker av varsel (standard `tommy@skydotten.no`) |
| `MGMT_API_URL`, `MGMT_CONTACT_TOKEN`, `MGMT_PROJECT_ID` | Oppgave i MGMT (agent-token, prosjekt 15) |
| `CONTACT_FORM_SECRET` | Fast nøkkel for skjema-tidsstempelet (ellers ny ved hver oppstart) |
| `CONTACT_URL` | Overstyr lenken fra app-sidene (standard `/kontakt`) |

Henvendelsene kan leses via `GET /internal/api/contact` (krever `x-internal-token`).
