import { PermissionFlagsBits } from 'discord.js';
import { logger } from '../utils/logger.js';

const MAX_LOOKBACK_HOURS = 336; // Discord can only bulk-delete messages younger than 14 days
const CHANNEL_CONCURRENCY = 3;

/**
 * Scans one channel (newest -> oldest) and deletes the given user's messages.
 * @returns {Promise<number>} number of messages deleted
 */
export async function purgeChannel(channel, userId, { cutoff, scanLimit = 500, maxDelete = Infinity }) {
    const collected = [];
    let before;
    let scanned = 0;
    let reachedCutoff = false;

    while (scanned < scanLimit && collected.length < maxDelete && !reachedCutoff) {
        const batch = await channel.messages.fetch(before ? { limit: 100, before } : { limit: 100 });
        if (batch.size === 0) break;

        for (const message of batch.values()) {
            scanned++;
            if (message.createdTimestamp < cutoff) {
                reachedCutoff = true;
                break;
            }
            if (message.author.id === userId) {
                collected.push(message);
                if (collected.length >= maxDelete) break;
            }
        }

        if (batch.size < 100) break;
        before = batch.last().id;
    }

    let deleted = 0;
    for (let i = 0; i < collected.length; i += 100) {
        const chunk = collected.slice(i, i + 100);
        if (chunk.length === 1) {
            await chunk[0].delete().then(() => { deleted += 1; }).catch(() => {});
        } else {
            const result = await channel.bulkDelete(chunk, true).catch(() => null);
            deleted += result?.size ?? 0;
        }
    }

    return deleted;
}

async function runWithConcurrency(items, limit, worker) {
    let index = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) {
            const item = items[index++];
            await worker(item);
        }
    });
    await Promise.all(runners);
}

/**
 * Deletes a user's recent messages from every channel (text, voice-chat, announcement,
 * and active threads) the bot can see in the guild.
 */
export async function purgeUserAcrossGuild(guild, userId, { hours = 24, scanLimit = 500 } = {}) {
    const lookbackHours = Math.min(Math.max(hours, 1), MAX_LOOKBACK_HOURS);
    const cutoff = Date.now() - lookbackHours * 60 * 60 * 1000;
    const me = guild.members.me;

    const channels = [...guild.channels.cache.values()].filter((c) => c.isTextBased?.() && !c.isDMBased?.());

    try {
        const { threads } = await guild.channels.fetchActiveThreads();
        channels.push(...threads.values());
    } catch (error) {
        logger.debug(`[Purge] Could not fetch active threads for ${guild.id}: ${error.message}`);
    }

    const result = {
        deleted: 0,
        channelsScanned: 0,
        channelsTouched: 0,
        skipped: [],
        failed: [],
        lookbackHours,
    };

    const required = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
    ];

    await runWithConcurrency(channels, CHANNEL_CONCURRENCY, async (channel) => {
        const permissions = channel.permissionsFor(me);
        if (!permissions || !permissions.has(required)) {
            result.skipped.push(channel.name);
            return;
        }

        try {
            result.channelsScanned += 1;
            const deleted = await purgeChannel(channel, userId, { cutoff, scanLimit });
            if (deleted > 0) {
                result.deleted += deleted;
                result.channelsTouched += 1;
            }
        } catch (error) {
            logger.warn(`[Purge] Failed scanning #${channel.name} (${channel.id}): ${error.message}`);
            result.failed.push(channel.name);
        }
    });

    return result;
}
