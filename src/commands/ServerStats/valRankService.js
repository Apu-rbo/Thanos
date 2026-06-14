import { logger } from '../utils/logger.js';

// In-memory store: guildId -> { discordId -> { username, tag, region, lastUpdated } }
// In production this persists via your PostgreSQL through the database utility
const linkedAccounts = new Map();

// Rank tier to role name mapping
const RANK_TO_ROLE = {
    'iron':       'Iron',
    'bronze':     'Bronze',
    'silver':     'Silver',
    'gold':       'Gold',
    'platinum':   'Platinum',
    'diamond':    'Diamond',
    'ascendant':  'Ascendant',
    'immortal':   'Immortal',
    'radiant':    'Radiant',
    'unranked':   'Unranked',
};

const ALL_RANK_ROLES = Object.values(RANK_TO_ROLE);

// ── Helpers ──────────────────────────────────────────────────────────────────

function getGuildAccounts(guildId) {
    if (!linkedAccounts.has(guildId)) linkedAccounts.set(guildId, new Map());
    return linkedAccounts.get(guildId);
}

async function fetchRank(username, tag, region, apiKey) {
    const res = await fetch(
        `https://api.henrikdev.xyz/valorant/v2/mmr/${region}/${encodeURIComponent(username)}/${encodeURIComponent(tag)}`,
        { headers: { Authorization: apiKey } }
    );
    const data = await res.json();
    if (data.status !== 200) return null;

    const current = data.data?.current_data;
    const tier    = current?.currenttierpatched ?? 'Unranked';
    const rr      = current?.ranking_in_tier ?? 0;
    return { tier, rr };
}

function getTierKey(tier) {
    if (!tier) return 'unranked';
    return tier.split(' ')[0].toLowerCase(); // "Gold 2" -> "gold"
}

// ── Core Functions ────────────────────────────────────────────────────────────

export function linkAccount(guildId, discordId, username, tag, region) {
    const accounts = getGuildAccounts(guildId);
    accounts.set(discordId, {
        username,
        tag,
        region,
        lastUpdated: null,
        lastRank: null,
    });
    logger.info(`[ValRank] Linked ${discordId} -> ${username}#${tag} (${region}) in guild ${guildId}`);
}

export function unlinkAccount(guildId, discordId) {
    const accounts = getGuildAccounts(guildId);
    const had = accounts.has(discordId);
    accounts.delete(discordId);
    return had;
}

export function getLinkedAccount(guildId, discordId) {
    return getGuildAccounts(guildId).get(discordId) ?? null;
}

export function getAllLinked(guildId) {
    return [...getGuildAccounts(guildId).entries()];
}

// ── Role Assignment ───────────────────────────────────────────────────────────

export async function assignRankRole(guild, member, rankTier) {
    try {
        const tierKey  = getTierKey(rankTier);
        const roleName = RANK_TO_ROLE[tierKey] ?? 'Unranked';

        // Find target role
        const targetRole = guild.roles.cache.find(
            r => r.name.toLowerCase() === roleName.toLowerCase()
        );

        if (!targetRole) {
            logger.warn(`[ValRank] Role "${roleName}" not found in guild ${guild.id}. Create it first!`);
            return { success: false, reason: `Role "${roleName}" not found in server.` };
        }

        // Remove all other rank roles
        const toRemove = member.roles.cache.filter(r =>
            ALL_RANK_ROLES.some(rr => rr.toLowerCase() === r.name.toLowerCase()) &&
            r.id !== targetRole.id
        );

        if (toRemove.size > 0) {
            await member.roles.remove(toRemove, '[ValRank] Rank role update');
        }

        // Add new rank role if not already assigned
        if (!member.roles.cache.has(targetRole.id)) {
            await member.roles.add(targetRole, '[ValRank] Rank role update');
        }

        return { success: true, roleName, roleId: targetRole.id };
    } catch (err) {
        logger.error(`[ValRank] Failed to assign role to ${member.id}:`, err);
        return { success: false, reason: err.message };
    }
}

// ── Update Single User ────────────────────────────────────────────────────────

export async function updateUserRank(client, guild, discordId, apiKey) {
    const accounts = getGuildAccounts(guild.id);
    const account  = accounts.get(discordId);
    if (!account) return { success: false, reason: 'Account not linked.' };

    const { username, tag, region } = account;

    try {
        const rankData = await fetchRank(username, tag, region, apiKey);
        if (!rankData) {
            return { success: false, reason: `Could not fetch rank for ${username}#${tag}.` };
        }

        const member = await guild.members.fetch(discordId).catch(() => null);
        if (!member) {
            accounts.delete(discordId);
            return { success: false, reason: 'Member not found in server (may have left).' };
        }

        const result = await assignRankRole(guild, member, rankData.tier);

        // Update cache
        account.lastUpdated = Date.now();
        account.lastRank    = rankData.tier;
        accounts.set(discordId, account);

        return { success: true, rank: rankData.tier, rr: rankData.rr, ...result };
    } catch (err) {
        logger.error(`[ValRank] updateUserRank error for ${discordId}:`, err);
        return { success: false, reason: err.message };
    }
}

// ── Auto-Update All (runs on cron) ───────────────────────────────────────────

export async function autoUpdateAllRanks(client, apiKey) {
    logger.info('[ValRank] Starting auto rank update...');
    let updated = 0, failed = 0;

    for (const [guildId, accounts] of linkedAccounts.entries()) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;

        for (const [discordId] of accounts.entries()) {
            const result = await updateUserRank(client, guild, discordId, apiKey);
            if (result.success) updated++;
            else failed++;

            // Small delay to avoid rate limiting Henrik API
            await new Promise(r => setTimeout(r, 1200));
        }
    }

    logger.info(`[ValRank] Auto update complete: ${updated} updated, ${failed} failed`);
    return { updated, failed };
}
