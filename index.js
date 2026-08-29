import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { DateTime } from "luxon";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";
import { google } from "googleapis";

const DEPARTMENT = "San Andreas State Marshals";
const TRAINING_GUILD_ID = "1543149025526808616";
const CADET_CHANNEL_ID = "1543149034229866514";
const FTO_CHANNEL_ID = "1543149033726414876";
const TRAINING_INFO_CHANNEL_ID = "1543149034229866515";
const TRAINING_TZ = process.env.TRAINING_TIMEZONE || "Europe/London";
const ROLE_TARGETS = {
  cadet: "MS - Cadet",
  fto: "MS - FTO",
  fta: "MS - FTA"
};

const COLORS = {
  black: 0x0b0b0b,
  red: 0xe74c3c,
  green: 0x2ecc71,
  blue: 0x3498db,
  gold: 0xf1c40f,
  purple: 0x8e44ad
};

const STATUS = [
  "Active", "Semi-Active", "Inactive", "Suspended", "LOA", "Vacant", "Reserve",
  "Terminated", "Resigned", "Management", "Exempt", "Handpicked To DHS", "Handpicked to SP"
];

const LOG_TYPES = {
  removal: {label: "Removal", key: "removal"},
  demotion: {label: "Demotion", key: "demotion"},
  transfer: {label: "Transfer", key: "transfer"},
  task: {label: "Task", key: "task"},
  inactivity: {label: "Inactivity Warning", key: "inactivity"},
  loa: {label: "LOA", key: "loa"},
  supervisorInterview: {label: "Supervisor Interview", key: "supervisorInterview"},
  ftaInterview: {label: "FTA Interview", key: "ftaInterview"},
  training: {label: "Training", key: "training"}
};

const C = {
  spreadsheetId: process.env.GOOGLE_SHEET_ID,
  rosterSheet: process.env.PERSONNEL_ROSTER_SHEET_NAME || "Personnel Roster",
  databaseSheet: process.env.PERSONNEL_DATABASE_SHEET_NAME || "Personnel Database",
  personnelStartRow: Number(process.env.PERSONNEL_DATA_START_ROW || 2),
  rosterRankCol: "B",
  rosterCallsignCol: "F",
  rosterBadgeCol: "G",
  dbBadgeCol: "B",
  dbRpNameCol: process.env.PERSONNEL_DATABASE_RP_NAME_COL || "D",
  dbJoinDateCol: "F",
  dbPromotionDateCol: "G",
  dbDiscordIdCol: "I",
  dbStatusCol: "K",
  dbStrike1Col: "M",
  dbStrike2Col: "N",
  dbTerminationCol: "O",
  dbResignedCol: "P",
  dbLoaCol: "Q",
  dbRankLockedCol: "R"
};

const DATA_DIR = path.resolve(process.cwd(), "data");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const TRAININGS_FILE = path.join(DATA_DIR, "trainings.json");

let settings = { guilds: {} };
let trainings = {};
const timers = new Map();

await fs.mkdir(DATA_DIR, { recursive: true });
try { settings = JSON.parse(await fs.readFile(CONFIG_FILE, "utf8")); } catch {}
try { trainings = JSON.parse(await fs.readFile(TRAININGS_FILE, "utf8")); } catch {}
settings.guilds ||= {};

async function saveSettings() { await fs.writeFile(CONFIG_FILE, JSON.stringify(settings, null, 2)); }
async function saveTrainings() { await fs.writeFile(TRAININGS_FILE, JSON.stringify(trainings, null, 2)); }
function guildSettings(guildId) {
  settings.guilds[guildId] ||= { logRoleId: "", auditChannelId: "", promotionChannelId: "", logChannels: {}, ftoRoleId: "" };
  settings.guilds[guildId].logChannels ||= {};
  return settings.guilds[guildId];
}

function colNum(col) { let n = 0; for (const ch of col) n = n * 26 + ch.charCodeAt(0) - 64; return n; }
function cell(row, col) { return row?.[colNum(col) - 1] ?? ""; }
function clean(v) { return String(v ?? "").trim(); }
function isTrue(v) { return ["true", "1", "yes", "y", "checked"].includes(clean(v).toLowerCase()); }
function today() { return DateTime.now().setZone(TRAINING_TZ).toFormat("yyyy-MM-dd"); }
function stamp() { return DateTime.now().setZone(TRAINING_TZ).toISO(); }
function safeText(v) { return clean(v).slice(0, 1000) || "—"; }

function normalizeName(name) {
  return clean(name)
    .toLowerCase()
    .replace(/wcrp|san\s*andreas\s*state\s*marshals|state\s*marshals|ms/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
function tokens(name) { return normalizeName(name).split(" ").filter(Boolean); }

function findSimilarRole(guild, targetName) {
  const target = normalizeName(targetName);
  const exact = guild.roles.cache.find(r => normalizeName(r.name) === target);
  if (exact) return exact;
  const t = tokens(targetName);
  let best = null;
  let score = 0;
  for (const role of guild.roles.cache.values()) {
    if (role.managed) continue;
    const rt = tokens(role.name);
    const overlap = t.filter(x => rt.includes(x)).length;
    if (overlap === t.length && overlap > score) { best = role; score = overlap; }
  }
  return best;
}
function findRoleByMentionable(guild, roleId) { return roleId ? guild.roles.cache.get(roleId) || null : null; }

// Permission / supervisory roles are NOT ranks. They are extra existing roles
// granted according to the member's current rank. The bot never creates them.
const SUPPORT_RANK_ROLES = [
  { roleName: "MS - Probationary Deputy Marshal", ranks: ["Probationary Deputy Marshal"] },
  { roleName: "MS - Low Command", ranks: ["Low Command"] },
  { roleName: "MS - Pre Command", ranks: ["Pre Command", "Command in training"] },
  { roleName: "MS - Heads", ranks: ["High Command"] },
  { roleName: "MS - Chief of staff", ranks: ["Chief of Staff"] },
  { roleName: "MS - Director", ranks: ["Director"] }
];

function rankMatches(rank, candidate) {
  const a = normalizeName(rank);
  const b = normalizeName(candidate);
  return a === b || a.includes(b) || b.includes(a);
}

async function applySupportRankRole(guild, member, rank) {
  // Remove any other supervisory/command permission tier first, then add
  // the tier that corresponds to the new rank. Matching uses existing roles
  // only and never creates a role.
  for (const mapping of SUPPORT_RANK_ROLES) {
    const role = findSimilarRole(guild, mapping.roleName);
    if (!role || role.managed) continue;
    const shouldHave = mapping.ranks.some(r => rankMatches(rank, r));
    if (shouldHave) {
      if (!member.roles.cache.has(role.id)) {
        await member.roles.add(role).catch(() => {});
      }
    } else if (member.roles.cache.has(role.id)) {
      await member.roles.remove(role).catch(() => {});
    }
  }
}

const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}");
if (!C.spreadsheetId) throw new Error("GOOGLE_SHEET_ID is required.");
if (!creds.client_email || !creds.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is required.");
creds.private_key = String(creds.private_key).replace(/\\n/g, "\n");
const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const sheets = google.sheets({ version: "v4", auth });

async function getValues(sheet, range = "") {
  const ref = range ? `${sheet}!${range}` : sheet;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: C.spreadsheetId, range: ref });
  return res.data.values || [];
}
async function setCell(sheet, ref, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: C.spreadsheetId,
    range: `${sheet}!${ref}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[value]] }
  });
}
async function setCells(sheet, updates) {
  const data = Object.entries(updates).map(([ref, value]) => ({ range: `${sheet}!${ref}`, values: [[value]] }));
  if (!data.length) return;
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: C.spreadsheetId, requestBody: { valueInputOption: "USER_ENTERED", data } });
}

async function rosterRows() { return getValues(C.rosterSheet); }
async function dbRows() { return getValues(C.databaseSheet); }
async function findDatabaseByDiscordId(id) {
  const rows = await dbRows();
  for (let i = 1; i < rows.length; i++) if (clean(cell(rows[i], C.dbDiscordIdCol)) === String(id)) return { row: i + 1, values: rows[i] };
  return null;
}
async function findDatabaseByBadge(badge) {
  const rows = await dbRows();
  for (let i = 1; i < rows.length; i++) if (clean(cell(rows[i], C.dbBadgeCol)) === clean(badge)) return { row: i + 1, values: rows[i] };
  return null;
}
async function findRosterByBadge(badge) {
  const rows = await rosterRows();
  for (let i = 1; i < rows.length; i++) if (clean(cell(rows[i], C.rosterBadgeCol)) === clean(badge)) return { row: i + 1, rank: clean(cell(rows[i], C.rosterRankCol)), callsign: clean(cell(rows[i], C.rosterCallsignCol)), values: rows[i] };
  return null;
}
async function findRosterByDiscordId(id) {
  const db = await findDatabaseByDiscordId(id);
  if (!db) return null;
  const badge = clean(cell(db.values, C.dbBadgeCol));
  const roster = await findRosterByBadge(badge);
  return { db, roster, badge };
}
async function findOpenRosterSlot(rank) {
  const rows = await rosterRows();
  for (let i = 1; i < rows.length; i++) {
    const rowRank = clean(cell(rows[i], C.rosterRankCol));
    const callsign = clean(cell(rows[i], C.rosterCallsignCol));
    const badge = clean(cell(rows[i], C.rosterBadgeCol));
    if (rowRank.toLowerCase() !== clean(rank).toLowerCase()) continue;
    if (badge) continue;
    if (!/^1Z-\d{2}$/i.test(callsign)) continue;
    return { row: i + 1, rank: rowRank, callsign };
  }
  for (let i = 1; i < rows.length; i++) {
    const rowRank = clean(cell(rows[i], C.rosterRankCol));
    const callsign = clean(cell(rows[i], C.rosterCallsignCol));
    const badge = clean(cell(rows[i], C.rosterBadgeCol));
    if (rowRank.toLowerCase() !== clean(rank).toLowerCase()) continue;
    if (badge) continue;
    if (!/^2Z-\d{2}$/i.test(callsign)) continue;
    return { row: i + 1, rank: rowRank, callsign };
  }
  for (let i = 1; i < rows.length; i++) {
    const rowRank = clean(cell(rows[i], C.rosterRankCol));
    const callsign = clean(cell(rows[i], C.rosterCallsignCol));
    const badge = clean(cell(rows[i], C.rosterBadgeCol));
    if (rowRank.toLowerCase() !== clean(rank).toLowerCase()) continue;
    if (badge) continue;
    if (!/^3Z-\d{2}$/i.test(callsign)) continue;
    return { row: i + 1, rank: rowRank, callsign };
  }
  for (let i = 1; i < rows.length; i++) {
    const rowRank = clean(cell(rows[i], C.rosterRankCol));
    const callsign = clean(cell(rows[i], C.rosterCallsignCol));
    const badge = clean(cell(rows[i], C.rosterBadgeCol));
    if (rowRank.toLowerCase() !== clean(rank).toLowerCase()) continue;
    if (badge) continue;
    if (!/^4Z-\d{2}$/i.test(callsign)) continue;
    return { row: i + 1, rank: rowRank, callsign };
  }
  for (let i = 1; i < rows.length; i++) {
    const rowRank = clean(cell(rows[i], C.rosterRankCol));
    const callsign = clean(cell(rows[i], C.rosterCallsignCol));
    const badge = clean(cell(rows[i], C.rosterBadgeCol));
    if (rowRank.toLowerCase() !== clean(rank).toLowerCase()) continue;
    if (badge) continue;
    if (!/^5Z-\d{2}$/i.test(callsign)) continue;
    return { row: i + 1, rank: rowRank, callsign };
  }
  for (let i = 1; i < rows.length; i++) {
    const rowRank = clean(cell(rows[i], C.rosterRankCol));
    const callsign = clean(cell(rows[i], C.rosterCallsignCol));
    const badge = clean(cell(rows[i], C.rosterBadgeCol));
    if (rowRank.toLowerCase() !== clean(rank).toLowerCase()) continue;
    if (badge) continue;
    if (!/^6Z-\d{2}$/i.test(callsign)) continue;
    return { row: i + 1, rank: rowRank, callsign };
  }
  for (let i = 1; i < rows.length; i++) {
    const rowRank = clean(cell(rows[i], C.rosterRankCol));
    const callsign = clean(cell(rows[i], C.rosterCallsignCol));
    const badge = clean(cell(rows[i], C.rosterBadgeCol));
    if (rowRank.toLowerCase() !== clean(rank).toLowerCase()) continue;
    if (badge) continue;
    if (!/^8Z-\d{2}$/i.test(callsign)) continue;
    return { row: i + 1, rank: rowRank, callsign };
  }
  
  return null;
}
const RANK_ORDER = [
  "Director",
  "Deputy Director",
  "Assistant Director",
  "Chief Marshal",
  "Deputy Chief Marshal",
  "Chief of Staff",
  "District Chief",
  "District Commander",
  "Division Commander",
  "Watch Commander",
  "Deputy Marshal in Charge",
  "Assistant Deputy Marshal in-Charge",
  "Supervisory Deputy Marshal",
  "Special Deputy Marshal",
  "Senior Deputy Marshal",
  "Deputy Marshal",
  "Probationary Deputy Marshal",
  "MS - Cadet",

];

async function liveRanks(prefix = "") {
  const rows = await rosterRows();
  const seen = new Map();
  const p = clean(prefix).toLowerCase();

  for (let i = 1; i < rows.length; i++) {
    const rank = clean(cell(rows[i], C.rosterRankCol));
    const callsign = clean(cell(rows[i], C.rosterCallsignCol));
    if (!rank || !/^1Z-\d{2}$/i.test(callsign)) continue;

    const key = rank.toLowerCase();
    if (!p || key.includes(p)) seen.set(key, rank);
  }
  for (let i = 1; i < rows.length; i++) {
    const rank = clean(cell(rows[i], C.rosterRankCol));
    const callsign = clean(cell(rows[i], C.rosterCallsignCol));
    if (!rank || !/^2Z-\d{2}$/i.test(callsign)) continue;

    const key = rank.toLowerCase();
    if (!p || key.includes(p)) seen.set(key, rank);
  }
  for (let i = 1; i < rows.length; i++) {
    const rank = clean(cell(rows[i], C.rosterRankCol));
    const callsign = clean(cell(rows[i], C.rosterCallsignCol));
    if (!rank || !/^3Z-\d{2}$/i.test(callsign)) continue;

    const key = rank.toLowerCase();
    if (!p || key.includes(p)) seen.set(key, rank);
  }
  for (let i = 1; i < rows.length; i++) {
    const rank = clean(cell(rows[i], C.rosterRankCol));
    const callsign = clean(cell(rows[i], C.rosterCallsignCol));
    if (!rank || !/^4Z-\d{2}$/i.test(callsign)) continue;

    const key = rank.toLowerCase();
    if (!p || key.includes(p)) seen.set(key, rank);
  }
  for (let i = 1; i < rows.length; i++) {
    const rank = clean(cell(rows[i], C.rosterRankCol));
    const callsign = clean(cell(rows[i], C.rosterCallsignCol));
    if (!rank || !/^5Z-\d{2}$/i.test(callsign)) continue;

    const key = rank.toLowerCase();
    if (!p || key.includes(p)) seen.set(key, rank);
  }
  for (let i = 1; i < rows.length; i++) {
    const rank = clean(cell(rows[i], C.rosterRankCol));
    const callsign = clean(cell(rows[i], C.rosterCallsignCol));
    if (!rank || !/^6Z-\d{2}$/i.test(callsign)) continue;

    const key = rank.toLowerCase();
    if (!p || key.includes(p)) seen.set(key, rank);
  }
  for (let i = 1; i < rows.length; i++) {
    const rank = clean(cell(rows[i], C.rosterRankCol));
    const callsign = clean(cell(rows[i], C.rosterCallsignCol));
    if (!rank || !/^7Z-\d{2}$/i.test(callsign)) continue;

    const key = rank.toLowerCase();
    if (!p || key.includes(p)) seen.set(key, rank);
  }

  const ranked = [...seen.values()];
  ranked.sort((a, b) => {
    const ai = RANK_ORDER.findIndex(x => x.toLowerCase() === a.toLowerCase());
    const bi = RANK_ORDER.findIndex(x => x.toLowerCase() === b.toLowerCase());
    const ar = ai === -1 ? 999 : ai;
    const br = bi === -1 ? 999 : bi;
    if (ar !== br) return ar - br;
    return a.localeCompare(b);
  });

  return ranked;
}
function badgeNumber(value) {
  const s = clean(value).replace(/,/g, "");
  const m = s.match(/\d+/);
  return m ? Number(m[0]) : NaN;
}

async function findHighestAvailableBadge() {
  const rows = await dbRows();
  const available = [];
  for (let i = 1; i < rows.length; i++) {
    const badge = clean(cell(rows[i], C.dbBadgeCol));
    const discordId = clean(cell(rows[i], C.dbDiscordIdCol));
    if (!badge || discordId) continue;
    const n = badgeNumber(badge);
    if (!Number.isNaN(n)) available.push({ row: i + 1, values: rows[i], badge, number: n });
  }
  available.sort((a, b) => b.number - a.number);
  return available[0] || null;
}

function actionEmbed(title, color, description, actor, fields = []) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description || "").addFields(fields).setFooter({ text: `${DEPARTMENT} • ${actor}` }).setTimestamp();
}
async function memberRoleTarget(guild, rank) { return findSimilarRole(guild, rank); }
async function applyRankRole(guild, member, newRank, oldRank = "") {
  const newRole = await memberRoleTarget(guild, newRank);
  if (newRole && !member.roles.cache.has(newRole.id)) await member.roles.add(newRole).catch(() => {});
  if (oldRank && oldRank.toLowerCase() !== newRank.toLowerCase()) {
    const oldRole = await memberRoleTarget(guild, oldRank);
    if (oldRole && member.roles.cache.has(oldRole.id)) await member.roles.remove(oldRole).catch(() => {});
  }
  await applySupportRankRole(guild, member, newRank);
  return newRole;
}
async function removeRankRole(guild, member, rank) {
  const role = await memberRoleTarget(guild, rank);
  if (role && member.roles.cache.has(role.id)) await member.roles.remove(role).catch(() => {});
}
async function setMemberNickname(member, callsign) {
  if (!member?.manageable || !callsign) return;
  const name = member.nickname || member.user?.displayName || "Member";
  const cleanedName = name.includes("|") ? name.split("|").slice(1).join("|").trim() : name;
  await member.setNickname(`${callsign} | ${cleanedName}`.slice(0, 32)).catch(() => {});
}
async function sendDM(member, embed, content = "") { try { await member.send({ content, embeds: [embed] }); return true; } catch { return false; } }
async function configuredChannel(guild, channelId) { if (!channelId) return null; const ch = await guild.channels.fetch(channelId).catch(() => null); return ch?.isTextBased() ? ch : null; }
async function sendAudit(guild, embed) {
  const cfg = guildSettings(guild.id); const ch = await configuredChannel(guild, cfg.auditChannelId); if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
}
async function sendTypedLog(guild, type, embed) {
  const cfg = guildSettings(guild.id); const ch = await configuredChannel(guild, cfg.logChannels[type] || ""); if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
  await sendAudit(guild, embed);
}
function canCommandTeam(interaction) {
  const cfg = guildSettings(interaction.guildId);
  return cfg.logRoleId && interaction.member?.roles?.cache?.has(cfg.logRoleId);
}
function canConfigure(interaction) { return C.owners.has(interaction.user.id) || canCommandTeam(interaction); }
const ownerIds = new Set((process.env.OWNER_IDS || "").split(",").map(s => s.trim()).filter(Boolean));
const C_OWN = { owners: ownerIds }; // backwards compatibility for helper naming
function isOwner(interaction) { return C_OWN.owners.has(interaction.user.id); }

const commands = [
  new SlashCommandBuilder().setName("onboard").setDescription("Onboard a new Marshal.")
    .addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true))
    .addStringOption(o => o.setName("rp_name").setDescription("Roleplay name").setRequired(true))
    .addStringOption(o => o.setName("rank").setDescription("Rank from Personnel Roster column B").setAutocomplete(true).setRequired(true)),
  new SlashCommandBuilder().setName("move").setDescription("Move a Marshal to another rank.")
    .addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true))
    .addStringOption(o => o.setName("rank").setDescription("New rank").setAutocomplete(true).setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("status").setDescription("Set MS status.")
    .addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true))
    .addStringOption(o => o.setName("status").setDescription("Status").setRequired(true).addChoices(...STATUS.map(s => ({name:s,value:s}))))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),
  new SlashCommandBuilder().setName("lookup").setDescription("Lookup a Marshal.").addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true)),
  new SlashCommandBuilder().setName("strike").setDescription("Issue the next available strike.").addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),
  new SlashCommandBuilder().setName("loa").setDescription("Place a Marshal on LOA.").addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),
  new SlashCommandBuilder().setName("clear").setDescription("Clear a record.").addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true)).addStringOption(o => o.setName("kind").setDescription("Record").setRequired(true).addChoices({name:"Strike 1",value:"strike1"},{name:"Strike 2",value:"strike2"},{name:"All Strikes",value:"strikes"},{name:"LOA",value:"loa"})),
  new SlashCommandBuilder().setName("list").setDescription("List active flags.").addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true)),
  new SlashCommandBuilder().setName("terminate").setDescription("Terminate a Marshal.").addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),
  new SlashCommandBuilder().setName("resign").setDescription("Mark a Marshal resigned.").addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true)).addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),
  new SlashCommandBuilder().setName("reinstate").setDescription("Reinstate a Marshal to Active.").addUserOption(o => o.setName("user").setDescription("Discord member").setRequired(true)),
  new SlashCommandBuilder().setName("ranks").setDescription("List valid MS ranks from Personnel Roster in command order."),
  new SlashCommandBuilder().setName("mass").setDescription("Bulk rank movements.")
    .addSubcommand(s => s.setName("promotions").setDescription("Bulk promote members from one rank to another.").addStringOption(o=>o.setName("from_rank").setDescription("Current rank").setAutocomplete(true).setRequired(true)).addStringOption(o=>o.setName("to_rank").setDescription("New rank").setAutocomplete(true).setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(false)))
    .addSubcommand(s => s.setName("demotions").setDescription("Bulk demote members from one rank to another.").addStringOption(o=>o.setName("from_rank").setDescription("Current rank").setAutocomplete(true).setRequired(true)).addStringOption(o=>o.setName("to_rank").setDescription("New rank").setAutocomplete(true).setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(false))),
  new SlashCommandBuilder().setName("command").setDescription("Command-team configuration.")
    .addSubcommandGroup(g => g.setName("role").setDescription("Command-team roles.").addSubcommand(s=>s.setName("log").setDescription("Set the role allowed to create command logs.").addRoleOption(o=>o.setName("role").setDescription("Command team role").setRequired(true))).addSubcommand(s=>s.setName("view").setDescription("View the configured command log role."))),
  new SlashCommandBuilder().setName("logs").setDescription("Logging configuration.")
    .addSubcommand(s=>s.setName("channel").setDescription("Set a log destination.").addStringOption(o=>o.setName("type").setDescription("Log type").setRequired(true).addChoices(...Object.values(LOG_TYPES).map(x=>({name:x.label,value:x.key})),{name:"Audit / General",value:"audit"})).addChannelOption(o=>o.setName("channel").setDescription("Destination channel").setRequired(true)))
    .addSubcommand(s=>s.setName("status").setDescription("Show log configuration.")),
  new SlashCommandBuilder().setName("promotion").setDescription("Promotion configuration.")
    .addSubcommand(s=>s.setName("logs").setDescription("Set the channel where promotion events are posted.").addChannelOption(o=>o.setName("channel").setDescription("Promotion log channel").setRequired(true))),
  new SlashCommandBuilder().setName("removal-logs").setDescription("Create a removal log.").addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)).addStringOption(o=>o.setName("details").setDescription("Additional details").setRequired(false)),
  new SlashCommandBuilder().setName("demotion-logs").setDescription("Create a demotion log.").addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)).addStringOption(o=>o.setName("details").setDescription("Additional details").setRequired(false)),
  new SlashCommandBuilder().setName("transfer-logs").setDescription("Create a transfer log.").addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)).addStringOption(o=>o.setName("details").setDescription("Additional details").setRequired(false)),
  new SlashCommandBuilder().setName("task-logs").setDescription("Create a task log.").addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Task / action").setRequired(true)).addStringOption(o=>o.setName("details").setDescription("Additional details").setRequired(false)),
  new SlashCommandBuilder().setName("inactivity-warning-logs").setDescription("Create an inactivity warning log.").addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)).addStringOption(o=>o.setName("details").setDescription("Additional details").setRequired(false)),
  new SlashCommandBuilder().setName("loa-logs").setDescription("Create a LOA log.").addUserOption(o=>o.setName("user").setDescription("Member").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true)).addStringOption(o=>o.setName("details").setDescription("Additional details").setRequired(false)),
  new SlashCommandBuilder().setName("supervisor-interview-logs").setDescription("Create a supervisor interview log.").addUserOption(o=>o.setName("user").setDescription("Candidate").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Outcome / topic").setRequired(true)).addStringOption(o=>o.setName("details").setDescription("Additional details").setRequired(false)),
  new SlashCommandBuilder().setName("fta-interview-logs").setDescription("Create an FTA interview log.").addUserOption(o=>o.setName("user").setDescription("Candidate").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Outcome / topic").setRequired(true)).addStringOption(o=>o.setName("details").setDescription("Additional details").setRequired(false)),
  new SlashCommandBuilder().setName("training").setDescription("Training logging.").addSubcommand(s=>s.setName("log").setDescription("Log training results and trainers.").addStringOption(o=>o.setName("passed").setDescription("Cadets passed (mentions or IDs, comma separated)").setRequired(false)).addStringOption(o=>o.setName("failed").setDescription("Cadets failed (mentions or IDs, comma separated)").setRequired(false)).addStringOption(o=>o.setName("ftos").setDescription("FTOs who trained/helped (mentions or IDs, comma separated)").setRequired(false)).addStringOption(o=>o.setName("ftas").setDescription("FTAs who trained/helped (mentions or IDs, comma separated)").setRequired(false)).addStringOption(o=>o.setName("details").setDescription("Additional training notes").setRequired(false))),
  new SlashCommandBuilder().setName("host").setDescription("Training hosting.").addSubcommand(s=>s.setName("training").setDescription("Host a cadet / FTO training.").addStringOption(o=>o.setName("time").setDescription("Start time, e.g. 18:30 or 6:30 PM").setRequired(true))),
  new SlashCommandBuilder().setName("fto-set").setDescription("Set the existing role allowed to host training.").addRoleOption(o=>o.setName("role").setDescription("Existing FTO/FTO-equivalent role").setRequired(true))
];

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

function buildLogEmbed(type, target, actor, reason, details) {
  const label = LOG_TYPES[type]?.label || type;
  return actionEmbed(`${label} Log`, COLORS.black, `**${target}**`, actor, [
    { name: "Reason / Outcome", value: safeText(reason), inline: false },
    { name: "Details", value: safeText(details || "No additional details provided."), inline: false },
    { name: "Logged By", value: actor, inline: true },
    { name: "Department", value: DEPARTMENT, inline: true }
  ]);
}

async function handleAdd(i) {
  const member = i.options.getMember("user");
  const rpName = clean(i.options.getString("rp_name", true));
  const rank = clean(i.options.getString("rank", true));

  if (!member) throw new Error("That member is not in this server.");
  if (await findDatabaseByDiscordId(member.id)) {
    throw new Error("That Discord user is already assigned in Personnel Database column I.");
  }

  // Automatically select the highest-numbered available badge whose Discord ID cell is empty.
  const db = await findHighestAvailableBadge();
  if (!db) {
    throw new Error("No available badge numbers were found in Personnel Database column B.");
  }

  const slot = await findOpenRosterSlot(rank);
  if (!slot) {
    throw new Error(`No open ${rank} slot with a valid #-## call-sign exists in Personnel Roster.`);
  }

  const joinDate = today();
  const promotionDate = joinDate;

  await setCells(C.databaseSheet, {
    [`${C.dbRpNameCol}${db.row}`]: rpName,
    [`${C.dbDiscordIdCol}${db.row}`]: member.id,
    [`${C.dbJoinDateCol}${db.row}`]: joinDate,
    [`${C.dbPromotionDateCol}${db.row}`]: promotionDate,
    [`${C.dbStatusCol}${db.row}`]: "Active",
    [`${C.dbTerminationCol}${db.row}`]: false,
    [`${C.dbResignedCol}${db.row}`]: false,
    [`${C.dbLoaCol}${db.row}`]: false,
    [`${C.dbRankLockedCol}${db.row}`]: false
  });

  // Main Personnel Roster gets only the selected badge in the open G cell.
  await setCell(C.rosterSheet, `${C.rosterBadgeCol}${slot.row}`, db.badge);

  await applyRankRole(i.guild, member, rank);
  await setMemberNickname(member, slot.callsign);

  const actor = `<@${i.user.id}>`;
  const embed = actionEmbed(
    "Marshal Onboarded",
    COLORS.green,
    `${member} has been onboarded to the **${DEPARTMENT}**.`,
    actor,
    [
      { name: "RP Name", value: rpName || "—", inline: true },
      { name: "Call Sign", value: slot.callsign || "—", inline: true },
      { name: "Badge", value: db.badge, inline: true },
      { name: "Rank", value: rank, inline: true },
      { name: "Status", value: "Active", inline: true },
      { name: "Join Date", value: joinDate, inline: true }
    ]
  );

  await dm(member, embed);
  await sendAudit(i.guild, embed);

  const promoCh = await configuredChannel(i.guild, guildSettings(i.guildId).promotionChannelId);
  if (promoCh) await promoCh.send({ embeds: [embed] }).catch(() => {});

  await i.editReply({ embeds: [embed] });
}
async function handleMove(i) {
  const member = i.options.getMember("user");
  const newRank = clean(i.options.getString("rank", true));
  const reason = clean(i.options.getString("reason")) || "Rank movement.";
  if (!member) throw new Error("Member not found in this server.");
  const state = await findRosterByDiscordId(member.id);
  if (!state?.db) throw new Error("That member has no Personnel Database record.");
  if (state.roster && isTrue(cell(state.db.values, C.dbRankLockedCol))) throw new Error("That member is rank locked and cannot be moved.");
  const slot = await findOpenRosterSlot(newRank);
  if (!slot) throw new Error(`No open ${newRank} slot with a valid 1Z-## call-sign exists.`);
  const oldRank = state.roster?.rank || "Unknown";
  if (state.roster) await setCell(C.rosterSheet, `${C.rosterBadgeCol}${state.roster.row}`, "");
  await setCell(C.rosterSheet, `${C.rosterBadgeCol}${slot.row}`, state.badge);
  await setCell(C.databaseSheet, `${C.dbPromotionDateCol}${state.db.row}`, today());
  await applyRankRole(i.guild, member, newRank, oldRank);
  await setMemberNickname(member, slot.callsign);
  const actor = `<@${i.user.id}>`;
  const embed = actionEmbed("Marshal Rank Updated", COLORS.green, `${member} has been moved to **${newRank}**.`, actor, [
    {name:"Previous Rank",value:oldRank,inline:true},{name:"New Rank",value:newRank,inline:true},{name:"Call Sign",value:slot.callsign,inline:true},{name:"Badge",value:state.badge||"—",inline:true},{name:"Reason",value:safeText(reason),inline:false}
  ]);
  await sendDM(member, embed);
  await sendAudit(i.guild, embed);
  const promoCh = await configuredChannel(i.guild, guildSettings(i.guildId).promotionChannelId);
  if (promoCh) await promoCh.send({embeds:[embed]}).catch(()=>{});
  await i.editReply({embeds:[embed]});
}

async function handleStatus(i) {
  const member = i.options.getMember("user");
  const state = await findRosterByDiscordId(member.id); if (!state?.db) throw new Error("No Personnel Database record.");
  const status = i.options.getString("status", true); const reason = clean(i.options.getString("reason")) || "Status update."; const actor = `<@${i.user.id}>`;
  await setCell(C.databaseSheet, `${C.dbStatusCol}${state.db.row}`, status);
  if (status === "LOA") await setCell(C.databaseSheet, `${C.dbLoaCol}${state.db.row}`, true);
  const embed = actionEmbed("MS Status Updated", COLORS.blue, `${member} is now **${status}**.`, actor, [{name:"Reason",value:reason}]);
  await sendDM(member, embed); await sendAudit(i.guild, embed); await i.editReply({embeds:[embed]});
}

async function handleStrike(i) {
  const member = i.options.getMember("user"); const reason = i.options.getString("reason", true); const state = await findRosterByDiscordId(member.id); if (!state?.db) throw new Error("No Personnel Database record.");
  const s1 = isTrue(cell(state.db.values, C.dbStrike1Col)); const s2 = isTrue(cell(state.db.values, C.dbStrike2Col));
  if (s1 && s2) throw new Error("Strike 1 and Strike 2 are already active.");
  const target = !s1 ? C.dbStrike1Col : C.dbStrike2Col;
  await setCell(C.databaseSheet, `${target}${state.db.row}`, true);
  const actor = `<@${i.user.id}>`; const embed = actionEmbed("Strike Issued", COLORS.red, `${member} has received **${target === C.dbStrike1Col ? "Strike 1" : "Strike 2"}**.`, actor, [{name:"Reason",value:reason}]);
  await sendDM(member, embed); await sendAudit(i.guild, embed); await i.editReply({embeds:[embed]});
}

async function handleLoa(i) {
  const member = i.options.getMember("user"); const reason = i.options.getString("reason", true); const state = await findRosterByDiscordId(member.id); if (!state?.db) throw new Error("No Personnel Database record.");
  await setCells(C.databaseSheet,{[`$ {C.dbLoaCol}${state.db.row}`]:true}).catch(()=>{});
  await setCells(C.databaseSheet,{[`${C.dbLoaCol}${state.db.row}`]:true,[`${C.dbStatusCol}${state.db.row}`]:"LOA"});
  const actor = `<@${i.user.id}>`; const embed = actionEmbed("LOA Granted", COLORS.gold, `${member} has been placed on **LOA**.`, actor, [{name:"Reason",value:reason}]);
  await sendDM(member, embed); await sendTypedLog(i.guild,"loa",embed); await i.editReply({embeds:[embed]});
}

async function handleClear(i) {
  const member = i.options.getMember("user"); const kind = i.options.getString("kind", true); const state = await findRosterByDiscordId(member.id); if (!state?.db) throw new Error("No Personnel Database record."); const u = {};
  if (kind === "strike1" || kind === "strikes") u[`${C.dbStrike1Col}${state.db.row}`] = false;
  if (kind === "strike2" || kind === "strikes") u[`${C.dbStrike2Col}${state.db.row}`] = false;
  if (kind === "loa") { u[`${C.dbLoaCol}${state.db.row}`] = false; u[`${C.dbStatusCol}${state.db.row}`] = "Active"; }
  await setCells(C.databaseSheet,u); const actor = `<@${i.user.id}>`; const embed = actionEmbed("Records Cleared", COLORS.green, `${member}'s **${kind}** record was cleared.`, actor); await sendAudit(i.guild,embed); await i.editReply({embeds:[embed]});
}

async function handleTerminateResign(i, type) {
  const member = i.options.getMember("user"); const reason = i.options.getString("reason", true); const state = await findRosterByDiscordId(member.id); if (!state?.db) throw new Error("No Personnel Database record."); const status = type === "terminate" ? "Terminated" : "Resigned";
  const u = type === "terminate" ? {[`${C.dbTerminationCol}${state.db.row}`]:true,[`${C.dbStatusCol}${state.db.row}`]:"Terminated"} : {[`${C.dbResignedCol}${state.db.row}`]:true,[`${C.dbStatusCol}${state.db.row}`]:"Resigned"};
  if (state.roster) await setCell(C.rosterSheet,`${C.rosterBadgeCol}${state.roster.row}`,"");
  await setCells(C.databaseSheet,u); await removeRankRole(i.guild,member,state.roster?.rank||"");
  const actor = `<@${i.user.id}>`; const embed = actionEmbed(`Marshal ${status}`, COLORS.red, `${member}`, actor,[{name:"Badge",value:state.badge||"—",inline:true},{name:"Previous Rank",value:state.roster?.rank||"—",inline:true},{name:"Reason",value:reason}]); await sendDM(member,embed); await sendTypedLog(i.guild,"removal",embed); await i.editReply({embeds:[embed]});
}

async function handleReinstate(i) {
  const member = i.options.getMember("user"); const state = await findRosterByDiscordId(member.id); if (!state?.db) throw new Error("No Personnel Database record.");
  await setCells(C.databaseSheet,{[`${C.dbStatusCol}${state.db.row}`]:"Active",[`${C.dbTerminationCol}${state.db.row}`]:false,[`${C.dbResignedCol}${state.db.row}`]:false,[`${C.dbLoaCol}${state.db.row}`]:false});
  const actor = `<@${i.user.id}>`; const embed = actionEmbed("Marshal Reinstated",COLORS.green,`${member} has been returned to **Active**.`,actor); await sendDM(member,embed); await sendAudit(i.guild,embed); await i.editReply({embeds:[embed]});
}

async function handleLookup(i) {
  const member = i.options.getMember("user"); const state = await findRosterByDiscordId(member.id); if (!state?.db) throw new Error("No Personnel Database record."); const v = state.db.values; const actor = `<@${i.user.id}>`;
  const embed = actionEmbed("Marshal Lookup",COLORS.black,`${member}`,actor,[
    {name:"Badge",value:clean(cell(v,C.dbBadgeCol))||"—",inline:true},{name:"Call Sign",value:state.roster?.callsign||"—",inline:true},{name:"Rank",value:state.roster?.rank||"—",inline:true},{name:"Status",value:clean(cell(v,C.dbStatusCol))||"—",inline:true},{name:"Join Date",value:clean(cell(v,C.dbJoinDateCol))||"—",inline:true},{name:"Promotion Date",value:clean(cell(v,C.dbPromotionDateCol))||"—",inline:true},{name:"Strike 1",value:isTrue(cell(v,C.dbStrike1Col))?"ACTIVE":"Clear",inline:true},{name:"Strike 2",value:isTrue(cell(v,C.dbStrike2Col))?"ACTIVE":"Clear",inline:true},{name:"Terminated",value:isTrue(cell(v,C.dbTerminationCol))?"YES":"No",inline:true},{name:"Resigned",value:isTrue(cell(v,C.dbResignedCol))?"YES":"No",inline:true},{name:"LOA",value:isTrue(cell(v,C.dbLoaCol))?"YES":"No",inline:true},{name:"Rank Locked",value:isTrue(cell(v,C.dbRankLockedCol))?"YES":"No",inline:true}
  ]); await i.editReply({embeds:[embed]});
}

async function updateMass(i, fromRank, toRank, reason) {
  if (fromRank.toLowerCase() === toRank.toLowerCase()) throw new Error("The old and new ranks must be different.");
  const rows = await dbRows(); const targets=[];
  for (let idx=1; idx<rows.length; idx++) {
    const did=clean(cell(rows[idx],C.dbDiscordIdCol)); if (!did) continue;
    const st=clean(cell(rows[idx],C.dbStatusCol)); if (["Terminated","Resigned"].includes(st)) continue;
    if (isTrue(cell(rows[idx],C.dbRankLockedCol))) continue;
    const roster=await findRosterByDiscordId(did); if (roster?.roster?.rank?.toLowerCase()===fromRank.toLowerCase()) targets.push({did, state:roster});
  }
  if (!targets.length) return {count:0,skipped:0};
  let done=0, skipped=0;
  for (const t of targets) {
    const slot=await findOpenRosterSlot(toRank); if (!slot) { skipped++; continue; }
    if (t.state.roster) await setCell(C.rosterSheet,`${C.rosterBadgeCol}${t.state.roster.row}`,"");
    await setCell(C.rosterSheet,`${C.rosterBadgeCol}${slot.row}`,t.state.badge); await setCell(C.databaseSheet,`${C.dbPromotionDateCol}${t.state.db.row}`,today());
    const m=await i.guild.members.fetch(t.did).catch(()=>null); if(m){await applyRankRole(i.guild,m,toRank,fromRank);await setMemberNickname(m,slot.callsign);}
    done++;
  }
  const actor=`<@${i.user.id}>`; const embed=actionEmbed(`Mass ${sub === "promotions" ? "Promotion" : "Demotion"}`,COLORS.purple,`Processed **${done}** member(s).`,actor,[{name:"From",value:fromRank,inline:true},{name:"To",value:toRank,inline:true},{name:"Skipped",value:String(skipped),inline:true},{name:"Reason",value:safeText(reason||"No reason provided.")}]); await sendAudit(i.guild,embed); const cfg=guildSettings(i.guildId); if(sub === "promotions"){const ch=await configuredChannel(i.guild,cfg.promotionChannelId); if(ch) await ch.send({embeds:[embed]}).catch(()=>{});} else {await sendTypedLog(i.guild,"demotion",embed);} return {count:done,skipped};
}

function parseTrainingTime(input) {
  const raw=clean(input).toUpperCase();
  const zone=TRAINING_TZ;
  const now=DateTime.now().setZone(zone);
  let dt;
  if (/^\d{1,2}:\d{2}$/.test(raw)) { const [h,m]=raw.split(":").map(Number); dt=now.set({hour:h,minute:m,second:0,millisecond:0}); }
  else { dt=DateTime.fromFormat(raw,["h:mm a","hh:mm a","H:mm"],{zone}); if(!dt.isValid) return null; dt=dt.set({year:now.year,month:now.month,day:now.day,second:0,millisecond:0}); }
  if (dt <= now) dt=dt.plus({days:1});
  return dt;
}
function trainingButtons(id) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`training_attend_cadet:${id}`).setLabel("✅ Attending Training").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`training_decline_cadet:${id}`).setLabel("❌ Not Attending").setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`training_attend_fta:${id}`).setLabel("✅ Attending as FTA").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`training_attend_fto:${id}`).setLabel("👍 Attend as Full FTO").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`training_decline_fto:${id}`).setLabel("❌ Not Attending").setStyle(ButtonStyle.Danger)
    )
  ];
}
async function trainingRoles(guild) { return { cadet:findSimilarRole(guild,ROLE_TARGETS.cadet), fto:findSimilarRole(guild,ROLE_TARGETS.fto), fta:findSimilarRole(guild,ROLE_TARGETS.fta) }; }
async function sendTrainingReminders(record) {
  const guild=client.guilds.cache.get(record.guildId); if(!guild) return; const roles=await trainingRoles(guild);
  const cadetCh=await configuredChannel(guild,CADET_CHANNEL_ID); const ftoCh=await configuredChannel(guild,FTO_CHANNEL_ID);
  const soon=`⚠️ <t:${Math.floor(record.startMs/1000)}:R> — Training is starting in **10 minutes**! Please be ready.`;
  if(cadetCh) await cadetCh.send({content:`${roles.cadet?roles.cadet.toString():"@MS - Cadet"} ${soon}`}).catch(()=>{});
  if(ftoCh) await ftoCh.send({content:`${roles.fto?roles.fto.toString():"@MS - FTO"} ${roles.fta?roles.fta.toString():"@MS - FTA"} ${soon}`}).catch(()=>{});
  const attendees=[...new Set([...record.cadetAttendees||[],...record.ftaAttendees||[],...record.ftoAttendees||[]])];
  for(const id of attendees){const m=await guild.members.fetch(id).catch(()=>null);if(!m)continue;const em=actionEmbed("Training Starting Soon",COLORS.gold,`Your **${DEPARTMENT}** training starts in 10 minutes.`,`<@${record.hostId}>`,[{name:"Start Time",value:`<t:${Math.floor(record.startMs/1000)}:F>`,inline:false},{name:"Reminder",value:"Please be ready and have everything prepared."}]);await sendDM(m,em);}
}
async function scheduleTraining(record) {
  const id=record.id; const key=`reminder:${id}`; if(timers.has(key)) clearTimeout(timers.get(key)); const delay=Math.max(1000,record.startMs-10*60*1000-Date.now()); timers.set(key,setTimeout(async()=>{try{await sendTrainingReminders(record)}finally{timers.delete(key)}},Math.min(delay,2147483647)));
}
async function createTraining(i) {
  if (i.guildId !== TRAINING_GUILD_ID && !isOwner(i)) throw new Error("This training system is configured for the MS Staff Hub server.");
  const cfg=guildSettings(i.guildId); if(!cfg.ftoRoleId && !isOwner(i)) throw new Error("No FTO host role has been configured. Use /fto-set first.");
  if(!isOwner(i) && !i.member?.roles?.cache?.has(cfg.ftoRoleId)) throw new Error("You do not have the configured FTO host role.");
  const dt=parseTrainingTime(i.options.getString("time",true)); if(!dt) throw new Error("Use a time like `18:30` or `6:30 PM`.");
  const guild=i.guild; const roles=await trainingRoles(guild);
  if(!roles.cadet || !roles.fto || !roles.fta) throw new Error("I could not find the existing MS - Cadet, MS - FTO, and MS - FTA roles. No roles were created.");
  const id=`${Date.now()}-${Math.random().toString(36).slice(2,8)}`; const startMs=dt.toMillis(); const host=`<@${i.user.id}>`;
  const cadetCh=await configuredChannel(guild,CADET_CHANNEL_ID); const ftoCh=await configuredChannel(guild,FTO_CHANNEL_ID); if(!cadetCh||!ftoCh) throw new Error("Training channels could not be found.");
  const timeText=`<t:${Math.floor(startMs/1000)}:F> (<t:${Math.floor(startMs/1000)}:R>)`;
  const cadetMsg=`**${roles.cadet}**\n\nI will be hosting a training in ${timeText}\n\nReact with a [✅] if you're attending as a Cadet.\nReact with a [❌] if you're unable to attend this training.\n\nReminder: Please have everything ready in <#${TRAINING_INFO_CHANNEL_ID}>\n\nNote: If caught messing around during this training you will be removed from the training.`;
  const ftoMsg=`**${roles.fto} ${roles.fta}**\n\n${host} will be hosting a training in ${timeText}\n\nReact with a [✅] if you're attending as a FTA.\nReact with a [👍] if you can attend as a Full FTO.\nReact with a [❌] if you're unable to attend this training.\n\nNote: Keep in mind that every FTO must attend at least 2 Cadet trainings a month to stay as FTO!`;
  const em1=actionEmbed("San Andreas State Marshals • Training",COLORS.black,cadetMsg,host,[{name:"Training Start",value:timeText}]);
  const em2=actionEmbed("San Andreas State Marshals • FTO / FTA Training Notice",COLORS.black,ftoMsg,host,[{name:"Training Start",value:timeText}]);
  const m1=await cadetCh.send({content:roles.cadet.toString(),embeds:[em1],components:[trainingButtons(id)[0]]});
  const m2=await ftoCh.send({content:`${roles.fto} ${roles.fta}`,embeds:[em2],components:[trainingButtons(id)[1]]});
  trainings[id]={id,guildId:i.guildId,hostId:i.user.id,startMs,cadetChannelId:CADET_CHANNEL_ID,ftoChannelId:FTO_CHANNEL_ID,cadetMessageId:m1.id,ftoMessageId:m2.id,cadetAttendees:[],ftaAttendees:[],ftoAttendees:[]};
  await saveTrainings(); await scheduleTraining(trainings[id]);
  const embed=actionEmbed("Training Scheduled",COLORS.green,`Training has been scheduled for ${timeText}.`,host,[{name:"Cadet Channel",value:`<#${CADET_CHANNEL_ID}>`,inline:true},{name:"FTO / FTA Channel",value:`<#${FTO_CHANNEL_ID}>`,inline:true},{name:"No Roles Created",value:"Existing MS roles only."}]);
  await sendAudit(guild,embed); await i.editReply({embeds:[embed]});
}

client.on("interactionCreate",async i=>{
  try {
    if(i.isAutocomplete()){
      const name=i.commandName; const focused=i.options.getFocused(true); const value=focused?.value||"";
      if((name==="onboard"||name==="move"||name==="mass") && focused?.name?.includes("rank")){
        const ranks=await liveRanks(value); return i.respond(ranks.slice(0,25).map(r=>({name:r,value:r})));
      }
      return i.respond([]);
    }
    if(i.isButton()){
      const [kind,id]=i.customId.split(":"); if(!kind.startsWith("training_")) return;
      const record=trainings[id]; if(!record) return i.reply({content:"That training is no longer active.",ephemeral:true});
      const bucket=kind.includes("cadet")?"cadetAttendees":kind.includes("fta")?"ftaAttendees":"ftoAttendees";
      const isDecline=kind.includes("decline"); const arr=new Set(record[bucket]||[]); if(isDecline) arr.delete(i.user.id); else arr.add(i.user.id); record[bucket]=[...arr];
      await saveTrainings(); return i.reply({content:isDecline?"❌ You are marked as not attending.":"✅ You are marked as attending.",ephemeral:true});
    }
    if(!i.isChatInputCommand()) return;
    await i.deferReply({ephemeral:true});
    const cmd=i.commandName;
    if(cmd === "host"){ if(i.options.getSubcommand()==="training") return createTraining(i); }
    if(cmd === "fto-set"){
      if(!isOwner(i)&&!canConfigure(i)) throw new Error("Only owners or the configured Command Team can use this command.");
      const role=i.options.getRole("role",true); guildSettings(i.guildId).ftoRoleId=role.id; await saveSettings(); return i.editReply({content:`✅ Training host role set to ${role}.`});
    }
    if(cmd === "command"){
      if(!isOwner(i)) throw new Error("Only bot owners can change Command Team configuration.");
      const group=i.options.getSubcommandGroup(), sub=i.options.getSubcommand(); const cfg=guildSettings(i.guildId);
      if(group==="role"&&sub==="log"){const role=i.options.getRole("role",true);cfg.logRoleId=role.id;await saveSettings();return i.editReply({content:`✅ Command log role set to ${role}.`});}
      if(group==="role"&&sub==="view"){return i.editReply({content:`Command log role: ${cfg.logRoleId?`<@&${cfg.logRoleId}>`:"Not set"}`});}
    }
    if(cmd === "logs"){
      if(!isOwner(i)) throw new Error("Only bot owners can configure log channels.");
      const sub=i.options.getSubcommand(); const cfg=guildSettings(i.guildId);
      if(sub==="status"){const rows=[`Audit: ${cfg.auditChannelId?`<#${cfg.auditChannelId}>`:"Not set"}`,`Command Team: ${cfg.logRoleId?`<@&${cfg.logRoleId}>`:"Not set"}`,`Promotion: ${cfg.promotionChannelId?`<#${cfg.promotionChannelId}>`:"Not set"}`,...Object.values(LOG_TYPES).map(x=>`${x.label}: ${cfg.logChannels[x.key]?`<#${cfg.logChannels[x.key]}>`:"Not set"}`)];return i.editReply({content:rows.join("\n")});}
      const type=i.options.getString("type",true), ch=i.options.getChannel("channel",true); if(type==="audit") cfg.auditChannelId=ch.id; else cfg.logChannels[type]=ch.id; await saveSettings(); return i.editReply({content:`✅ ${type} logs will now go to ${ch}.`});
    }
    if(cmd === "promotion"){
      if(!isOwner(i)) throw new Error("Only bot owners can configure promotion logs."); const ch=i.options.getChannel("channel",true); guildSettings(i.guildId).promotionChannelId=ch.id; await saveSettings(); return i.editReply({content:`✅ Promotions will now be logged to ${ch}.`});
    }

    const logMap={
      "removal-logs":"removal","demotion-logs":"demotion","transfer-logs":"transfer","task-logs":"task","inactivity-warning-logs":"inactivity","loa-logs":"loa","supervisor-interview-logs":"supervisorInterview","fta-interview-logs":"ftaInterview"
    };
    if(logMap[cmd]){
      if(!canCommandTeam(i)&&!isOwner(i)) throw new Error("Only the configured Command Team can create this log.");
      const member=i.options.getMember("user"); const reason=i.options.getString("reason",true), details=i.options.getString("details")||""; if(!member) throw new Error("Member not found."); const actor=`<@${i.user.id}>`; const em=buildLogEmbed(logMap[cmd],member.user?.tag||member.toString(),actor,reason,details); await sendTypedLog(i.guild,logMap[cmd],em); return i.editReply({embeds:[em]});
    }

    if(cmd === "training") {
      if(!canCommandTeam(i)&&!isOwner(i)) throw new Error("Only the configured Command Team can create training logs.");
      if(i.options.getSubcommand() !== "log") throw new Error("Unknown training subcommand.");
      const passed = clean(i.options.getString("passed")||"");
      const failed = clean(i.options.getString("failed")||"");
      const ftos = clean(i.options.getString("ftos")||"");
      const ftas = clean(i.options.getString("ftas")||"");
      const details = clean(i.options.getString("details")||"");
      const actor = `<@${i.user.id}>`;
      const em = actionEmbed("Training Log", COLORS.black, "San Andreas State Marshals • Training Record", actor, [
        {name:"Cadets Passed", value:safeText(passed||"None"), inline:false},
        {name:"Cadets Failed", value:safeText(failed||"None"), inline:false},
        {name:"FTOs Trained By", value:safeText(ftos||"None"), inline:false},
        {name:"FTAs Trained By", value:safeText(ftas||"None"), inline:false},
        {name:"Additional Notes", value:safeText(details||"None"), inline:false}
      ]);
      await sendTypedLog(i.guild,"training",em);
      return i.editReply({embeds:[em]});
    }

    if(!isOwner(i)) throw new Error("Only configured bot owners can use department administration commands.");
    if(cmd === "onboard") return handleAdd(i);
    if(cmd === "move") return handleMove(i);
    if(cmd === "status") return handleStatus(i);
    if(cmd === "lookup") return handleLookup(i);
    if(cmd === "strike") return handleStrike(i);
    if(cmd === "loa") return handleLoa(i);
    if(cmd === "clear") return handleClear(i);
    if(cmd === "terminate") return handleTerminateResign(i,"terminate");
    if(cmd === "resign") return handleTerminateResign(i,"resign");
    if(cmd === "reinstate") return handleReinstate(i);
    if(cmd === "list"){
      const m=i.options.getMember("user"); const s=await findRosterByDiscordId(m.id); if(!s?.db) throw new Error("No Personnel Database record."); const v=s.db.values; const em=actionEmbed("Marshal Records",COLORS.black,`${m}`,`<@${i.user.id}>`,[{name:"Strike 1",value:isTrue(cell(v,C.dbStrike1Col))?"ACTIVE":"Clear",inline:true},{name:"Strike 2",value:isTrue(cell(v,C.dbStrike2Col))?"ACTIVE":"Clear",inline:true},{name:"LOA",value:isTrue(cell(v,C.dbLoaCol))?"ACTIVE":"Clear",inline:true},{name:"Terminated",value:isTrue(cell(v,C.dbTerminationCol))?"YES":"No",inline:true},{name:"Resigned",value:isTrue(cell(v,C.dbResignedCol))?"YES":"No",inline:true},{name:"Rank Locked",value:isTrue(cell(v,C.dbRankLockedCol))?"YES":"No",inline:true}]);return i.editReply({embeds:[em]});
    }
    if(cmd === "ranks"){const rs=await liveRanks();const em=actionEmbed("MS Rank List",COLORS.black,rs.map(r=>`• ${r}`).join("\n")||"No ranks found.",`<@${i.user.id}>`);return i.editReply({embeds:[em]});}
    if(cmd === "mass"){
      const sub=i.options.getSubcommand(); const from=i.options.getString("from_rank",true), to=i.options.getString("to_rank",true), reason=i.options.getString("reason")||"Mass rank movement."; const result=await updateMass(i,from,to,reason); const em=actionEmbed(`Mass ${sub === "promotions" ? "Promotion" : "Demotion"}`,COLORS.purple,`Completed **${result.count}** member(s).`, `<@${i.user.id}>`, [{name:"From",value:from,inline:true},{name:"To",value:to,inline:true},{name:"Skipped",value:String(result.skipped),inline:true}]); await i.editReply({embeds:[em]}); return;
    }
    throw new Error("Unknown command.");
  } catch(e){ console.error(e); await i.editReply({content:`❌ ${e?.message||"Unexpected error."}`,embeds:[]}).catch(()=>{}); }
});

async function registerCommands(){
  const rest=new REST({version:"10"}).setToken(process.env.DISCORD_TOKEN);
  const body=commands.map(c=>c.toJSON());
  await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),{body});
  console.log(`Registered ${body.length} MS department commands.`);
}

client.once("ready",async()=>{
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
  for(const record of Object.values(trainings)) if(record.startMs>Date.now()) await scheduleTraining(record);
});

client.login(process.env.DISCORD_TOKEN);
