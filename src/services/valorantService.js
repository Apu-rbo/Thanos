import { logger } from '../utils/logger.js';
import { createError, ErrorTypes } from '../utils/errorHandler.js';
import { EmbedBuilder } from 'discord.js';

const HENRIKDEV_BASE = 'https://api.henrikdev.xyz';
const MAX_TRACKED_PER_GUILD = 15;
const CHECK_DELAY_MS = 1500; // spacing between API calls during a sweep to stay under free-tier rate limits

const VALID_REGIONS = ['eu', 'na', 'ap', 'kr', 'latam', 'br'];

const TIER_COLORS = {
    default: 0x5865F2,
    up: 0x57F287,
    down: 0xED4245,
};

// Rank tier -> Discord role name. The role must already exist in the server;
// this maps a HenrikDev tier string (e.g. "Gold 2") down to its base tier.
const RANK_TO_ROLE = {
    iron: 'Iron',
    bronze: 'Bronze',
    silver: 'Silver',
    gold: 'Gold',
    platinum: 'Platinum',
    diamond: 'Diamond',
    ascendant: 'Ascendant',
    immortal: 'Immortal',
    radiant: 'Radiant',
    unranked: 'Unranked',
};

const ALL_RANK_ROLE_NAMES = Object.values(RANK_TO_ROLE);

function henrikHeaders() {
    const headers = { Accept: 'application/json' };
    if (process.env.HENRIK_API_KEY) {
    headers.Authorization = process.env.HENRIK_API_KEY;
}
    return headers;
}

async function henrikFetch(path) {
    const url = `${HENRIKDEV_BASE}${path}`;
    let response;
    try {
        response = await fetch(url, { headers: henrikHeaders() });
    } catch (networkError) {
        throw createError(
            `Network error calling HenrikDev API: ${networkError.message}`,
            ErrorTypes.EXTERNAL_API ?? ErrorTypes.DATABASE,
            'Could not reach the Valorant stats service. Please try again shortly.',
            { url, originalError: networkError.message }
        );
    }

    if (response.status === 404) {
        return null;
    }

    if (response.status === 429) {
        throw createError(
            'HenrikDev API rate limited',
            ErrorTypes.EXTERNAL_API ?? ErrorTypes.DATABASE,
            'The Valorant stats service is rate limiting us right now. Please try again in a minute.',
            { url }
        );
    }

    if (!response.ok) {
        throw createError(
            `HenrikDev API returned ${response.status}`,
            ErrorTypes.EXTERNAL_API ?? ErrorTypes.DATABASE,
            'The Valorant stats service returned an unexpected error. Please try again shortly.',
            { url, status: response.status }
        );
    }

    return response.json();
}

/**
 * Parse a "Name#Tag" string into its parts.
 * @param {string} input
 * @returns {{ name: string, tag: string } | null}
 */
export function parseRiotId(input) {
    if (!input || typeof input !== 'string') return null;
    const match = input.trim().match(/^(.{1,16})#([a-zA-Z0-9]{2,5})$/);
    if (!match) return null;
    return { name: match[1].trim(), tag: match[2].trim() };
}

function riotKey(name, tag) {
    return `${name}#${tag}`.toLowerCase().replace(/[^a-z0-9#]/g, '_');
}

function validateGuildId(guildId) {
    if (!guildId || typeof guildId !== 'string' || !/^\d{17,19}$/.test(guildId)) {
        throw createError(
            `Invalid guild ID: ${guildId}`,
            ErrorTypes.VALIDATION,
            'Invalid server ID provided.',
            { guildId }
        );
    }
}

export function isValidRegion(region) {
    return VALID_REGIONS.includes(region);
}

function getTierKey(tierName) {
    if (!tierName) return 'unranked';
    return tierName.split(' ')[0].toLowerCase(); // "Gold 2" -> "gold"
}

// ─── Log Channel Config ────────────────────────────────────────────────────

export async function setLogChannel(client, guildId, channelId) {
    validateGuildId(guildId);
    const key = `valorant_channel:${guildId}`;
    await client.db.set(key, { channelId, setAt: new Date().toISOString() });
    logger.info(`Set Valorant rank tracker channel to ${channelId} in guild ${guildId}`);
}

export async function getLogChannel(client, guildId) {
    validateGuildId(guildId);
    const key = `valorant_channel:${guildId}`;
    const data = await client.db.get(key).catch(() => null);
    return data?.channelId ?? null;
}

// ─── Tracked Accounts (persistent) ─────────────────────────────────────────

async function listGuildKeys(client, prefix) {
    let keys = await client.db.list(prefix).catch(() => null);
    if (keys && typeof keys === 'object' && !Array.isArray(keys) && keys.value) {
        keys = keys.value;
    }
    if (!Array.isArray(keys)) return [];
    return keys;
}

export async function getTrackedAccounts(client, guildId) {
    validateGuildId(guildId);
    const prefix = `valorant_tracked:${guildId}:`;
    const keys = await listGuildKeys(client, prefix);

    const accounts = [];
    for (const key of keys) {
        try {
            const raw = await client.db.get(key);
            const data = raw?.value ?? raw;
            if (data && data.riotName && data.riotTag) {
                accounts.push(data);
            }
        } catch (error) {
            logger.warn(`Error reading tracked Valorant account for key ${key}:`, error.message);
        }
    }
    return accounts;
}

/**
 * Validate a Riot ID exists via the HenrikDev account endpoint.
 * @returns {Promise<{puuid: string} | null>}
 */
async function verifyRiotAccountExists(name, tag) {
    const data = await henrikFetch(`/valorant/v1/account/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
    if (!data || !data.data) return null;
    return { puuid: data.data.puuid };
}

/**
 * Track a Valorant account for rank/match updates, optionally linked to a Discord
 * member for automatic rank-role assignment.
 * @param {Object} options
 * @param {string} [options.linkedDiscordId] - Discord user ID to receive rank roles
 * @param {boolean} [options.autoRole=true] - Whether to auto-assign a rank role
 */
export async function trackAccount(client, guildId, name, tag, region, addedByUserId, addedByTag, options = {}) {
    validateGuildId(guildId);

    if (!isValidRegion(region)) {
        throw createError(
            `Invalid region: ${region}`,
            ErrorTypes.VALIDATION,
            `Region must be one of: ${VALID_REGIONS.join(', ')}.`,
            { region }
        );
    }

    const key = `valorant_tracked:${guildId}:${riotKey(name, tag)}`;
    const existing = await client.db.get(key).catch(() => null);
    if (existing) {
        throw createError(
            `Account already tracked: ${name}#${tag}`,
            ErrorTypes.VALIDATION,
            `**${name}#${tag}** is already being tracked in this server.`,
            { name, tag }
        );
    }

    const existingAccounts = await getTrackedAccounts(client, guildId);
    if (existingAccounts.length >= MAX_TRACKED_PER_GUILD) {
        throw createError(
            'Tracked account limit reached',
            ErrorTypes.VALIDATION,
            `This server has reached the maximum of ${MAX_TRACKED_PER_GUILD} tracked Valorant accounts. Untrack one first.`,
            { limit: MAX_TRACKED_PER_GUILD }
        );
    }

    const account = await verifyRiotAccountExists(name, tag);
    if (!account) {
        throw createError(
            `Riot ID not found: ${name}#${tag}`,
            ErrorTypes.VALIDATION,
            `Could not find a Valorant account for **${name}#${tag}**. Double-check the spelling and tag.`,
            { name, tag }
        );
    }

    const record = {
        guildId,
        riotName: name,
        riotTag: tag,
        region,
        puuid: account.puuid,
        addedByUserId,
        addedByTag,
        addedAt: new Date().toISOString(),
        linkedDiscordId: options.linkedDiscordId ?? addedByUserId,
        autoRole: options.autoRole !== false,
        lastTierId: null,
        lastTierName: null,
        lastRR: null,
        lastMatchId: null,
        lastRoleAssigned: null,
    };

    await client.db.set(key, record);
    logger.info(`Now tracking Valorant account ${name}#${tag} (${region}) in guild ${guildId}, added by ${addedByTag}`);
    return record;
}

export async function untrackAccount(client, guildId, name, tag) {
    validateGuildId(guildId);
    const key = `valorant_tracked:${guildId}:${riotKey(name, tag)}`;
    const existing = await client.db.get(key).catch(() => null);
    if (!existing) {
        throw createError(
            `Account not tracked: ${name}#${tag}`,
            ErrorTypes.VALIDATION,
            `**${name}#${tag}** isn't currently being tracked in this server.`,
            { name, tag }
        );
    }
    await client.db.delete(key);
    logger.info(`Stopped tracking Valorant account ${name}#${tag} in guild ${guildId}`);
    return true;
}

/**
 * Update settings (linked member and/or auto-role toggle) for an already-tracked account.
 */
export async function updateAccountSettings(client, guildId, name, tag, updates = {}) {
    validateGuildId(guildId);
    const key = `valorant_tracked:${guildId}:${riotKey(name, tag)}`;
    const existing = await client.db.get(key).catch(() => null);
    const data = existing?.value ?? existing;
    if (!data) {
        throw createError(
            `Account not tracked: ${name}#${tag}`,
            ErrorTypes.VALIDATION,
            `**${name}#${tag}** isn't currently being tracked in this server.`,
            { name, tag }
        );
    }

    if (updates.linkedDiscordId !== undefined) data.linkedDiscordId = updates.linkedDiscordId;
    if (updates.autoRole !== undefined) data.autoRole = updates.autoRole;

    await client.db.set(key, data);
    logger.info(`Updated settings for tracked Valorant account ${name}#${tag} in guild ${guildId}`);
    return data;
}

// ─── Rank Role Assignment ───────────────────────────────────────────────────

/**
 * Assign the Discord role matching a Valorant rank tier to a member, removing
 * any other rank role they currently hold. The role must already exist in the
 * server (matched by name, case-insensitive) — this does not create roles.
 */
export async function assignRankRole(guild, member, tierName) {
    try {
        const tierKey = getTierKey(tierName);
        const roleName = RANK_TO_ROLE[tierKey] ?? 'Unranked';

        const targetRole = guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
        if (!targetRole) {
            return { success: false, reason: `Role "${roleName}" not found in server.` };
        }

        if (targetRole.position >= guild.members.me.roles.highest.position) {
            return { success: false, reason: `My role is below "${roleName}" in the role hierarchy.` };
        }

        const toRemove = member.roles.cache.filter(
            r => ALL_RANK_ROLE_NAMES.some(name => name.toLowerCase() === r.name.toLowerCase()) && r.id !== targetRole.id
        );
        if (toRemove.size > 0) {
            await member.roles.remove(toRemove, '[ValRank] Rank role update');
        }

        if (!member.roles.cache.has(targetRole.id)) {
            await member.roles.add(targetRole, '[ValRank] Rank role update');
        }

        return { success: true, roleName, roleId: targetRole.id };
    } catch (error) {
        logger.error(`[ValRank] Failed to assign role to ${member.id}:`, error.message);
        return { success: false, reason: error.message };
    }
}

// ─── HenrikDev Data Fetching ───────────────────────────────────────────────

async function fetchCurrentMMR(name, tag, region) {
    const data = await henrikFetch(`/valorant/v2/mmr/${region}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`);
    const current = data?.data?.current_data;
    if (!current) return null;
    return {
        tierId: current.currenttier ?? null,
        tierName: current.currenttierpatched ?? 'Unranked',
        tierImage: current.images?.small ?? null,
        rr: current.ranking_in_tier ?? 0,
        lastGameDelta: current.mmr_change_to_last_game ?? 0,
    };
}

async function fetchLatestMatch(name, tag, region, puuid) {
    const data = await henrikFetch(`/valorant/v3/matches/${region}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}?size=1`);
    const match = data?.data?.[0];
    if (!match) return null;

    const matchId = match.metadata?.matchid ?? null;
    const map = match.metadata?.map ?? 'Unknown Map';
    const mode = match.metadata?.mode ?? 'Unknown Mode';

    const allPlayers = match.players?.all_players ?? [];
    const self = allPlayers.find(p => p.puuid === puuid) ?? null;

    let result = 'Unknown';
    let kills = null, deaths = null, assists = null;

    if (self) {
        kills = self.stats?.kills ?? null;
        deaths = self.stats?.deaths ?? null;
        assists = self.stats?.assists ?? null;

        const teamKey = self.team?.toLowerCase();
        const teamData = teamKey ? match.teams?.[teamKey] : null;
        if (teamData) {
            result = teamData.has_won ? 'Victory' : 'Defeat';
        }
    }

    return { matchId, map, mode, result, kills, deaths, assists };
}

// ─── Embeds ─────────────────────────────────────────────────────────────────

function buildUpdateEmbed({ riotName, riotTag, mmr, match, tierChanged, tierDirection, roleResult }) {
    const embed = new EmbedBuilder()
        .setTitle(`${riotName}#${riotTag}`)
        .setColor(tierChanged ? (tierDirection === 'up' ? TIER_COLORS.up : TIER_COLORS.down) : TIER_COLORS.default)
        .setTimestamp();

    if (mmr?.tierImage) {
        embed.setThumbnail(mmr.tierImage);
    }

    if (match) {
        const resultEmoji = match.result === 'Victory' ? '🏆' : match.result === 'Defeat' ? '💀' : '❔';
        embed.addFields({
            name: `${resultEmoji} ${match.result} — ${match.map}`,
            value: `Mode: ${match.mode}${match.kills !== null ? `\nKDA: ${match.kills}/${match.deaths}/${match.assists}` : ''}`,
            inline: false,
        });
    }

    if (mmr) {
        const deltaText = mmr.lastGameDelta > 0
            ? `+${mmr.lastGameDelta} RR`
            : mmr.lastGameDelta < 0
                ? `${mmr.lastGameDelta} RR`
                : '±0 RR';

        embed.addFields({
            name: '🎯 Current Rank',
            value: `${mmr.tierName} — ${mmr.rr} RR (${deltaText} last game)`,
            inline: false,
        });
    }

    if (tierChanged) {
        embed.addFields({
            name: tierDirection === 'up' ? '📈 Rank Up!' : '📉 Rank Down',
            value: tierDirection === 'up' ? 'Congratulations on the promotion!' : 'Tough one — climb back up!',
            inline: false,
        });
    }

    if (roleResult) {
        embed.addFields({
            name: '🏷️ Role',
            value: roleResult.success
                ? `Updated to **${roleResult.roleName}**`
                : `⚠️ Could not update role: ${roleResult.reason}`,
            inline: false,
        });
    }

    return embed;
}

// ─── Sweep (called by cron) ─────────────────────────────────────────────────

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function checkAllTrackedAccounts(client) {
    const summary = { checked: 0, updated: 0, rolesAssigned: 0, errors: 0 };

    for (const [guildId] of client.guilds.cache) {
        let accounts;
        try {
            accounts = await getTrackedAccounts(client, guildId);
        } catch (error) {
            logger.warn(`Failed to load tracked Valorant accounts for guild ${guildId}:`, error.message);
            continue;
        }
        if (!accounts.length) continue;

        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;

        const channelId = await getLogChannel(client, guildId).catch(() => null);
        const channel = channelId ? guild.channels.cache.get(channelId) : null;

        for (const account of accounts) {
            summary.checked += 1;
            try {
                const [mmr, match] = await Promise.all([
                    fetchCurrentMMR(account.riotName, account.riotTag, account.region),
                    fetchLatestMatch(account.riotName, account.riotTag, account.region, account.puuid),
                ]);

                if (!mmr) {
                    await delay(CHECK_DELAY_MS);
                    continue;
                }

                const isFirstCheck = account.lastTierId === null && account.lastMatchId === null;
                const tierChanged = !isFirstCheck && account.lastTierId !== null && mmr.tierId !== account.lastTierId;
                const newMatch = match && match.matchId && match.matchId !== account.lastMatchId;

                // Auto rank-role assignment (runs on every check, not just on change,
                // so a member who left/rejoined or had roles manually removed self-heals)
                let roleResult = null;
                if (account.autoRole && account.linkedDiscordId) {
                    const member = await guild.members.fetch(account.linkedDiscordId).catch(() => null);
                    if (member) {
                        roleResult = await assignRankRole(guild, member, mmr.tierName);
                        if (roleResult.success) summary.rolesAssigned += 1;
                    }
                }

                // Only post a channel update once we have a baseline (skip the very
                // first check to avoid a spam of "updates" the moment an account is tracked).
                if (!isFirstCheck && (tierChanged || newMatch) && channel) {
                    const embed = buildUpdateEmbed({
                        riotName: account.riotName,
                        riotTag: account.riotTag,
                        mmr,
                        match: newMatch ? match : null,
                        tierChanged,
                        tierDirection: tierChanged
                            ? (mmr.tierId > account.lastTierId ? 'up' : 'down')
                            : null,
                        roleResult: (tierChanged && account.autoRole) ? roleResult : null,
                    });
                    await channel.send({ embeds: [embed] }).catch(err => {
                        logger.warn(`Failed to send Valorant update for ${account.riotName}#${account.riotTag}:`, err.message);
                    });
                    summary.updated += 1;
                }

                const key = `valorant_tracked:${guildId}:${riotKey(account.riotName, account.riotTag)}`;
                await client.db.set(key, {
                    ...account,
                    lastTierId: mmr.tierId,
                    lastTierName: mmr.tierName,
                    lastRR: mmr.rr,
                    lastMatchId: match?.matchId ?? account.lastMatchId,
                    lastRoleAssigned: roleResult?.success ? roleResult.roleName : account.lastRoleAssigned,
                });
            } catch (error) {
                summary.errors += 1;
                logger.warn(`Error checking Valorant account ${account.riotName}#${account.riotTag} in guild ${guildId}:`, error.message);
            }

            await delay(CHECK_DELAY_MS);
        }
    }

    if (summary.checked > 0) {
        logger.debug(
            `Valorant sweep complete: checked ${summary.checked}, posted ${summary.updated} update(s), assigned ${summary.rolesAssigned} role(s), ${summary.errors} error(s)`
        );
    }

    return summary;
}

export const VALORANT_REGIONS = VALID_REGIONS;
export const VALORANT_RANK_ROLE_NAMES = ALL_RANK_ROLE_NAMES;
