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

- `/onboard` — select a member, rank, and badge number; claims the first open `1Z-##` roster slot for that rank, writes only the Discord ID to Personnel Database I, join date F, promotion date G, status K, and the badge number to Personnel Roster G. Matching rank role is assigned if it already exists.
- `/move` — move rank, free old roster slot, claim new slot, update promotion date, replace matching rank role, skip rank-locked members.
- `/status` — update K using the MS status dropdown.
- `/strike` — toggle the next free strike checkbox (M then N).
- `/loa` — set Q=TRUE and K=LOA.
- `/clear` — clear strike/LOA flags.
- `/list` — show M/R flags and status.
- `/terminate` — O=TRUE, K=Terminated, and frees roster G.
- `/resign` — P=TRUE, K=Resigned, and frees roster G.
- `/reinstate` — returns status to Active and clears termination/resigned flags; use `/onboard` to place them back on the roster.
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


## Rank filtering and order

Rank autocomplete and `/ranks` only use rows that have a valid `1Z-##` call-sign in the Personnel Roster call-sign column. This prevents category/helper rows such as `Rank`, `Needs Training`, `Pre Command`, and other non-roster labels from appearing. Ranks are presented in command hierarchy order with `Director` first.


## Onboarding fields

`/onboard` now only asks for:
- `user`
- `rp_name`
- `rank`

The bot automatically selects the **highest-numbered available badge** in `Personnel Database` column B where the Discord ID column I is empty. It then writes the member's Discord ID to I, RP name to the configured RP-name column (default C), join date to F, promotion date to G, sets K to `Active`, and places the badge number into the selected Personnel Roster G slot.

No badge autocomplete/input is required.


## Existing supervisory/command roles

The bot never creates rank or permission roles. When onboarding or moving a member, it:
- assigns the existing role matching the selected rank;
- assigns the corresponding existing supervisory/command permission role;
- removes the previous supervisory/command permission tier when the rank changes.

Examples:
- `Supervisor` → `MS - Pre Supervisor`
- `Low Command` → `MS - Low Command`
- `Pre Command` / `Command in training` → `MS - Pre Command`
- `High Command` → `MS - High Command`
- `Chief of Staff` → `MS - Chief of staff`
- `Director` → `MS - Director`

If one of these permission roles does not already exist in the server, it is skipped; no role is created.
