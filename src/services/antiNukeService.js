import { logger } from '../utils/logger.js';
import { getConfigValue, setConfigValue } from './guildConfig.js';

const CONFIG_KEY = 'antiNuke';

const DEFAULT_STATE = {
    enabled: false,
    banThreshold: 3,
    kickThreshold: 5,
    channelDeleteThreshold: 3,
    roleDeleteThreshold: 3,
    webhookCreateThreshold: 3,
    windowMs: 15000,       // 15 second detection window
    punishment: 'ban',     // 'ban' | 'kick' | 'strip'
    logChannelId: null,
    whitelistedUserIds: [],
};

// In-memory action tracker: "guildId:userId:actionType" -> [timestamps]
const actionTracker = new Map();

export async function getAntiNukeConfig(client, guildId) {
    const stored = await getConfigValue(client, guildId, CONFIG_KEY, null);
    return { ...DEFAULT_STATE, ...(stored ?? {}) };
}

export async function saveAntiNukeConfig(client, guildId, config) {
    return setConfigValue(client, guildId, CONFIG_KEY, config);
}

function trackAction(guildId, userId, type, windowMs) {
    const key = `${guildId}:${userId}:${type}`;
    const now = Date.now();
    const times = (actionTracker.get(key) ?? []).filter(t => now - t < windowMs);
    times.push(now);
    actionTracker.set(key, times);
    return times.length;
}

function clearUserTracking(guildId, userId) {
    ['ban', 'kick', 'channelDelete', 'roleDelete', 'webhookCreate'].forEach(t => {
        actionTracker.delete(`${guildId}:${userId}:${t}`);
    });
}

const THRESHOLD_MAP = {
    ban:           'banThreshold',
    kick:          'kickThreshold',
    channelDelete: 'channelDeleteThreshold',
    roleDelete:    'roleDeleteThreshold',
    webhookCreate: 'webhookCreateThreshold',
};

/**
 * Call this whenever a tracked moderation-style action happens.
 * Returns whether punishment was triggered.
 */
export async function registerNukeAction(client, guild, executorId, actionType) {
    const config = await getAntiNukeConfig(client, guild.id);
    if (!config.enabled) return { triggered: false };

    const thresholdKey = THRESHOLD_MAP[actionType];
    if (!thresholdKey) return { triggered: false };

    const threshold = config[thresholdKey];
    const count = trackAction(guild.id, executorId, actionType, config.windowMs);
    if (count < threshold) return { triggered: false };

    // Whitelisted, owner, or bot itself — never punish
    if (config.whitelistedUserIds.includes(executorId)) return { triggered: false };
    if (executorId === guild.ownerId) return { triggered: false };
    if (executorId === client.user.id) return { triggered: false };

    logger.warn(`[AntiNuke] Guild ${guild.id}: ${executorId} triggered ${actionType} x${count} — punishing (${config.punishment})`);

    try {
        const member = await guild.members.fetch(executorId).catch(() => null);
        const reason = `[AntiNuke] Automated: ${actionType} triggered ${count} times within ${config.windowMs / 1000}s`;

        if (config.punishment === 'ban') {
            await guild.members.ban(executorId, { reason });
        } else if (config.punishment === 'kick' && member) {
            await member.kick(reason);
        } else if (config.punishment === 'strip' && member) {
            const roles = member.roles.cache.filter(r => r.id !== guild.id && r.editable);
            await member.roles.remove(roles, reason);
        }

        clearUserTracking(guild.id, executorId);

        if (config.logChannelId) {
            const logChannel = guild.channels.cache.get(config.logChannelId);
            if (logChannel?.isTextBased()) {
                await logChannel.send({
                    embeds: [{
                        title: '🚨 AntiNuke Triggered',
                        color: 0xFF0000,
                        fields: [
                            { name: 'User', value: `<@${executorId}> (${executorId})`, inline: true },
                            { name: 'Action', value: `${actionType} × ${count}`, inline: true },
                            { name: 'Punishment', value: config.punishment, inline: true },
                        ],
                        timestamp: new Date().toISOString(),
                    }],
                }).catch(() => null);
            }
        }

        return { triggered: true, punishment: config.punishment, count };
    } catch (err) {
        logger.error(`[AntiNuke] Failed to punish ${executorId}:`, err);
        return { triggered: false, error: err.message };
    }
}
