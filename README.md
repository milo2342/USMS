# San Andreas State Marshals — Department Bot v2

Complete MS department Discord + Google Sheets bot.

## Main spreadsheet workflow

### Personnel Roster
- **B** = Rank
- **F** = Call-sign (`1Z-##`)
- **G** = Badge number placed into the selected rank slot

### Personnel Database
- **B** = Badge number
- **F** = Join Date
- **G** = Promotion Date
- **I** = Discord ID
- **K** = MS Status
- **M** = Strike 1
- **N** = Strike 2
- **O** = Terminated
- **P** = Resigned
- **Q** = LOA
- **R** = Rank Locked

No new role is ever created by the bot. Whenever a rank/department role is needed, the bot searches the current guild for an existing role using exact or normalized/similar-name matching.

## Staff / roster commands

- `/add` — select a member, rank, and badge number; claims the first open `1Z-##` roster slot for that rank, writes only the Discord ID to Personnel Database I, join date F, promotion date G, status K, and the badge number to Personnel Roster G. Matching rank role is assigned if it already exists.
- `/move` — move rank, free old roster slot, claim new slot, update promotion date, replace matching rank role, skip rank-locked members.
- `/status` — update K using the MS status dropdown.
- `/strike` — toggle the next free strike checkbox (M then N).
- `/loa` — set Q=TRUE and K=LOA.
- `/clear` — clear strike/LOA flags.
- `/list` — show M/R flags and status.
- `/terminate` — O=TRUE, K=Terminated, and frees roster G.
- `/resign` — P=TRUE, K=Resigned, and frees roster G.
- `/reinstate` — returns status to Active and clears termination/resigned flags; use `/add` to place them back on the roster.
- `/lookup` — show Personnel Database + roster information.
- `/ranks` — show ranks live from Personnel Roster B.
- `/mass promotions` and `/mass demotions` — bulk rank movement for eligible members.

## Logging system

Command-team log commands:
- `/removal-logs`
- `/demotion-logs`
- `/transfer-logs`
- `/task-logs`
- `/inactivity-warning-logs`
- `/loa-logs`
- `/supervisor-interview-logs`
- `/fta-interview-logs`

Configure the destination for any of these with `/logs channel`.

General audit logging:
- `/logs channel`
- `/logs status`
- `/command role log`

Promotion announcements automatically log to the channel chosen with `/promotion logs`.

## Training system

Hard-coded MS training destinations from the requested server:
- Cadet training: channel `1543149034229866514`
- FTO/FTA training: channel `1543149033726414876`
- Reminder/setup channel: `1543149034229866515`
- Guild: `1543149025526808616`

`/host training` creates both announcements, adds attendance buttons, schedules the 10-minute reminder, and DMs people who selected an attending option.

The bot looks up existing roles using similar-name matching (`MS - Cadet`, `MS | Cadet`, `MS Cadet`, etc.). It never creates training roles.

Use `/fto-set` to select the existing role allowed to host training announcements. Owners/configured command team can set it.

## Railway

Start command: `npm start`

Required variables:
- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `OWNER_IDS`
- `GOOGLE_SHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_JSON`

The bot uses a small JSON config file for per-guild settings. If you need those settings to survive Railway redeploys, attach a Railway persistent volume to the app directory containing `data/`.

Required Discord permissions include View Channels, Send Messages, Embed Links, Use Application Commands, Manage Roles (to assign/remove existing roles), Manage Nicknames, and the Members intent.
