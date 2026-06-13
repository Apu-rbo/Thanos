import { logger } from '../utils/logger.js';

// In-memory tracker: guildId -> { userId -> [timestamps] }
const actionTracker = new Map();

// Default thresholds
const DEFAULTS = {
    enabled: false,
    banThreshold: 3,       // bans within window = nuke
    kickThreshold: 5,
    channelDeleteThreshold: 3,
    roleDeleteThreshold: 3,
    webhookCreateThreshold: 3,
    windowMs: 10000,       // 10 seconds
    punishment: 'ban',     // 'ban' | 'kick' | 'strip'
    logChannelId: null,
};

export function getAntiNukeConfig(guildConfig) {
    return { ...DEFAULTS, ...(guildConfig?.antiNuke || {}) };
}

function trackAction(guildId, userId, type) {
    const key = `${guildId}:${userId}:${type}`;
    const now = Date.now();
    if (!actionTracker.has(key)) actionTracker.set(key, []);
    const times = actionTracker.get(key).filter(t => now - t < 15000);
    times.push(now);
    actionTracker.set(key, times);
    return times.length;
}

export async function handleAntiNuke(client, guild, userId, actionType, guildConfig) {
    const cfg = getAntiNukeConfig(guildConfig);
    if (!cfg.enabled) return;

    const thresholdMap = {
        ban:          cfg.banThreshold,
        kick:         cfg.kickThreshold,
        channelDelete: cfg.channelDeleteThreshold,
        roleDelete:   cfg.roleDeleteThreshold,
        webhookCreate: cfg.webhookCreateThreshold,
    };

    const threshold = thresholdMap[actionType];
    if (!threshold) return;

    const count = trackAction(guild.id, userId, actionType);
    if (count < threshold) return;

    // Threshold hit — punish
    logger.warn(`[AntiNuke] Guild ${guild.id}: User ${userId} triggered ${actionType} (${count}x)`);

    try {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return;

        // Don't punish the server owner
        if (userId === guild.ownerId) return;

        // Don't punish bot itself
        if (userId === client.user.id) return;

        const reason = `[AntiNuke] Automated: triggered ${actionType} ${count} times in 15s`;

        if (cfg.punishment === 'ban') {
            await guild.members.ban(userId, { reason });
        } else if (cfg.punishment === 'kick') {
            await member.kick(reason);
        } else if (cfg.punishment === 'strip') {
            const roles = member.roles.cache.filter(r => r.id !== guild.id);
            await member.roles.remove(roles, reason);
        }

        // Clear their tracker
        ['ban', 'kick', 'channelDelete', 'roleDelete', 'webhookCreate'].forEach(t => {
            actionTracker.delete(`${guild.id}:${userId}:${t}`);
        });

        // Log to channel
        if (cfg.logChannelId) {
            const logChannel = guild.channels.cache.get(cfg.logChannelId);
            if (logChannel?.isTextBased()) {
                await logChannel.send({
                    embeds: [{
                        title: '🚨 AntiNuke Action Taken',
                        color: 0xFF0000,
                        fields: [
                            { name: 'User', value: `<@${userId}> (${userId})`, inline: true },
                            { name: 'Trigger', value: `${actionType} × ${count}`, inline: true },
                            { name: 'Punishment', value: cfg.punishment, inline: true },
                        ],
                        timestamp: new Date().toISOString(),
                    }]
                });
            }
        }
    } catch (err) {
        logger.error(`[AntiNuke] Failed to punish ${userId}:`, err);
    }
}
