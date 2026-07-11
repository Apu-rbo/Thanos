import { logger } from '../utils/logger.js';
import { getConfigValue, setConfigValue } from './guildConfig.js';

const CONFIG_KEY = 'antiSpam';

const DEFAULT_STATE = {
    enabled: false,
    maxMessages: 5,
    windowMs: 5000,
    punishment: 'timeout',     // 'timeout' | 'kick' | 'ban'
    timeoutDurationMs: 300000, // 5 minutes
    deleteTriggerMessages: true,
    warnFirst: true,
    violationsBeforeBan: 3,
    logChannelId: null,
    ignoredRoleIds: [],
    ignoredChannelIds: [],
};

// In-memory: "guildId:userId" -> { messages: [ts], warned: bool, violations: number }
const spamTracker = new Map();

export async function getAntiSpamConfig(client, guildId) {
    const stored = await getConfigValue(client, guildId, CONFIG_KEY, null);
    return { ...DEFAULT_STATE, ...(stored ?? {}) };
}

export async function saveAntiSpamConfig(client, guildId, config) {
    return setConfigValue(client, guildId, CONFIG_KEY, config);
}

async function logAction(guild, config, author, punishment, violations) {
    if (!config.logChannelId) return;
    const logChannel = guild.channels.cache.get(config.logChannelId);
    if (!logChannel?.isTextBased()) return;
    await logChannel.send({
        embeds: [{
            title: '🛡️ AntiSpam Action',
            color: 0xFFA500,
            fields: [
                { name: 'User', value: `${author.tag} (${author.id})`, inline: true },
                { name: 'Punishment', value: punishment, inline: true },
                { name: 'Total Violations', value: `${violations}`, inline: true },
            ],
            timestamp: new Date().toISOString(),
        }],
    }).catch(() => null);
}

/**
 * Call this on every message. Returns true if spam action was taken.
 */
export async function handleAntiSpam(client, message) {
    if (!message.guild || message.author.bot) return false;

    const config = await getAntiSpamConfig(client, message.guild.id);
    if (!config.enabled) return false;

    const { guild, author, member, channel } = message;

    if (config.ignoredChannelIds.includes(channel.id)) return false;
    if (config.ignoredRoleIds.some(id => member?.roles.cache.has(id))) return false;
    if (member?.permissions.has('Administrator')) return false;
    if (member?.permissions.has('ManageMessages')) return false;

    const key = `${guild.id}:${author.id}`;
    const now = Date.now();

    if (!spamTracker.has(key)) spamTracker.set(key, { messages: [], warned: false, violations: 0 });
    const data = spamTracker.get(key);

    data.messages = data.messages.filter(t => now - t < config.windowMs);
    data.messages.push(now);

    if (data.messages.length < config.maxMessages) return false;

    // Spam threshold hit
    logger.warn(`[AntiSpam] Guild ${guild.id}: ${author.tag} spammed (${data.messages.length} msgs/${config.windowMs}ms)`);
    data.violations++;
    data.messages = [];

    if (config.deleteTriggerMessages) {
        const recent = await channel.messages.fetch({ limit: 10 }).catch(() => null);
        if (recent) {
            const toDelete = recent.filter(m => m.author.id === author.id);
            if (toDelete.size > 1) await channel.bulkDelete(toDelete, true).catch(() => null);
        }
    }

    if (config.warnFirst && !data.warned) {
        data.warned = true;
        const warning = await channel.send(`⚠️ <@${author.id}> Please slow down — further spam will result in a punishment.`).catch(() => null);
        if (warning) setTimeout(() => warning.delete().catch(() => null), 6000);
        return true;
    }

    if (data.violations >= config.violationsBeforeBan) {
        try {
            await guild.members.ban(author.id, { reason: `[AntiSpam] Repeated spamming (${data.violations} violations)` });
            spamTracker.delete(key);
            await logAction(guild, config, author, 'ban (max violations)', data.violations);
            return true;
        } catch (err) {
            logger.error(`[AntiSpam] Failed to ban ${author.id}:`, err);
        }
    }

    try {
        if (config.punishment === 'timeout' && member) {
            await member.timeout(config.timeoutDurationMs, '[AntiSpam] Automated: spam detected');
            await logAction(guild, config, author, `timeout (${config.timeoutDurationMs / 60000}m)`, data.violations);
        } else if (config.punishment === 'kick' && member) {
            await member.kick('[AntiSpam] Automated: spam detected');
            await logAction(guild, config, author, 'kick', data.violations);
        } else if (config.punishment === 'ban') {
            await guild.members.ban(author.id, { reason: '[AntiSpam] Automated: spam detected' });
            spamTracker.delete(key);
            await logAction(guild, config, author, 'ban', data.violations);
        }
    } catch (err) {
        logger.error(`[AntiSpam] Failed to punish ${author.id}:`, err);
    }

    return true;
}
