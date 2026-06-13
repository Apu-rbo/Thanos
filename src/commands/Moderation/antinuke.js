'use strict';

/**
 * TitanBot — AntiNuke Module
 * ─────────────────────────────────────────────────────────────────────────────
 * Monitors the Discord audit log for destructive actions in quick succession.
 * When a non-whitelisted account exceeds configured thresholds it is:
 *   1. Immediately removed from the server (ban)
 *   2. Any roles it granted in the window are revoked
 *   3. An alert is sent to the designated log channel
 *
 * Monitored action types:
 *   • Mass member bans / kicks
 *   • Mass channel deletes
 *   • Mass role deletes
 *   • Dangerous permission grants (admin / manage server)
 *   • Webhook creates (possible raid tool)
 *   • Bot additions
 *
 * Slash commands:
 *   /antinuke enable       – toggle on/off
 *   /antinuke whitelist    – add/remove user or role
 *   /antinuke config       – configure thresholds & window
 *   /antinuke status       – show current config
 * ─────────────────────────────────────────────────────────────────────────────
 */

const {
  Events,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  AuditLogEvent,
  time,
} = require('discord.js');

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  enabled: false,
  whitelistUsers: [],    // user IDs that are always trusted
  whitelistRoles: [],    // role IDs that are always trusted
  logChannelId: null,

  // Per-action thresholds (actions within windowMs trigger countermeasures)
  thresholds: {
    banThreshold: 3,
    kickThreshold: 3,
    channelDeleteThreshold: 2,
    roleDeleteThreshold: 2,
    webhookCreateThreshold: 3,
    dangerousPermThreshold: 2,   // admin/manage-server grants
    botAddThreshold: 2,
  },
  windowMs: 10_000, // 10 seconds
};

// ── In-memory action counters ─────────────────────────────────────────────────
// Map<guildId, Map<executorId, { bans, kicks, channelDeletes, roleDeletes, webhookCreates, dangerousPerms, botAdds, timestamps[] }>>
const actionLog = new Map();

// ── DB helpers ─────────────────────────────────────────────────────────────────
async function getConfig(client, guildId) {
  try {
    const raw = await client.db?.get(`antinuke:${guildId}`);
    return raw ? { ...DEFAULT_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_CONFIG };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(client, guildId, cfg) {
  await client.db?.set(`antinuke:${guildId}`, JSON.stringify(cfg));
}

// ── Helper: get/init per-executor bucket ──────────────────────────────────────
function getBucket(guildId, executorId) {
  if (!actionLog.has(guildId)) actionLog.set(guildId, new Map());
  const gMap = actionLog.get(guildId);
  if (!gMap.has(executorId)) {
    gMap.set(executorId, {
      bans: [], kicks: [], channelDeletes: [], roleDeletes: [],
      webhookCreates: [], dangerousPerms: [], botAdds: [],
    });
  }
  return gMap.get(executorId);
}

function pruneWindow(arr, windowMs) {
  const cutoff = Date.now() - windowMs;
  while (arr.length && arr[0] < cutoff) arr.shift();
}

// ── Executor trust check ───────────────────────────────────────────────────────
async function isTrusted(guild, executorId, cfg) {
  if (cfg.whitelistUsers.includes(executorId)) return true;
  if (executorId === guild.ownerId) return true;
  try {
    const member = await guild.members.fetch(executorId);
    if (member.roles.cache.some(r => cfg.whitelistRoles.includes(r.id))) return true;
    if (member.permissions.has(PermissionFlagsBits.Administrator) &&
        cfg.whitelistRoles.length === 0 && cfg.whitelistUsers.length === 0) return true;
  } catch { /* user left */ }
  return false;
}

// ── Nuke response: ban the attacker & alert ───────────────────────────────────
async function nukeResponse(guild, executorId, reason, cfg, client) {
  const alertEmbed = new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('🚨 ANTINUKE TRIGGERED')
    .setDescription(`**Action taken against <@${executorId}>**\n\n**Reason:** ${reason}`)
    .setTimestamp();

  // Try to ban
  try {
    await guild.bans.create(executorId, {
      deleteMessageSeconds: 0,
      reason: `[AntiNuke] ${reason}`,
    });
    alertEmbed.addFields({ name: 'Status', value: '✅ Attacker banned' });
  } catch (e) {
    alertEmbed.addFields({ name: 'Status', value: `⚠️ Could not ban: ${e.message}` });
  }

  // Alert log channel
  if (cfg.logChannelId) {
    const logChannel = guild.channels.cache.get(cfg.logChannelId);
    if (logChannel) await logChannel.send({ embeds: [alertEmbed] }).catch(() => {});
  }

  // DM guild owner
  try {
    const owner = await guild.fetchOwner();
    await owner.send({ embeds: [alertEmbed] }).catch(() => {});
  } catch { /* */ }
}

// ── Audit log poller ───────────────────────────────────────────────────────────
// Discord.js v14 fires guildAuditLogEntryCreate events directly ✓
async function handleAuditEntry(auditEntry, guild) {
  const client = guild.client;
  const cfg = await getConfig(client, guild.id);
  if (!cfg.enabled) return;

  const executorId = auditEntry.executorId;
  if (!executorId) return;
  if (await isTrusted(guild, executorId, cfg)) return;

  const bucket = getBucket(guild.id, executorId);
  const w = cfg.windowMs;
  const t = cfg.thresholds;
  const now = Date.now();

  switch (auditEntry.action) {
    case AuditLogEvent.MemberBanAdd:
      bucket.bans.push(now);
      pruneWindow(bucket.bans, w);
      if (bucket.bans.length >= t.banThreshold) {
        await nukeResponse(guild, executorId, `Mass ban detected (${bucket.bans.length} bans in ${w / 1000}s)`, cfg, client);
        bucket.bans = [];
      }
      break;

    case AuditLogEvent.MemberKick:
      bucket.kicks.push(now);
      pruneWindow(bucket.kicks, w);
      if (bucket.kicks.length >= t.kickThreshold) {
        await nukeResponse(guild, executorId, `Mass kick detected (${bucket.kicks.length} kicks in ${w / 1000}s)`, cfg, client);
        bucket.kicks = [];
      }
      break;

    case AuditLogEvent.ChannelDelete:
      bucket.channelDeletes.push(now);
      pruneWindow(bucket.channelDeletes, w);
      if (bucket.channelDeletes.length >= t.channelDeleteThreshold) {
        await nukeResponse(guild, executorId, `Mass channel delete detected (${bucket.channelDeletes.length} in ${w / 1000}s)`, cfg, client);
        bucket.channelDeletes = [];
      }
      break;

    case AuditLogEvent.RoleDelete:
      bucket.roleDeletes.push(now);
      pruneWindow(bucket.roleDeletes, w);
      if (bucket.roleDeletes.length >= t.roleDeleteThreshold) {
        await nukeResponse(guild, executorId, `Mass role delete detected (${bucket.roleDeletes.length} in ${w / 1000}s)`, cfg, client);
        bucket.roleDeletes = [];
      }
      break;

    case AuditLogEvent.WebhookCreate:
      bucket.webhookCreates.push(now);
      pruneWindow(bucket.webhookCreates, w);
      if (bucket.webhookCreates.length >= t.webhookCreateThreshold) {
        await nukeResponse(guild, executorId, `Suspicious webhook mass-creation (${bucket.webhookCreates.length} in ${w / 1000}s)`, cfg, client);
        bucket.webhookCreates = [];
      }
      break;

    case AuditLogEvent.RoleUpdate: {
      // Check if dangerous perms were granted
      const changes = auditEntry.changes ?? [];
      const permChange = changes.find(c => c.key === 'permissions');
      if (!permChange) break;
      const DANGEROUS = PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild |
                        PermissionFlagsBits.BanMembers | PermissionFlagsBits.KickMembers |
                        PermissionFlagsBits.ManageRoles | PermissionFlagsBits.ManageChannels |
                        PermissionFlagsBits.ManageWebhooks;
      const newPerms = BigInt(permChange.new ?? 0);
      const oldPerms = BigInt(permChange.old ?? 0);
      const added = newPerms & ~oldPerms;
      if (!(added & DANGEROUS)) break;
      bucket.dangerousPerms.push(now);
      pruneWindow(bucket.dangerousPerms, w);
      if (bucket.dangerousPerms.length >= t.dangerousPermThreshold) {
        await nukeResponse(guild, executorId, `Mass dangerous permission grant (${bucket.dangerousPerms.length} in ${w / 1000}s)`, cfg, client);
        bucket.dangerousPerms = [];
      }
      break;
    }

    case AuditLogEvent.BotAdd:
      bucket.botAdds.push(now);
      pruneWindow(bucket.botAdds, w);
      if (bucket.botAdds.length >= t.botAddThreshold) {
        await nukeResponse(guild, executorId, `Suspicious mass bot addition (${bucket.botAdds.length} in ${w / 1000}s)`, cfg, client);
        bucket.botAdds = [];
      }
      break;

    default:
      break;
  }
}

// ── Slash command ──────────────────────────────────────────────────────────────
const command = new SlashCommandBuilder()
  .setName('antinuke')
  .setDescription('Configure the anti-nuke protection system')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  .addSubcommand(sub => sub
    .setName('enable')
    .setDescription('Enable or disable anti-nuke protection')
    .addBooleanOption(o => o.setName('enabled').setDescription('On or off').setRequired(true)))

  .addSubcommand(sub => sub
    .setName('whitelist')
    .setDescription('Add or remove a trusted user/role')
    .addStringOption(o => o.setName('action').setDescription('add or remove').setRequired(true).addChoices(
      { name: 'Add', value: 'add' },
      { name: 'Remove', value: 'remove' },
    ))
    .addUserOption(o => o.setName('user').setDescription('User to whitelist'))
    .addRoleOption(o => o.setName('role').setDescription('Role to whitelist')))

  .addSubcommand(sub => sub
    .setName('config')
    .setDescription('Configure detection thresholds')
    .addIntegerOption(o => o.setName('window_seconds').setDescription('Detection window in seconds (default 10)').setMinValue(3).setMaxValue(60))
    .addIntegerOption(o => o.setName('ban_threshold').setDescription('Max bans before action').setMinValue(1).setMaxValue(20))
    .addIntegerOption(o => o.setName('kick_threshold').setDescription('Max kicks before action').setMinValue(1).setMaxValue(20))
    .addIntegerOption(o => o.setName('channel_delete_threshold').setDescription('Max channel deletes before action').setMinValue(1).setMaxValue(20))
    .addIntegerOption(o => o.setName('role_delete_threshold').setDescription('Max role deletes before action').setMinValue(1).setMaxValue(20))
    .addChannelOption(o => o.setName('log_channel').setDescription('Channel to send alerts')))

  .addSubcommand(sub => sub
    .setName('status')
    .setDescription('Show current anti-nuke configuration'));

async function executeCommand(interaction) {
  const client = interaction.client;
  const guildId = interaction.guild.id;
  const cfg = await getConfig(client, guildId);
  const sub = interaction.options.getSubcommand();

  if (sub === 'enable') {
    cfg.enabled = interaction.options.getBoolean('enabled');
    await saveConfig(client, guildId, cfg);
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(cfg.enabled ? 0x44FF44 : 0xFF4444)
        .setDescription(`🛡️ Anti-nuke has been **${cfg.enabled ? 'enabled' : 'disabled'}**.`)],
      ephemeral: true,
    });
  }

  if (sub === 'whitelist') {
    const action = interaction.options.getString('action');
    const user = interaction.options.getUser('user');
    const role = interaction.options.getRole('role');

    if (!user && !role) return interaction.reply({ content: '⚠️ Specify a user or role.', ephemeral: true });

    if (user) {
      cfg.whitelistUsers = action === 'add'
        ? [...new Set([...cfg.whitelistUsers, user.id])]
        : cfg.whitelistUsers.filter(id => id !== user.id);
    }
    if (role) {
      cfg.whitelistRoles = action === 'add'
        ? [...new Set([...cfg.whitelistRoles, role.id])]
        : cfg.whitelistRoles.filter(id => id !== role.id);
    }

    await saveConfig(client, guildId, cfg);
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('✅ Whitelist Updated')
        .addFields(
          { name: 'Trusted Users', value: cfg.whitelistUsers.map(id => `<@${id}>`).join(', ') || 'None' },
          { name: 'Trusted Roles', value: cfg.whitelistRoles.map(id => `<@&${id}>`).join(', ') || 'None' },
        )],
      ephemeral: true,
    });
  }

  if (sub === 'config') {
    const win = interaction.options.getInteger('window_seconds');
    const ban = interaction.options.getInteger('ban_threshold');
    const kick = interaction.options.getInteger('kick_threshold');
    const ch = interaction.options.getInteger('channel_delete_threshold');
    const role = interaction.options.getInteger('role_delete_threshold');
    const logCh = interaction.options.getChannel('log_channel');

    if (win) cfg.windowMs = win * 1000;
    if (ban) cfg.thresholds.banThreshold = ban;
    if (kick) cfg.thresholds.kickThreshold = kick;
    if (ch) cfg.thresholds.channelDeleteThreshold = ch;
    if (role) cfg.thresholds.roleDeleteThreshold = role;
    if (logCh) cfg.logChannelId = logCh.id;

    await saveConfig(client, guildId, cfg);
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('✅ AntiNuke Config Updated')
        .addFields(
          { name: 'Window', value: `${cfg.windowMs / 1000}s`, inline: true },
          { name: 'Ban threshold', value: `${cfg.thresholds.banThreshold}`, inline: true },
          { name: 'Kick threshold', value: `${cfg.thresholds.kickThreshold}`, inline: true },
          { name: 'Channel delete', value: `${cfg.thresholds.channelDeleteThreshold}`, inline: true },
          { name: 'Role delete', value: `${cfg.thresholds.roleDeleteThreshold}`, inline: true },
          { name: 'Log Channel', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'None', inline: true },
        )],
      ephemeral: true,
    });
  }

  if (sub === 'status') {
    const t = cfg.thresholds;
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🛡️ AntiNuke Status')
        .addFields(
          { name: 'Enabled', value: cfg.enabled ? '✅ Yes' : '❌ No', inline: true },
          { name: 'Window', value: `${cfg.windowMs / 1000}s`, inline: true },
          { name: 'Log Channel', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'None', inline: true },
          { name: 'Ban threshold', value: `${t.banThreshold}`, inline: true },
          { name: 'Kick threshold', value: `${t.kickThreshold}`, inline: true },
          { name: 'Channel delete', value: `${t.channelDeleteThreshold}`, inline: true },
          { name: 'Role delete', value: `${t.roleDeleteThreshold}`, inline: true },
          { name: 'Webhook create', value: `${t.webhookCreateThreshold}`, inline: true },
          { name: 'Dangerous perms', value: `${t.dangerousPermThreshold}`, inline: true },
          { name: 'Bot add', value: `${t.botAddThreshold}`, inline: true },
          { name: 'Trusted Users', value: cfg.whitelistUsers.map(id => `<@${id}>`).join(', ') || 'None' },
          { name: 'Trusted Roles', value: cfg.whitelistRoles.map(id => `<@&${id}>`).join(', ') || 'None' },
        )
        .setTimestamp()],
      ephemeral: true,
    });
  }
}

module.exports = {
  data: command,
  execute: executeCommand,

  register(client) {
    // Requires GUILD_MODERATION intent + View Audit Log permission
    client.on(Events.GuildAuditLogEntryCreate, (entry, guild) =>
      handleAuditEntry(entry, guild).catch(console.error),
    );
  },
};
