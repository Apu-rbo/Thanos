import { PermissionFlagsBits } from 'discord.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { logger } from '../utils/logger.js';
import { logModerationAction } from '../utils/moderation.js';

export const SCAM_DEFAULTS = Object.freeze({
    enabled: false,
    hashes: [],           // perceptual hashes of known scam images
    channelThreshold: 3,  // suspicious posts in this many different channels => ban
    windowSeconds: 120,
});

const MAX_HASH_DISTANCE = 8;           // out of 64 bits; lower = stricter
const MAX_HASHES = 50;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const BAN_DELETE_SECONDS = 3600;       // wipe the banned account's last hour of messages in ALL channels
const CONFIG_CACHE_MS = 60_000;
const IMAGE_TYPES = /^image\/(png|jpe?g|webp|gif)$/i;
const URL_REGEX = /https?:\/\/\S+/i;

const configCache = new Map();
const recentSuspicious = new Map();
const inProgress = new Set();

setInterval(() => {
    const now = Date.now();
    for (const [key, entries] of recentSuspicious) {
        const fresh = entries.filter((e) => now - e.at < 10 * 60_000);
        if (fresh.length === 0) recentSuspicious.delete(key);
        else recentSuspicious.set(key, fresh);
    }
}, 5 * 60_000).unref();

// ─── Config ───────────────────────────────────────────────────────────────────

const configKey = (guildId) => `guild:${guildId}:scamguard`;

export async function getScamGuardConfig(client, guildId) {
    const cached = configCache.get(guildId);
    if (cached && Date.now() - cached.at < CONFIG_CACHE_MS) return cached.config;

    let stored = null;
    try {
        stored = await client.db.get(configKey(guildId));
        if (stored?.value && typeof stored.value === 'object' && !Array.isArray(stored.hashes)) {
            stored = stored.value;
        }
    } catch (error) {
        logger.debug(`[ScamGuard] Could not read config for ${guildId}: ${error.message}`);
    }

    const config = { ...SCAM_DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
    if (!Array.isArray(config.hashes)) config.hashes = [];

    configCache.set(guildId, { config, at: Date.now() });
    return config;
}

export async function saveScamGuardConfig(client, guildId, config) {
    await client.db.set(configKey(guildId), config);
    configCache.set(guildId, { config, at: Date.now() });
    return config;
}

export { MAX_HASHES };

// ─── Image hashing (difference hash, 64-bit) ──────────────────────────────────

export async function hashImageBuffer(buffer) {
    const image = await loadImage(buffer);

    const mid = createCanvas(64, 64);
    const midCtx = mid.getContext('2d');
    midCtx.fillStyle = '#ffffff';
    midCtx.fillRect(0, 0, 64, 64);
    midCtx.imageSmoothingEnabled = true;
    midCtx.imageSmoothingQuality = 'high';
    midCtx.drawImage(image, 0, 0, 64, 64);

    const small = createCanvas(9, 8);
    const ctx = small.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 9, 8);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(mid, 0, 0, 9, 8);

    const { data } = ctx.getImageData(0, 0, 9, 8);
    const gray = [];
    for (let i = 0; i < data.length; i += 4) {
        gray.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }

    let bits = '';
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            bits += gray[y * 9 + x] > gray[y * 9 + x + 1] ? '1' : '0';
        }
    }

    let hex = '';
    for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
}

export function hammingDistance(a, b) {
    let distance = 0;
    for (let i = 0; i < a.length; i++) {
        let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
        while (x) {
            distance += x & 1;
            x >>= 1;
        }
    }
    return distance;
}

export function matchesKnownHash(hash, hashes, maxDistance = MAX_HASH_DISTANCE) {
    return hashes.some((known) => known.length === hash.length && hammingDistance(known, hash) <= maxDistance);
}

async function downloadImage(url, size) {
    if (size && size > MAX_IMAGE_BYTES) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) return null;
        const buffer = Buffer.from(await response.arrayBuffer());
        return buffer.length > MAX_IMAGE_BYTES ? null : buffer;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export async function hashAttachment(attachment) {
    if (!attachment.contentType || !IMAGE_TYPES.test(attachment.contentType)) return null;
    const buffer = await downloadImage(attachment.url, attachment.size);
    if (!buffer) return null;
    try {
        return await hashImageBuffer(buffer);
    } catch (error) {
        logger.debug(`[ScamGuard] Could not hash image: ${error.message}`);
        return null;
    }
}

// ─── Detection ────────────────────────────────────────────────────────────────

function isStaff(member) {
    if (!member) return false;
    return member.permissions.any([
        PermissionFlagsBits.Administrator,
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.BanMembers,
    ]);
}

function isScamPatternPost(message) {
    const content = message.content || '';
    const pingsEveryone = message.mentions.everyone || /@(everyone|here)/i.test(content);
    return pingsEveryone || URL_REGEX.test(content);
}

async function punish(message, client, reason) {
    const { guild, author } = message;
    const lockKey = `${guild.id}:${author.id}`;

    if (inProgress.has(lockKey)) {
        await message.delete().catch(() => {});
        return;
    }
    inProgress.add(lockKey);
    setTimeout(() => inProgress.delete(lockKey), 30_000).unref();

    const fullReason = `Scam Guard: ${reason}`;

    try {
        await message.delete().catch(() => {});

        const member = message.member ?? (await guild.members.fetch(author.id).catch(() => null));

        if (member && !member.bannable) {
            if (member.moderatable) {
                await member.timeout(7 * 24 * 60 * 60 * 1000, fullReason).catch(() => {});
            }
            await logModerationAction({
                client,
                guild,
                event: {
                    action: 'Scam Guard: Ban Failed (timed out instead)',
                    target: `${author.tag} (${author.id})`,
                    executor: `${client.user.tag} (${client.user.id})`,
                    reason: `${fullReason} — account is above my role, so I could not ban it`,
                    metadata: { userId: author.id, automatic: true },
                },
            });
            logger.warn(`[ScamGuard] Could not ban ${author.tag} in ${guild.name} (role hierarchy)`);
            return;
        }

        await guild.members.ban(author.id, { reason: fullReason, deleteMessageSeconds: BAN_DELETE_SECONDS });

        await logModerationAction({
            client,
            guild,
            event: {
                action: 'Scam Guard: Auto-Ban',
                target: `${author.tag} (${author.id})`,
                executor: `${client.user.tag} (${client.user.id})`,
                reason: fullReason,
                metadata: { userId: author.id, automatic: true, deletedLastSeconds: BAN_DELETE_SECONDS },
            },
        });

        logger.warn(`[ScamGuard] Banned ${author.tag} (${author.id}) in ${guild.name}: ${reason}`);
    } catch (error) {
        logger.error(`[ScamGuard] Failed to punish ${author.tag} in ${guild.name}:`, error);
    }
}

/**
 * Call from messageCreate. Returns true if the message was handled as a scam.
 * Never throws.
 */
export async function handleScamGuard(message, client) {
    try {
        const { guild, author } = message;
        const config = await getScamGuardConfig(client, guild.id);
        if (!config.enabled) return false;

        const member = message.member;
        if (author.id === guild.ownerId) return false;

        const images = [...message.attachments.values()].filter(
            (a) => a.contentType && IMAGE_TYPES.test(a.contentType),
        );
        if (images.length === 0) return false;

        // Rule A: image matches a known scam image
        if (config.hashes.length > 0) {
            for (const attachment of images.slice(0, 4)) {
                const hash = await hashAttachment(attachment);
                if (hash && matchesKnownHash(hash, config.hashes)) {
                    await punish(message, client, 'Posted a known scam image');
                    return true;
                }
            }
        }

        // Rule B: image + link/@everyone spread across several channels quickly
        if (!isStaff(member) && isScamPatternPost(message)) {
            const key = `${guild.id}:${author.id}`;
            const now = Date.now();
            const windowMs = config.windowSeconds * 1000;

            const entries = (recentSuspicious.get(key) || []).filter((e) => now - e.at < windowMs);
            entries.push({ channelId: message.channelId, at: now });
            recentSuspicious.set(key, entries);

            const distinctChannels = new Set(entries.map((e) => e.channelId)).size;
            if (distinctChannels >= config.channelThreshold) {
                recentSuspicious.delete(key);
                await punish(
                    message,
                    client,
                    `Posted image + link/ping in ${distinctChannels} channels within ${config.windowSeconds}s`,
                );
                return true;
            }
        }

        return false;
    } catch (error) {
        logger.error('[ScamGuard] Error while checking message:', error);
        return false;
    }
}
