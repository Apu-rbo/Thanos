import { logger } from '../utils/logger.js';
import { getConfigValue, setConfigValue } from './guildConfig.js';

const CONFIG_KEY = 'stickyMessages';

const DEFAULT_STATE = {
    channels: {}, // channelId -> { content, lastMessageId, messagesSinceRepost, threshold }
};

export async function getStickyConfig(client, guildId) {
    const stored = await getConfigValue(client, guildId, CONFIG_KEY, null);
    return { ...DEFAULT_STATE, ...(stored ?? {}), channels: { ...(stored?.channels ?? {}) } };
}

export async function saveStickyConfig(client, guildId, config) {
    return setConfigValue(client, guildId, CONFIG_KEY, config);
}

/**
 * Create or replace the sticky message for a channel, and post it immediately.
 */
export async function setSticky(client, guildId, channel, content, threshold = 5) {
    const config = await getStickyConfig(client, guildId);

    // Remove old sticky in this channel first, if any
    const existing = config.channels[channel.id];
    if (existing?.lastMessageId) {
        await channel.messages.delete(existing.lastMessageId).catch(() => null);
    }

    const sent = await channel.send({ embeds: [buildStickyEmbed(content)] });

    config.channels[channel.id] = {
        content,
        lastMessageId: sent.id,
        messagesSinceRepost: 0,
        threshold,
    };

    await saveStickyConfig(client, guildId, config);
    return sent;
}

export async function removeSticky(client, guildId, channel) {
    const config = await getStickyConfig(client, guildId);
    const existing = config.channels[channel.id];
    if (!existing) return false;

    if (existing.lastMessageId) {
        await channel.messages.delete(existing.lastMessageId).catch(() => null);
    }

    delete config.channels[channel.id];
    await saveStickyConfig(client, guildId, config);
    return true;
}

export function buildStickyEmbed(content) {
    return {
        description: content,
        color: 0x5865F2,
        footer: { text: '📌 Sticky message' },
    };
}

/**
 * Called on every message. If the channel has a sticky and enough new
 * messages have passed, delete the old sticky and repost it at the bottom.
 */
export async function handleStickyRepost(client, message) {
    if (!message.guild || message.author.bot) return;

    const config = await getStickyConfig(client, message.guild.id);
    const sticky = config.channels[message.channel.id];
    if (!sticky) return;

    sticky.messagesSinceRepost += 1;

    if (sticky.messagesSinceRepost < sticky.threshold) {
        await saveStickyConfig(client, message.guild.id, config);
        return;
    }

    try {
        if (sticky.lastMessageId) {
            await message.channel.messages.delete(sticky.lastMessageId).catch(() => null);
        }

        const sent = await message.channel.send({ embeds: [buildStickyEmbed(sticky.content)] });

        sticky.lastMessageId = sent.id;
        sticky.messagesSinceRepost = 0;
        await saveStickyConfig(client, message.guild.id, config);
    } catch (error) {
        logger.error(`[Sticky] Failed to repost in channel ${message.channel.id}:`, error);
    }
}
